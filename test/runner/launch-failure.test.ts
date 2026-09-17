/**
 * What supervision does with a launch that never happened (issue #117).
 *
 * The gate settling both of its observations is only half the property. The
 * half that matters to a caller is what supervision then does with them: it
 * has to reach a terminal answer, say that nothing executed, and let go of
 * the run — because until it does, the run's Execution Slot is held by a
 * process waiting on a child that does not exist.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { spawnGatedChild, type GatedChild } from "../../src/runner/gate.ts"
import { systemProbe } from "../../src/runner/identity.ts"
import { createRunDirectory, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import { superviseRun, type SupervisionResult } from "../../src/runner/supervisor.ts"
import { IMMEDIATE_ESCALATION, monotonic, seedRun, sleep, withSandbox, type Sandbox } from "./harness.ts"

/** Supervise a run whose gated child is spawned with `gate` overridden. */
async function superviseWith(
  box: Sandbox,
  runId: string,
  gate: { cwd?: string; logPath?: string },
): Promise<SupervisionResult> {
  createRunDirectory(box.storage, runId)
  const record = seedRun(box.storage, { runId, timeoutSeconds: 900 })

  return superviseRun(
    {
      storage: box.storage,
      probe: systemProbe,
      now: monotonic(),
      timestamp: () => new Date().toISOString(),
      sleep,
      escalation: IMMEDIATE_ESCALATION,
      startupDeadlineMs: 10_000,
      cancellation: { aborted: false, whenAborted: new Promise<void>(() => {}) },
      spawn: (): GatedChild =>
        spawnGatedChild({
          command: "/bin/echo",
          args: ["done"],
          cwd: gate.cwd ?? box.homeDir,
          environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          logPath: gate.logPath ?? join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog),
        }),
    },
    { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } },
  )
}

describe("a working directory that is not there", () => {
  test("ends the run instead of waiting for a child that was never created", async () => {
    // Before this, `recorded` and `exited` both stayed pending: no `exit`
    // follows a spawn that failed, because there was no process to exit. The
    // supervisor waited on both, for ever, holding the Execution Slot.
    await withSandbox(async (box) => {
      const result = await superviseWith(box, "run-no-cwd", { cwd: join(box.homeDir, "not-here") })

      expect(result.failure).toEqual({ reason: "runnerFailure", phase: "launching" })
    })
  }, 20_000)

  test("says nothing executed, and says it as knowledge rather than doubt", async () => {
    await withSandbox(async (box) => {
      const result = await superviseWith(box, "run-no-cwd", { cwd: join(box.homeDir, "not-here") })

      expect(result.execution).toEqual({ execObserved: "no", successfulExit: "no" })
    })
  }, 20_000)
})

describe("a raw log that cannot be opened for what it is", () => {
  test("is the same answer: refused, and terminal", async () => {
    // The refusal happens before any process exists, which is the one place
    // it can happen and still be a refusal rather than a cleanup.
    await withSandbox(async (box) => {
      const result = await superviseWith(box, "run-bad-log", { logPath: box.storage.runsDir })

      expect(result.failure).toEqual({ reason: "runnerFailure", phase: "launching" })
    })
  }, 20_000)
})
