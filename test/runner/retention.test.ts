/**
 * Retention, eviction and tombstones (#3), against a real filesystem with an
 * injectable clock.
 *
 * Byte accounting is exercised with **sparse files**: `ftruncate` gives a file
 * a five-gigabyte apparent size while allocating nothing, so the real
 * accounting path runs against the real filesystem without asking a laptop for
 * twenty gigabytes of disk. ADR 0002 chose this over a size-injection seam for
 * exactly that reason — the seam would have proved the seam works.
 */

import { describe, expect, test } from "bun:test"
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createRunDirectory } from "../../src/runner/paths.ts"
import {
  collectRuns,
  directorySize,
  evictRun,
  planEviction,
  readTombstone,
  reconcileTrash,
  RETENTION,
  runRetention,
  sweepTombstones,
  tombstonePath,
} from "../../src/runner/retention.ts"
import { seedRun, withSandbox, type Sandbox } from "./harness.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-09-13T12:00:00.000Z")

function completedRun(
  box: Sandbox,
  runId: string,
  options: { completedDaysAgo?: number; bytes?: number; quarantined?: boolean; state?: "completed" | "launchAuthorized" } = {},
): void {
  createRunDirectory(box.storage, runId)
  seedRun(box.storage, {
    runId,
    state: options.state ?? "completed",
    ...(options.state === "launchAuthorized"
      ? {}
      : { completedAt: new Date(NOW - (options.completedDaysAgo ?? 0) * DAY_MS).toISOString() }),
    ...(options.quarantined === true ? { quarantined: true } : {}),
  })
  if (options.bytes !== undefined) sparseFile(join(box.storage.runsDir, runId, "result.xcresult"), options.bytes)
}

/** A file with a large apparent size and no allocated blocks. */
function sparseFile(path: string, bytes: number): void {
  const fd = openSync(path, "w", 0o600)
  try {
    ftruncateSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

function retain(box: Sandbox, options: { userWideBytes?: number; leased?: Set<string>; activeRunId?: string } = {}) {
  return runRetention({
    storage: box.storage,
    now: () => NOW,
    ...(options.userWideBytes === undefined ? {} : { userWideBytes: options.userWideBytes }),
    ...(options.leased === undefined ? {} : { leased: options.leased }),
    ...(options.activeRunId === undefined ? {} : { activeRunId: options.activeRunId }),
  })
}

describe("the count limit", () => {
  test("keeps the newest twenty completed runs and evicts the rest, oldest first", async () => {
    await withSandbox((box) => {
      // All well within the age limit, so only the count rule can bite.
      for (let index = 0; index < 25; index += 1) {
        completedRun(box, `run-${String(index).padStart(2, "0")}`, {
          completedDaysAgo: (25 - index) / 24,
        })
      }

      const report = retain(box)
      expect(report.evicted).toHaveLength(5)
      expect(report.evicted).toEqual(["run-00", "run-01", "run-02", "run-03", "run-04"])
      for (const runId of report.evicted) expect(report.reasons[runId]).toBe("count")
      expect(readdirSync(box.storage.runsDir)).toHaveLength(RETENTION.maxCompletedRuns)
    })
  }, 30_000)
})

describe("the age limit", () => {
  test("evicts a run past seven days even when it is the newest and only one", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-ancient", { completedDaysAgo: 8, bytes: 10 })

      const report = retain(box)
      expect(report.evicted).toEqual(["run-ancient"])
      expect(report.reasons["run-ancient"]).toBe("age")
    })
  })

  test("evicts a run past seven days even when it alone exceeds the byte target", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-huge", { completedDaysAgo: 9, bytes: RETENTION.perRootByteTarget * 2 })
      expect(retain(box).reasons["run-huge"]).toBe("age")
    })
  })

  test("keeps a run that is still within seven days", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-recent", { completedDaysAgo: 6 })
      expect(retain(box).evicted).toEqual([])
    })
  })
})

