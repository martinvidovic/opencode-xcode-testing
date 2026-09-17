/**
 * Supervision when the evidence of a child's exit never arrives (issue #114).
 *
 * Everything after escalation was written as though a child that has been
 * signalled eventually reports how it ended. It usually does. When it does
 * not — a direct child that outlives its escalation, a stub, a runtime that
 * loses the event — `await child.exited` is a wait with no bound, taken by
 * the one process that holds the run's deadline, its cancellation and its
 * only route to a terminal outcome. Nothing times it out, because it *is* the
 * timeout.
 *
 * What that costs is not an unfinished run. It is an Execution Slot held for
 * ever by a supervisor that will never return, on a root whose next run is
 * refused with a reason that describes a run nobody can see any more.
 *
 * So the property here is narrow and absolute: supervision returns. What it
 * returns then has to be honest about what it did not see — `unknown`, never
 * an invented exit code and never a successful exit — and it has to quarantine
 * the slot, because a lifecycle nobody confirmed is exactly what quarantine is
 * for.
 */

import { describe, expect, test } from "bun:test"

import type { EvidenceFact } from "../../src/domain/evidence.ts"
import type { ChildExit, ChildRecordEvent, GatedChild } from "../../src/runner/gate.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { superviseRun, type SupervisionPorts, type SupervisionResult } from "../../src/runner/supervisor.ts"
import {
  cancellable,
  fakeProbe,
  IMMEDIATE_ESCALATION,
  monotonic,
  never,
  seedRun,
  sleep,
  withSandbox,
  type Sandbox,
} from "./harness.ts"

const CHILD_PID = 4242
const RECORDED: ChildRecordEvent = { identity: { pid: CHILD_PID, startedAt: "started" }, pgid: CHILD_PID }

function stubChild(over: Partial<GatedChild> = {}): GatedChild {
  return {
    recorded: Promise.resolve(RECORDED),
    authorize() {},
    abandon() {},
    execObserved: Promise.resolve<EvidenceFact>("yes"),
    exited: never<ChildExit>(),
    ...over,
  }
}

type Options = {
  child?: GatedChild
  /** The group the probe reports; empty means the drain sees it gone. */
  members?: number[]
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void
  cancelAfterMs?: number
  timeoutSeconds?: number
}

async function supervise(box: Sandbox, options: Options = {}): Promise<SupervisionResult> {
  const runId = "run-exit-evidence"
  createRunDirectory(box.storage, runId)
  const record = seedRun(box.storage, { runId, timeoutSeconds: options.timeoutSeconds ?? 900 })

  const { cancellation, cancel } = cancellable()
  if (options.cancelAfterMs !== undefined) setTimeout(cancel, options.cancelAfterMs)

  const probe = fakeProbe({
    processes: { [CHILD_PID]: "started" },
    groups: { [CHILD_PID]: options.members ?? [] },
  })

  const ports: SupervisionPorts = {
    storage: box.storage,
    probe: options.signalGroup === undefined ? probe : { ...probe, signalGroup: options.signalGroup },
    now: monotonic(),
    timestamp: () => new Date().toISOString(),
    sleep,
    escalation: IMMEDIATE_ESCALATION,
    startupDeadlineMs: 500,
    exitEvidenceBudgetMs: 200,
    cancellation,
    spawn: () => options.child ?? stubChild(),
  }

  return superviseRun(ports, { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } })
}

describe("a cancelled run whose child never says how it ended", () => {
  test("supervision returns at all", async () => {
    // The whole issue in one assertion. Before this, the test itself would
    // hang here rather than fail, which is what the defect does to a root.
    await withSandbox(async (box) => {
      const result = await supervise(box, { cancelAfterMs: 10 })

      expect(result.trigger).toBe("callerCancellation")
    })
  }, 20_000)

  test("the cancellation stays the reason, rather than the missing evidence", async () => {
    // Being unable to confirm the lifecycle is something discovered while
    // tearing a cancelled run down. It is supporting evidence, and letting it
    // rewrite the trigger would mean the same sequence of events reported two
    // ways depending on what the kernel got round to.
    await withSandbox(async (box) => {
      const result = await supervise(box, { cancelAfterMs: 10 })

      expect(result.trigger).toBe("callerCancellation")
      expect(result.interruptionPhase).toBe("testing")
      expect(result.failure).toBeUndefined()
    })
  }, 20_000)

  test("invents no exit: no code, no signal, and no successful exit", async () => {
    await withSandbox(async (box) => {
      const result = await supervise(box, { cancelAfterMs: 10 })

      expect(result.execution.exitCode).toBeUndefined()
      expect(result.execution.signal).toBeUndefined()
      expect(result.execution.successfulExit).toBe("unknown")
    })
  }, 20_000)

  test("quarantines the slot, because nobody confirmed the lifecycle", async () => {
    // The slot is held on purpose here. A root whose last run may still have
    // something running must refuse the next one with a reason rather than
    // start a second `xcodebuild` over the top of it.
    await withSandbox(async (box) => {
      const result = await supervise(box, { cancelAfterMs: 10 })

      expect(result.quarantine).toBeDefined()
    })
  }, 20_000)

  test("writes the terminal state down, so finalization has something to publish", async () => {
    // Returning is not enough: the adapter publishes from the record, and a
    // run that ended only in memory is one recovery will meet again.
    await withSandbox(async (box) => {
      await supervise(box, { cancelAfterMs: 10 })

      const stored = readRunRecord(box.storage, "run-exit-evidence")
      expect(stored?.state).toBe("executionCompleted")
      expect(stored?.quarantined).toBe(true)
    })
  }, 20_000)
})

