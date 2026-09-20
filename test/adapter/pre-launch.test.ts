/**
 * Recovering a run that never reached launch authorization (#3, issue #35).
 *
 * A crash before the gated launch leaves a run that was admitted and never
 * started. There is nothing to interpret: no Result Bundle, no exit status, no
 * observed execution. The whole risk here is that recovery makes something up
 * to fill that gap — marching the record through the states it never reached,
 * and reading a bundle that was never written — because the resulting summary
 * looks exactly like a real one and is not.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  createTestToolService,
  finalizeRecovered,
  INDEX_ARTIFACT,
  SUMMARY_ARTIFACT,
  type ServiceEnvironment,
} from "../../src/adapter/service.ts"
import { isTestRunSummary, type TestToolResult } from "../../src/domain/result.ts"
import { createRunDirectory, RUN_ARTIFACTS, runDirectory } from "../../src/runner/paths.ts"
import { readQueue, writeQueue } from "../../src/runner/queue.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { identityFor, loadFixture, RESOLVED } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"
import { infrastructureReason, summaryOf as runSummary } from "./scenarios.ts"

const RUN = "run-pre-launch"

function environmentFor(box: Sandbox): ServiceEnvironment {
  return {
    storage: box.storage,
    containmentRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: "/opt/bun" },
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    now: () => 0,
    timestamp: () => "2026-09-14T09:00:00.000Z",
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 5),
    // Any read of a Result Bundle here is itself the defect, so the reader
    // refuses rather than returning something plausible.
    xcresultToolFor: () => {
      throw new Error("a pre-launch run has no Result Bundle to read")
    },
  }
}

/** An admitted run whose supervisor never published a handshake. */
function seedPreLaunch(box: Sandbox, overrides: Record<string, unknown> = {}) {
  createRunDirectory(box.storage, RUN)
  writeQueue(box.storage, {
    schemaVersion: 1,
    nextSequence: 2,
    tickets: [],
    activeRunId: RUN,
  })
  return seedRun(box.storage, {
    runId: RUN,
    state: "admitted",
    resolved: RESOLVED,
    requestedScope: { kind: "all" },
    ...overrides,
  })
}

function summaryOf(box: Sandbox): TestToolResult {
  return JSON.parse(readFileSync(join(runDirectory(box.storage, RUN), SUMMARY_ARTIFACT), "utf8"))
}

describe("a run that never reached launch authorization", () => {
  test("is published as a runner failure in the launching phase", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)

      const summary = summaryOf(box)
      if (!isTestRunSummary(summary)) throw new Error("expected a Test Run summary")

      expect(summary.outcome).toBe("infrastructureFailed")
      expect(infrastructureReason(summary)).toBe("runnerFailure")
      // Nothing ran, and the summary says so rather than leaving a reader to
      // infer it from a zero count that could equally mean "all passed".
      expect(runSummary(summary).execution.execObserved).toBe("no")
    })
  })

  test("never claims states the run did not reach", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)

      // `launchAuthorized` is the durable point at which Xcode was allowed to
      // start. Writing it for a run that never got there turns "we do not know
      // what happened" into "we know a test run happened", which is a lie a
      // later reader has no way to detect.
      const record = readRunRecord(box.storage, RUN)
      expect(record?.state).toBe("completed")
      expect(record?.startedAt).toBeUndefined()
      expect(record?.execObserved).not.toBe("yes")
    })
  })

  test("publishes an index that retains nothing, rather than none at all", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)

      // So a later inspection answers "nothing was retained" instead of
      // "this run was never known".
      const index = JSON.parse(
        readFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), "utf8"),
      )
      expect(index.occurrences).toEqual([])
      expect(index.tests.completeness).toBe("unavailable")
    })
  })

  test("gives the execution slot back", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)

      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })

  test("is answerable by the ordinary inspection path afterwards", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      const environment = environmentFor(box)
      await finalizeRecovered(environment, RUN)

      const response = await createTestToolService(environment).inspect({
        runId: RUN,
        facet: "failures",
      })
      // `unsupported` is the honest answer for a facet that was never
      // produced — not `notFound`, which would deny the run existed.
      expect(response.status).toBe("unsupported")
    })
  })

  test("does not invent a Result Bundle that was never written", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)

      expect(existsSync(join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.resultBundle))).toBe(false)
      const summary = summaryOf(box)
      if (!isTestRunSummary(summary)) throw new Error("expected a Test Run summary")
      expect(summary.tests.counts?.total ?? 0).toBe(0)
    })
  })

  test("still reports honestly when nothing describes what was asked for", async () => {
    await withSandbox(async (box) => {
      // No resolved contract on the record: recovery cannot say what this run
      // was meant to do, so it publishes an empty index and no summary rather
      // than a summary about a scope it guessed at.
      seedPreLaunch(box, { resolved: undefined, requestedScope: undefined })
      await finalizeRecovered(environmentFor(box), RUN)

      expect(existsSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT))).toBe(true)
      expect(existsSync(join(runDirectory(box.storage, RUN), SUMMARY_ARTIFACT))).toBe(false)
      expect(readRunRecord(box.storage, RUN)?.state).toBe("completed")
    })
  })

  test("covers every state before launch, not only the earliest", async () => {
    // `supervisorReady` and `childRecorded` are also before the gate. A run
    // that got that far still never became `xcodebuild`.
    for (const state of ["supervisorReady", "childRecorded"] as const) {
      await withSandbox(async (box) => {
        seedPreLaunch(box, {
          state,
          ...(state === "childRecorded"
            ? { child: { pid: 999_999, startedAt: "gone", pgid: 999_999 } }
            : {}),
        })
        await finalizeRecovered(environmentFor(box), RUN)

        const summary = summaryOf(box)
        if (!isTestRunSummary(summary)) throw new Error(`expected a summary for ${state}`)
        expect(summary.outcome).toBe("infrastructureFailed")
        expect(infrastructureReason(summary)).toBe("runnerFailure")
        expect(runSummary(summary).execution.execObserved).toBe("no")
      })
    }
  })

  test("says which of the two happened, rather than one sentence for both", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)
      const never = summaryOf(box) as { message?: string }

      await withSandbox(async (other) => {
        seedPreLaunch(other, {
          state: "childRecorded",
          child: { pid: 999_999, startedAt: "gone", pgid: 999_999 },
        })
        await finalizeRecovered(environmentFor(other), RUN)
        const gated = summaryOf(other) as { message?: string }

        // One never started a process; the other started one and never let it
        // become the tests. "No test process ran" is true of neither in the
        // way a reader needs.
        expect(never.message).not.toBe(gated.message)
      })
    })
  })

  test("measures from the admission it recorded, not from when recovery ran", async () => {
    await withSandbox(async (box) => {
      seedPreLaunch(box)
      await finalizeRecovered(environmentFor(box), RUN)

      const summary = summaryOf(box)
      if (!isTestRunSummary(summary)) throw new Error("expected a Test Run summary")
      // #7: the total measures admission through classification. Reporting
      // zero would claim a run that took no time at all.
      expect(summary.timing.totalDurationMs).toBeGreaterThan(0)
    })
  })
})
