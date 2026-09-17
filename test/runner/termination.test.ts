/**
 * Termination-trigger precedence and the escalation schedule (#3).
 *
 * These are pure, because the property under test is an ordering rule rather
 * than a timing one — and an ordering rule proved by waiting on real signals
 * would be proved slowly and flakily.
 */

import { describe, expect, test } from "bun:test"

import {
  descendantsConfirmedExited,
  DRAIN_BUDGET_MS,
  ESCALATION,
  ESCALATION_BUDGET_MS,
  quarantineRequired,
  runnerFailureApplies,
  TerminationTrigger,
} from "../../src/runner/termination.ts"

describe("the escalation schedule", () => {
  test("is SIGINT, then SIGTERM, then SIGKILL", () => {
    expect(ESCALATION.map((step) => step.signal)).toEqual(["SIGINT", "SIGTERM", "SIGKILL"])
  })

  test("waits 10 seconds, then 5, then 5, and is bounded at 20", () => {
    expect(ESCALATION.map((step) => step.waitMs)).toEqual([10_000, 5_000, 5_000])
    expect(ESCALATION_BUDGET_MS).toBe(20_000)
  })

  test("allows a fixed 5-second drain after an ordinary exit", () => {
    expect(DRAIN_BUDGET_MS).toBe(5_000)
  })
})

describe("the first trigger", () => {
  test("fixes the outcome", () => {
    const trigger = new TerminationTrigger()
    expect(trigger.fix("callerCancellation")).toBe(true)
    expect(trigger.trigger).toBe("callerCancellation")
  })

  test("is not displaced by the deadline expiring during teardown", () => {
    const trigger = new TerminationTrigger()
    trigger.fix("callerCancellation")
    expect(trigger.fix("processDeadline")).toBe(false)
    expect(trigger.trigger).toBe("callerCancellation")
  })

  test("is not displaced by a cancellation arriving after a timeout", () => {
    const trigger = new TerminationTrigger()
    trigger.fix("processDeadline")
    trigger.fix("callerCancellation")
    expect(trigger.trigger).toBe("processDeadline")
  })

  test("is not displaced by a later supervision failure", () => {
    const trigger = new TerminationTrigger()
    trigger.fix("processDeadline")
    trigger.fix("toolFailure")
    expect(trigger.trigger).toBe("processDeadline")
  })

  test("starts as `none`, with no termination requested", () => {
    const trigger = new TerminationTrigger()
    expect(trigger.trigger).toBe("none")
    expect(trigger.requested).toBe("no")
    expect(trigger.isFixed).toBe(false)
  })

  test("records `requested` only once a signal was actually sent", () => {
    const trigger = new TerminationTrigger()
    trigger.fix("callerCancellation")
    expect(trigger.requested).toBe("no")
    trigger.markRequested()
    expect(trigger.requested).toBe("yes")
  })
})

describe("a runner failure", () => {
  test("applies when nothing else fixed the outcome", () => {
    expect(runnerFailureApplies("none")).toBe(true)
    expect(runnerFailureApplies("toolFailure")).toBe(true)
  })

  test("never overrides cancellation or the deadline", () => {
    expect(runnerFailureApplies("callerCancellation")).toBe(false)
    expect(runnerFailureApplies("processDeadline")).toBe(false)
  })
})

describe("descendant confirmation", () => {
  test("is `yes` only when the group is empty and nothing survives", () => {
    expect(descendantsConfirmedExited({ groupEmpty: true, survivingDescendants: 0 })).toBe("yes")
  })

  test("is `no` when a descendant is still alive", () => {
    expect(descendantsConfirmedExited({ groupEmpty: false, survivingDescendants: 1 })).toBe("no")
    expect(descendantsConfirmedExited({ groupEmpty: true, survivingDescendants: 2 })).toBe("no")
  })

  test("is `unknown` when observation was incomplete, never a hopeful `yes`", () => {
    expect(descendantsConfirmedExited({ groupEmpty: "unknown", survivingDescendants: 0 })).toBe("unknown")
    expect(descendantsConfirmedExited({ groupEmpty: true, survivingDescendants: "unknown" })).toBe("unknown")
  })
})

describe("quarantine", () => {
  test("is required whenever the lifecycle was not fully confirmed", () => {
    expect(
      quarantineRequired({
        childExitConfirmed: "yes",
        descendantsConfirmedExited: "unknown",
        durableStateUncertain: false,
        logCaptureIncomplete: false,
      }),
    ).toBe(true)
    expect(
      quarantineRequired({
        childExitConfirmed: "yes",
        descendantsConfirmedExited: "yes",
        durableStateUncertain: true,
        logCaptureIncomplete: false,
      }),
    ).toBe(true)
    expect(
      quarantineRequired({
        childExitConfirmed: "yes",
        descendantsConfirmedExited: "yes",
        durableStateUncertain: false,
        logCaptureIncomplete: true,
      }),
    ).toBe(true)
  })

  test("is required when the direct child's own exit was never observed", () => {
    // Separate from the group: the process table can say a group is empty
    // while the runtime that owned the child never reported how it ended.
    expect(
      quarantineRequired({
        childExitConfirmed: "unknown",
        descendantsConfirmedExited: "yes",
        durableStateUncertain: false,
        logCaptureIncomplete: false,
      }),
    ).toBe(true)
  })

  test("is not required when every fact is confirmed", () => {
    expect(
      quarantineRequired({
        childExitConfirmed: "yes",
        descendantsConfirmedExited: "yes",
        durableStateUncertain: false,
        logCaptureIncomplete: false,
      }),
    ).toBe(false)
  })
})