describe("the per-root byte target", () => {
  test("evicts oldest-first until the root is back under target", async () => {
    await withSandbox((box) => {
      const twoGiB = 2 * 1024 ** 3
      completedRun(box, "run-a", { completedDaysAgo: 3, bytes: twoGiB })
      completedRun(box, "run-b", { completedDaysAgo: 2, bytes: twoGiB })
      completedRun(box, "run-c", { completedDaysAgo: 1, bytes: twoGiB })

      const report = retain(box)
      expect(report.evicted).toEqual(["run-a"])
      expect(report.reasons["run-a"]).toBe("perRootBytes")
    })
  })

  test("protects the newest completed run even when it alone exceeds the target", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-only", { completedDaysAgo: 1, bytes: RETENTION.perRootByteTarget * 2 })
      expect(retain(box).evicted).toEqual([])
    })
  })

  test("accounts for apparent size, which is what makes sparse files usable here", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-sparse", { completedDaysAgo: 1, bytes: 5 * 1024 ** 3 })
      expect(directorySize(join(box.storage.runsDir, "run-sparse"))).toBeGreaterThanOrEqual(5 * 1024 ** 3)
    })
  })
})

describe("the user-wide byte target", () => {
  test("evicts beyond the per-root target when the user total is over", async () => {
    await withSandbox((box) => {
      const oneGiB = 1024 ** 3
      completedRun(box, "run-a", { completedDaysAgo: 3, bytes: oneGiB })
      completedRun(box, "run-b", { completedDaysAgo: 2, bytes: oneGiB })
      completedRun(box, "run-c", { completedDaysAgo: 1, bytes: oneGiB })

      const report = retain(box, { userWideBytes: RETENTION.userWideByteTarget + 2 * oneGiB })
      expect(report.evicted).toEqual(["run-a", "run-b"])
      expect(report.reasons["run-a"]).toBe("userWideBytes")
    })
  })

  test("still protects the newest completed run", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-only", { completedDaysAgo: 1, bytes: 1024 ** 3 })
      const report = retain(box, { userWideBytes: RETENTION.userWideByteTarget * 4 })
      expect(report.evicted).toEqual([])
    })
  })
})

describe("runs that are never evictable", () => {
  test("include unfinished runs", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-live", { state: "launchAuthorized" })
      expect(collectRuns({ storage: box.storage, now: () => NOW })[0]?.evictable).toBe(false)
      expect(retain(box).evicted).toEqual([])
    })
  })

  test("include quarantined runs", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-q", { completedDaysAgo: 30, quarantined: true })
      expect(retain(box).evicted).toEqual([])
    })
  })

  test("include a run held by an inspection read lease", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-leased", { completedDaysAgo: 30 })
      expect(retain(box, { leased: new Set(["run-leased"]) }).evicted).toEqual([])
    })
  })

  test("include the run holding the execution slot", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-active", { completedDaysAgo: 30 })
      expect(retain(box, { activeRunId: "run-active" }).evicted).toEqual([])
    })
  })
})

describe("eviction", () => {
  test("publishes a tombstone and then deletes, so the run reads as expired", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-gone", { completedDaysAgo: 9 })
      retain(box)

      expect(existsSync(join(box.storage.runsDir, "run-gone"))).toBe(false)
      expect(readTombstone(box.storage, "run-gone")).toMatchObject({
        schemaVersion: 1,
        runId: "run-gone",
      })
    })
  })

  test("writes a tombstone carrying nothing but its version, id and expiry", async () => {
    await withSandbox((box) => {
      evictRun(box.storage, "run-x", NOW)
      const tombstone = readTombstone(box.storage, "run-x")
      expect(Object.keys(tombstone ?? {}).sort()).toEqual(["expiresAtMs", "runId", "schemaVersion"])
      expect(tombstone?.expiresAtMs).toBe(NOW + RETENTION.tombstoneLifetimeMs)
    })
  })

  test("leaves nothing in trash once deletion succeeds", async () => {
    await withSandbox((box) => {
      completedRun(box, "run-gone", { completedDaysAgo: 9 })
      retain(box)
      expect(readdirSync(box.storage.trashDir)).toEqual([])
    })
  })
})

