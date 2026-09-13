/**
 * Finishing a crashed Test Run (issue #21).
 *
 * Recovery decides which runs are finishable and holds their slots; this side
 * of the seam publishes the terminal summary and index a normal completed run
 * would publish, and only then releases. The two halves are split because the
 * runner may not import the interpreter — so this is where they meet.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { XcresultCommand } from "../../src/interpreter/anomalies.ts"
import type { XcresultTool } from "../../src/interpreter/ports.ts"
import { finalizeRecovered, reconcile, SUMMARY_ARTIFACT } from "../../src/adapter/service.ts"
import type { ServiceEnvironment } from "../../src/adapter/service.ts"
import { createRunDirectory, runDirectory } from "../../src/runner/paths.ts"
import { readQueue, writeQueue } from "../../src/runner/queue.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { identityFor, loadFixture, RESOLVED } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"

const TIMESTAMP = "2026-09-13T12:00:00.000Z"

/** A reader over a committed fixture, so recovery is exercised without Xcode. */
function fixtureReader(name: string): XcresultTool {
  const fixture = loadFixture(name)
  return {
    identity: identityFor(fixture),
    async run(command: XcresultCommand) {
      if (!(command in fixture.payloads)) {
        return { ok: false as const, failure: "commandFailed" as const, message: "no payload" }
      }
      return { ok: true as const, payload: fixture.payloads[command] }
    },
  }
}

function environmentFor(box: Sandbox, fixture = "passed"): ServiceEnvironment {
  return {
    storage: box.storage,
    trustedRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture(fixture)),
    runtimePath: "/opt/bun",
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    now: () => 0,
    timestamp: () => TIMESTAMP,
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 3),
    xcresultToolFor: () => fixtureReader(fixture),
  }
}

function seedCrashedRun(box: Sandbox, runId: string, fields: Record<string, unknown> = {}) {
  createRunDirectory(box.storage, runId)
  // A crashed run leaves its Result Bundle behind; that is what makes it
  // interpretable at all rather than merely finishable.
  mkdirSync(join(runDirectory(box.storage, runId), "result.xcresult"), { recursive: true })
  seedRun(box.storage, {
    runId,
    state: "executionCompleted",
    supervisor: { pid: 100, startedAt: "s" },
    child: { pid: 200, startedAt: "c", pgid: 200 },
    resolved: RESOLVED,
    requestedScope: { kind: "all" },
    execObserved: "yes",
    exitCode: 0,
    descendantsConfirmedExited: "yes",
    ...fields,
  })
  writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: runId })
}

describe("a run whose process is gone and whose summary was never published", () => {
  test("is interpreted from its immutable artifacts, not rerun", async () => {
    await withSandbox(async (box) => {
      seedCrashedRun(box, "run-crashed")
      await finalizeRecovered(environmentFor(box), "run-crashed")

      const summary = JSON.parse(
        readFileSync(join(runDirectory(box.storage, "run-crashed"), SUMMARY_ARTIFACT), "utf8"),
      ) as { outcome: string; runId: string }

      expect(summary.outcome).toBe("passed")
      expect(summary.runId).toBe("run-crashed")
    })
  })

  test("publishes the same index ordinary inspection reads", async () => {
    await withSandbox(async (box) => {
      seedCrashedRun(box, "run-crashed")
      await finalizeRecovered(environmentFor(box), "run-crashed")

      const index = JSON.parse(
        readFileSync(join(runDirectory(box.storage, "run-crashed"), "index.json"), "utf8"),
      ) as { runId: string; occurrences: unknown[] }

      expect(index.runId).toBe("run-crashed")
      expect(index.occurrences).toHaveLength(2)
    })
  })

  test("keeps its original run id, so it stays inspectable under the same handle", async () => {
    await withSandbox(async (box) => {
      seedCrashedRun(box, "run-crashed")
      await finalizeRecovered(environmentFor(box), "run-crashed")
      expect(readRunRecord(box.storage, "run-crashed")?.runId).toBe("run-crashed")
    })
  })

  test("publishes before it completes, and completes before it releases", async () => {
    await withSandbox(async (box) => {
      seedCrashedRun(box, "run-crashed")
      await finalizeRecovered(environmentFor(box), "run-crashed")

      expect(readRunRecord(box.storage, "run-crashed")?.state).toBe("completed")
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })

  test("reclaims its isolated DerivedData once it is durably finished", async () => {
    await withSandbox(async (box) => {
      seedCrashedRun(box, "run-crashed", { derivedDataMode: "isolated" })
      await finalizeRecovered(environmentFor(box), "run-crashed")

      expect(existsSync(join(runDirectory(box.storage, "run-crashed"), "DerivedData"))).toBe(false)
      expect(readRunRecord(box.storage, "run-crashed")?.derivedDataCleaned).toBe(true)
    })
  })
})

describe("a run that never recorded what it was asked to do", () => {
  test("is finished without a fabricated summary, and gives the slot back", async () => {
    // No honest summary can be written for a run nothing describes. Inventing
    // one would be worse than saying nothing: it would look authoritative.
    await withSandbox(async (box) => {
      createRunDirectory(box.storage, "run-bare")
      seedRun(box.storage, { runId: "run-bare", state: "admitted" })
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-bare" })

      await finalizeRecovered(environmentFor(box), "run-bare")

      expect(readRunRecord(box.storage, "run-bare")?.state).toBe("completed")
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
      expect(existsSync(join(runDirectory(box.storage, "run-bare"), SUMMARY_ARTIFACT))).toBe(false)

      // An index is still published, so inspection can say "nothing retained"
      // rather than "this run was never known".
      const index = JSON.parse(
        readFileSync(join(runDirectory(box.storage, "run-bare"), "index.json"), "utf8"),
      ) as { runId: string; occurrences: unknown[]; tests: { completeness: string } }
      expect(index.runId).toBe("run-bare")
      expect(index.occurrences).toEqual([])
      expect(index.tests.completeness).toBe("unavailable")
    })
  })
})

describe("reconcile", () => {
  test("finishes everything recovery handed back, in one pass", async () => {
    await withSandbox(async (box) => {
      seedCrashedRun(box, "run-crashed")
      const report = await reconcile(environmentFor(box))

      expect(report.needsFinalization).toEqual(["run-crashed"])
      expect(readRunRecord(box.storage, "run-crashed")?.state).toBe("completed")
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })

  test("leaves a healthy root alone", async () => {
    await withSandbox(async (box) => {
      const report = await reconcile(environmentFor(box))
      expect(report).toMatchObject({ status: "alreadyHealthy", needsFinalization: [] })
    })
  })
})
