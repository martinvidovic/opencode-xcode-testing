/**
 * Reclaiming isolated DerivedData without stalling the host (issue #161).
 *
 * An isolated build cache is around ten gigabytes and hundreds of thousands of
 * files. Deleting it synchronously held the host's event loop for longer than
 * the OpenCode CLI waits before declaring the service unresponsive and
 * restarting it — which took completed results down with it. These tests are
 * about the deletion itself: that the host keeps answering while it happens,
 * that it only ever touches a durably completed run, and that a failure is
 * recorded rather than thrown at a caller who already has its result.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createRunDirectory, RUN_ARTIFACTS, runDirectory, type Storage } from "../../src/runner/paths.ts"
import {
  reclaimIsolatedDerivedData,
  type ReclamationEnvironment,
  type TreeRemover,
} from "../../src/runner/reclamation.ts"
import { readRunRecord, type RunRecord } from "../../src/runner/state.ts"
import { refusing, seedRun, sleep, withSandbox } from "./harness.ts"

const TIMESTAMP = "2026-10-11T12:00:00.000Z"

/**
 * Enough files that deleting them synchronously takes around a second here —
 * several times the lag bound below — so a synchronous remover fails this
 * file rather than slipping under the threshold.
 */
const FILES = 30_000
const FILES_PER_DIRECTORY = 200
const LAG_BOUND_MS = 250

function seedDerivedData(storage: Storage, runId: string, files: number): string {
  createRunDirectory(storage, runId)
  const derived = join(runDirectory(storage, runId), RUN_ARTIFACTS.derivedData)
  for (let directory = 0; directory < files / FILES_PER_DIRECTORY; directory += 1) {
    const leaf = join(derived, "Build", `Module${directory % 40}`, `Objects${directory}`)
    mkdirSync(leaf, { recursive: true })
    for (let file = 0; file < FILES_PER_DIRECTORY; file += 1) writeFileSync(join(leaf, `${file}.o`), "o")
  }
  return derived
}

function environmentFor(storage: Storage, removeDerivedData?: TreeRemover): ReclamationEnvironment {
  return {
    storage,
    timestamp: () => TIMESTAMP,
    ...(removeDerivedData === undefined ? {} : { removeDerivedData }),
  }
}

function seedCompleted(storage: Storage, runId: string, fields: Partial<RunRecord> = {}): RunRecord {
  return seedRun(storage, {
    runId,
    state: "completed",
    completedAt: TIMESTAMP,
    derivedDataMode: "isolated",
    ...fields,
  })
}

/**
 * The worst gap between ticks of a 10 ms timer while `work` runs.
 *
 * The timer is given a tick on either side of the work. Without the one after,
 * work that blocks synchronously is cleared away before the late tick that
 * would have measured it ever fires, and the probe reports no lag at all.
 */
async function worstTimerLag(work: () => Promise<unknown>): Promise<number> {
  let worst = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 10)
    last = now
  }, 10)
  try {
    await sleep(30)
    await work()
    await sleep(30)
  } finally {
    clearInterval(timer)
  }
  return worst
}

describe("reclaiming a large isolated DerivedData tree", () => {
  test("keeps the host's event loop answering while it deletes", async () => {
    await withSandbox(async (box) => {
      const derived = seedDerivedData(box.storage, "run-large", FILES)
      seedCompleted(box.storage, "run-large")

      const lag = await worstTimerLag(() =>
        reclaimIsolatedDerivedData(environmentFor(box.storage), "run-large"),
      )

      expect(existsSync(derived)).toBe(false)
      expect(lag).toBeLessThan(LAG_BOUND_MS)
    })
  }, 60_000)
})

describe("what reclamation is allowed to touch", () => {
  test("never a run that is not durably completed", async () => {
    await withSandbox(async (box) => {
      const derived = seedDerivedData(box.storage, "run-live", FILES_PER_DIRECTORY)
      seedRun(box.storage, {
        runId: "run-live",
        state: "launchAuthorized",
        derivedDataMode: "isolated",
      })

      await reclaimIsolatedDerivedData(environmentFor(box.storage), "run-live")

      expect(existsSync(derived)).toBe(true)
      expect(readRunRecord(box.storage, "run-live")?.derivedDataCleaned).toBeUndefined()
    })
  })

  test("never a run that built into the shared cache", async () => {
    await withSandbox(async (box) => {
      const derived = seedDerivedData(box.storage, "run-shared", FILES_PER_DIRECTORY)
      seedCompleted(box.storage, "run-shared", { derivedDataMode: "shared" })

      await reclaimIsolatedDerivedData(environmentFor(box.storage), "run-shared")

      expect(existsSync(derived)).toBe(true)
      expect(readRunRecord(box.storage, "run-shared")?.derivedDataCleaned).toBeUndefined()
    })
  })
})

describe("a reclamation that fails", () => {
  test("is recorded on the run rather than thrown, and leaves it retained", async () => {
    await withSandbox(async (box) => {
      seedDerivedData(box.storage, "run-refused", FILES_PER_DIRECTORY)
      seedCompleted(box.storage, "run-refused")

      await reclaimIsolatedDerivedData(
        environmentFor(box.storage, refusing("EACCES")),
        "run-refused",
      )

      const record = readRunRecord(box.storage, "run-refused")
      expect(record?.state).toBe("completed")
      // Retention evicts a run only once this is set, so a failure keeps the
      // run — and its leftover bytes — visible to the next attempt.
      expect(record?.derivedDataCleaned).toBeUndefined()
      // The error code, never the message: the message names a machine path.
      expect(record?.derivedDataReclamationFailure).toEqual({ at: TIMESTAMP, code: "EACCES" })
    })
  })

  test("is cleared by a later attempt that succeeds", async () => {
    await withSandbox(async (box) => {
      const derived = seedDerivedData(box.storage, "run-retried", FILES_PER_DIRECTORY)
      seedCompleted(box.storage, "run-retried")
      await reclaimIsolatedDerivedData(environmentFor(box.storage, refusing("EBUSY")), "run-retried")
      await reclaimIsolatedDerivedData(environmentFor(box.storage), "run-retried")

      const record = readRunRecord(box.storage, "run-retried")
      expect(existsSync(derived)).toBe(false)
      expect(record?.derivedDataCleaned).toBe(true)
      expect(record?.derivedDataReclamationFailure).toBeUndefined()
    })
  })
})