describe("trash left behind by a crash", () => {
  test("gets its missing tombstone published before deletion resumes", async () => {
    await withSandbox((box) => {
      // A run that was moved to trash but crashed before the tombstone landed.
      mkdirSync(join(box.storage.trashDir, "run-orphan"), { mode: 0o700 })
      writeFileSync(join(box.storage.trashDir, "run-orphan", "raw.log"), "x", { mode: 0o600 })

      const reconciled = reconcileTrash(box.storage, NOW)

      expect(reconciled).toEqual(["run-orphan"])
      expect(readTombstone(box.storage, "run-orphan")).toBeDefined()
      expect(existsSync(join(box.storage.trashDir, "run-orphan"))).toBe(false)
    })
  })

  test("is never mistaken for a run that was never known", async () => {
    await withSandbox((box) => {
      mkdirSync(join(box.storage.trashDir, "run-orphan"), { mode: 0o700 })
      retain(box)
      expect(readTombstone(box.storage, "run-orphan")).toBeDefined()
    })
  })
})

describe("tombstones", () => {
  test("expire after thirty days, oldest first", async () => {
    await withSandbox((box) => {
      evictRun(box.storage, "run-old", NOW - 31 * DAY_MS)
      evictRun(box.storage, "run-new", NOW)

      const removed = sweepTombstones(box.storage, NOW)
      expect(removed).toEqual(["run-old"])
      expect(readTombstone(box.storage, "run-new")).toBeDefined()
    })
  })

  test("are capped per trusted root, dropping the oldest beyond the cap", async () => {
    await withSandbox((box) => {
      // Written directly: ten thousand fsynced writes would prove nothing extra.
      for (let index = 0; index <= RETENTION.maxTombstones; index += 1) {
        const runId = `run-${String(index).padStart(6, "0")}`
        writeFileSync(
          tombstonePath(box.storage, runId),
          JSON.stringify({
            schemaVersion: 1,
            runId,
            expiresAtMs: NOW + RETENTION.tombstoneLifetimeMs + index,
          }),
          { mode: 0o600 },
        )
      }

      const removed = sweepTombstones(box.storage, NOW)
      expect(removed).toEqual(["run-000000"])
      expect(readdirSync(box.storage.tombstonesDir)).toHaveLength(RETENTION.maxTombstones)
    })
  }, 60_000)

  test("a lookup after the tombstone is gone can only be notFound", async () => {
    await withSandbox((box) => {
      evictRun(box.storage, "run-x", NOW - 31 * DAY_MS)
      sweepTombstones(box.storage, NOW)
      expect(readTombstone(box.storage, "run-x")).toBeUndefined()
    })
  })
})

describe("the limits themselves", () => {
  test("are the ones the contract fixed", () => {
    expect(RETENTION).toMatchObject({
      maxCompletedRuns: 20,
      maxAgeMs: 7 * DAY_MS,
      perRootByteTarget: 5 * 1024 ** 3,
      userWideByteTarget: 20 * 1024 ** 3,
      tombstoneLifetimeMs: 30 * DAY_MS,
      maxTombstones: 10_000,
    })
  })

  test("treat byte targets as soft and age as hard", () => {
    const runs = [
      { runId: "a", completedAtMs: NOW - 8 * DAY_MS, bytes: 1, evictable: true },
      { runId: "b", completedAtMs: NOW - DAY_MS, bytes: RETENTION.perRootByteTarget * 2, evictable: true },
    ]
    const plan = planEviction(runs, { now: () => NOW })
    expect(plan.reasons["a"]).toBe("age")
    expect(plan.reasons["b"]).toBeUndefined()
  })
})

describe("the lifecycle boundary", () => {
  test("holds back a run whose isolated DerivedData has not been reclaimed", async () => {
    // Retention eligibility begins only after cleanup: evicting first would
    // delete the record and orphan the scratch directory it named.
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-dd")
      seedRun(box.storage, {
        runId: "run-dd",
        state: "completed",
        completedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        derivedDataMode: "isolated",
      })
      expect(retain(box).evicted).toEqual([])
    })
  })

  test("releases it once cleanup is recorded", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-dd")
      seedRun(box.storage, {
        runId: "run-dd",
        state: "completed",
        completedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        derivedDataMode: "isolated",
        derivedDataCleaned: true,
      })
      expect(retain(box).evicted).toEqual(["run-dd"])
    })
  })

  test("never holds back a shared-DerivedData run, which owns no scratch of its own", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-shared")
      seedRun(box.storage, {
        runId: "run-shared",
        state: "completed",
        completedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        derivedDataMode: "shared",
      })
      expect(retain(box).evicted).toEqual(["run-shared"])
    })
  })
})
