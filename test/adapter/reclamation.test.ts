/**
 * A completed Test Run's result does not wait for its cache to go (issue #161).
 *
 * Isolated DerivedData used to be deleted synchronously between publishing the
 * terminal summary and returning it. For a ten-gigabyte cache that held the
 * host long enough for the OpenCode CLI to restart it, and the restart lost
 * results whose runs had completed. What these tests pin down is the order a
 * caller sees: the result and its run id first, reclamation afterwards and on
 * its own account — slow, failed, or retried later.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, reconcile, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"
import { RUN_ARTIFACTS, runDirectory } from "../../src/runner/paths.ts"
import { reclamationsSettled } from "../../src/runner/reclamation.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { withSandbox, type Sandbox } from "../runner/harness.ts"

const STUB_SUPERVISOR = join(import.meta.dir, "..", "runner", "stub", "stub-supervisor.ts")

function environmentFor(box: Sandbox, overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment {
  const root = join(box.homeDir, "project")
  mkdirSync(join(root, "App.xcodeproj"), { recursive: true })
  writeFileSync(join(root, ".stub-mode"), "ready-then-complete\n")
  return {
    storage: box.storage,
    containmentRoot: root,
    homeDir: box.homeDir,
    configuration: {
      status: "loaded",
      configuration: {
        schemaVersion: 1,
        xcodeContainer: { kind: "project", path: "App.xcodeproj" },
        scheme: "App",
        destination: { kind: "id", id: "SIMULATOR" },
        derivedData: { mode: "isolated" },
      },
    },
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: process.execPath },
    supervisorEntrypoint: STUB_SUPERVISOR,
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 7),
    ...overrides,
  }
}

/** A remover that does nothing until the test lets it, and counts its calls. */
function heldRemover() {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const paths: string[] = []
  return {
    paths,
    release,
    remove: async (path: string) => {
      paths.push(path)
      await released
    },
  }
}

async function runOnce(environment: ServiceEnvironment) {
  const result = await createTestToolService(environment).start(
    { requestedScope: { kind: "all" } },
    { onState: () => {} },
  ).result
  if (!isTestRunSummary(result)) throw new Error(`expected a Test Run: ${result.outcome}`)
  return result
}

describe("a completed run whose cache is slow to reclaim", () => {
  test("delivers its result and run id before reclamation finishes", async () => {
    await withSandbox(async (box) => {
      const remover = heldRemover()
      const environment = environmentFor(box, { removeDerivedData: remover.remove })

      const result = await runOnce(environment)

      // The result is here, and the deletion it used to wait for has started
      // and not finished.
      expect(remover.paths).toEqual([join(runDirectory(box.storage, result.runId), RUN_ARTIFACTS.derivedData)])
      const record = readRunRecord(box.storage, result.runId)
      expect(record?.state).toBe("completed")
      expect(record?.derivedDataCleaned).toBeUndefined()

      remover.release()
      await reclamationsSettled()
      expect(readRunRecord(box.storage, result.runId)?.derivedDataCleaned).toBe(true)
    })
  })

  test("leaves the service answering while it is still going", async () => {
    await withSandbox(async (box) => {
      const remover = heldRemover()
      const environment = environmentFor(box, { removeDerivedData: remover.remove })
      const result = await runOnce(environment)

      const response = await createTestToolService(environment).inspect({
        runId: result.runId,
        facet: "scope",
      })
      expect(response.status).not.toBe("notFound")

      remover.release()
      await reclamationsSettled()
    })
  })
})

describe("a completed run whose cache could not be reclaimed", () => {
  test("keeps the outcome it had, and records the failure on the run", async () => {
    await withSandbox(async (box) => {
      const reference = await runOnce(environmentFor(box))
      await reclamationsSettled()

      const result = await runOnce(
        environmentFor(box, {
          removeDerivedData: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
        }),
      )
      await reclamationsSettled()

      expect(result.outcome).toBe(reference.outcome)
      const record = readRunRecord(box.storage, result.runId)
      expect(record?.derivedDataCleaned).toBeUndefined()
      expect(record?.derivedDataReclamationFailure?.code).toBe("EACCES")
    })
  })

  test("is reclaimed by the next reconciliation", async () => {
    await withSandbox(async (box) => {
      const result = await runOnce(
        environmentFor(box, {
          removeDerivedData: () => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })),
        }),
      )
      await reclamationsSettled()
      const derived = join(runDirectory(box.storage, result.runId), RUN_ARTIFACTS.derivedData)
      expect(existsSync(derived)).toBe(true)

      await reconcile(environmentFor(box))
      await reclamationsSettled()

      expect(existsSync(derived)).toBe(false)
      expect(readRunRecord(box.storage, result.runId)?.derivedDataCleaned).toBe(true)
    })
  })
})

describe("explicit recovery after a failed reclamation", () => {
  test("says what is still held and why, and retries it", async () => {
    await withSandbox(async (box) => {
      const refusing = environmentFor(box, {
        removeDerivedData: () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
      })
      await runOnce(refusing)
      await reclamationsSettled()

      const outcome = await createTestToolService(refusing).recover()
      await reclamationsSettled()

      expect(outcome.message).toContain("isolated DerivedData")
      expect(outcome.message).toContain("EACCES")
      // The code is what is safe to show; the storage path is not.
      expect(outcome.message).not.toContain(box.homeDir)
    })
  })
})

describe("two reclamations of the same run in one process", () => {
  test("share one deletion rather than racing each other", async () => {
    await withSandbox(async (box) => {
      const remover = heldRemover()
      const environment = environmentFor(box, { removeDerivedData: remover.remove })
      const result = await runOnce(environment)

      // A reconciliation while the first deletion is still going — the next
      // Test Run's, or an explicit recovery — must not start a second one.
      await reconcile(environment)
      expect(remover.paths).toHaveLength(1)

      remover.release()
      await reclamationsSettled()
      expect(readRunRecord(box.storage, result.runId)?.derivedDataCleaned).toBe(true)
    })
  })
})