describe("a run that reaches its deadline and then goes quiet", () => {
  test("still ends, and the deadline is still the reason", async () => {
    await withSandbox(async (box) => {
      const result = await supervise(box, { timeoutSeconds: 0 })

      expect(result.trigger).toBe("processDeadline")
      expect(result.deadlineCrossedPhase).toBe("testing")
      expect(result.execution.successfulExit).toBe("unknown")
    })
  }, 20_000)
})

describe("an execution observation that never settles on its own", () => {
  test("does not become a second unbounded wait behind the first", async () => {
    // Bounding the exit and then awaiting `execObserved` unbounded moves the
    // hang rather than removing it: the two are separate promises, and a
    // `GatedChild` is an interface, so nothing makes the second follow the
    // first.
    await withSandbox(async (box) => {
      const result = await supervise(box, {
        child: stubChild({ exited: Promise.resolve({ exitCode: 0 }), execObserved: never<EvidenceFact>() }),
        cancelAfterMs: 10,
      })

      expect(result.execution.execObserved).toBe("unknown")
    })
  }, 20_000)

  test("does not discard the exit that was observed", async () => {
    // Two facts, and only one of them is missing. Reporting the run as though
    // neither arrived would throw away the only thing known about how it
    // ended.
    await withSandbox(async (box) => {
      const result = await supervise(box, {
        child: stubChild({ exited: Promise.resolve({ exitCode: 3 }), execObserved: never<EvidenceFact>() }),
        cancelAfterMs: 10,
      })

      expect(result.execution.exitCode).toBe(3)
      expect(result.execution.successfulExit).toBe("no")
    })
  }, 20_000)
})

describe("a process group that will not go away", () => {
  test("bounds escalation and the drain, and still returns", async () => {
    // Every step of escalation is refused by a group that stays populated,
    // and the drain that follows finds it populated too. Both are budgeted;
    // the point is that the budgets are the only thing standing between this
    // and a permanent wait.
    await withSandbox(async (box) => {
      const result = await supervise(box, { members: [CHILD_PID], cancelAfterMs: 10 })

      expect(result.termination.descendantsConfirmedExited).toBe("no")
      expect(result.quarantine).toBeDefined()
    })
  }, 30_000)

  test("a signal the kernel refuses ends escalation rather than supervision", async () => {
    await withSandbox(async (box) => {
      const result = await supervise(box, {
        members: [CHILD_PID],
        signalGroup: () => {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" })
        },
        cancelAfterMs: 10,
      })

      expect(result.trigger).toBe("callerCancellation")
      expect(result.termination.requested).toBe("no")
    })
  }, 30_000)
})

describe("a child that never publishes its identity", () => {
  test("is abandoned without waiting for an exit that will not come either", async () => {
    // The wait before authorization is the same hazard one step earlier:
    // startup has a deadline, but the `await child.exited` that followed the
    // abandon had none.
    await withSandbox(async (box) => {
      const result = await supervise(box, {
        child: stubChild({ recorded: never<ChildRecordEvent>(), exited: never<ChildExit>() }),
      })

      expect(result.failure).toEqual({ reason: "runnerFailure", phase: "launching" })
    })
  }, 20_000)

  test("holds the slot, because an abandoned gate that never reported is still a process", async () => {
    // It cannot have executed Xcode — the gate `exec`s nothing until it reads
    // an authorization that was never written. What it might still be is
    // itself, and "it will exit" is a prediction rather than an observation.
    await withSandbox(async (box) => {
      const result = await supervise(box, {
        child: stubChild({ recorded: never<ChildRecordEvent>(), exited: never<ChildExit>() }),
      })

      expect(result.quarantine).toBeDefined()
      expect(result.execution).toEqual({ execObserved: "no", successfulExit: "unknown" })
      expect(result.termination.descendantsConfirmedExited).toBe("unknown")
    })
  }, 20_000)

  test("writes that down, so recovery meets a record rather than a silence", async () => {
    await withSandbox(async (box) => {
      await supervise(box, {
        child: stubChild({ recorded: never<ChildRecordEvent>(), exited: never<ChildExit>() }),
      })

      const stored = readRunRecord(box.storage, "run-exit-evidence")
      expect(stored?.state).toBe("executionCompleted")
      expect(stored?.quarantined).toBe(true)
    })
  }, 20_000)

  test("but an abandoned gate that did report is an ordinary refusal", async () => {
    // Nothing uncertain happened here, and quarantining a root over a gate
    // that exited exactly as designed would refuse every later run for a
    // process everybody watched leave.
    await withSandbox(async (box) => {
      const result = await supervise(box, {
        child: stubChild({ recorded: never<ChildRecordEvent>(), exited: Promise.resolve({ exitCode: 70 }) }),
      })

      expect(result.quarantine).toBeUndefined()
      expect(result.execution).toEqual({ execObserved: "no", successfulExit: "no" })
    })
  }, 20_000)
})
