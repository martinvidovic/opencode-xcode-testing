/**
 * Termination-trigger precedence and bounded escalation (#3).
 *
 * The rule that everything else hangs off: **the event that first initiates
 * process termination fixes the outcome.** A run the caller cancelled stays
 * `cancelled` even if the deadline expires while it is being torn down, and a
 * run that timed out stays `timedOut` even if the caller cancels afterwards.
 * Without that, the same sequence of events could be reported two ways
 * depending on scheduling, which is exactly the kind of nondeterminism that
 * makes a test tool untrustworthy.
 */

import type { EvidenceFact, ProcessTerminationTrigger } from "../domain/evidence.ts"


/** `SIGINT`, then `SIGTERM`, then `SIGKILL`, with a bounded wait after each. */
export const ESCALATION: ReadonlyArray<{ signal: NodeJS.Signals; waitMs: number }> = [
  { signal: "SIGINT", waitMs: 10_000 },
  { signal: "SIGTERM", waitMs: 5_000 },
  { signal: "SIGKILL", waitMs: 5_000 },
]

/** The whole escalation window. It never consumes the Test Run timeout. */
export const ESCALATION_BUDGET_MS = ESCALATION.reduce((total, step) => total + step.waitMs, 0)

/** After an ordinary exit, how long the group and capture channel may drain. */
export const DRAIN_BUDGET_MS = 5_000

/**
 * The first trigger wins, and nothing later can displace it.
 *
 * `toolFailure` is the one conditional case: channel loss or a runner-side
 * error only becomes the trigger when nothing has already fixed one, because a
 * supervision problem discovered while tearing down a cancelled run does not
 * change the fact that the caller cancelled it.
 */
export class TerminationTrigger {
  #trigger: ProcessTerminationTrigger = "none"
  #requested: EvidenceFact = "no"

  /** Returns true when this call is the one that fixed the outcome. */
  fix(trigger: Exclude<ProcessTerminationTrigger, "none">): boolean {
    if (this.#trigger !== "none") return false
    this.#trigger = trigger
    return true
  }

  /** Record that a termination request was actually sent to the group. */
  markRequested(): void {
    this.#requested = "yes"
  }

  get trigger(): ProcessTerminationTrigger {
    return this.#trigger
  }

  get requested(): EvidenceFact {
    return this.#requested
  }

  get isFixed(): boolean {
    return this.#trigger !== "none"
  }
}

/**
 * Whether a failure to confirm the lifecycle should be reported as a runner
 * failure. It should not when cancellation or the deadline already decided the
 * outcome — there, it is supporting evidence and a reason to quarantine.
 */
export function runnerFailureApplies(trigger: ProcessTerminationTrigger): boolean {
  return trigger !== "callerCancellation" && trigger !== "processDeadline"
}

/**
 * `yes` only when the owned group is empty *and* every separately observed
 * descendant identity is gone. A direct `xcodebuild` exit proves neither.
 */
export function descendantsConfirmedExited(observation: {
  groupEmpty: boolean | "unknown"
  survivingDescendants: number | "unknown"
}): EvidenceFact {
  if (observation.groupEmpty === "unknown" || observation.survivingDescendants === "unknown") {
    return "unknown"
  }
  if (!observation.groupEmpty || observation.survivingDescendants > 0) return "no"
  return "yes"
}

/** An unconfirmed or uncertain lifecycle holds the root's execution slot. */
export function quarantineRequired(evidence: {
  descendantsConfirmedExited: EvidenceFact
  durableStateUncertain: boolean
  logCaptureIncomplete: boolean
}): boolean {
  return (
    evidence.descendantsConfirmedExited !== "yes" ||
    evidence.durableStateUncertain ||
    evidence.logCaptureIncomplete
  )
}
