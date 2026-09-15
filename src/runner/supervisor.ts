/**
 * The supervisor (#3).
 *
 * It is authoritative from admission through process exit, and it stays
 * *outside* the `xcodebuild`-owned process group throughout — a supervisor
 * inside the group would receive its own escalation signals and die halfway
 * through tearing the run down.
 *
 * The invariant every branch here protects: the event that first initiates
 * termination fixes the outcome, and nothing discovered afterwards — a failed
 * confirmation, a lost channel, an unwritable metadata file — ever overwrites
 * it. Those become supporting evidence and a reason to quarantine the root's
 * execution slot, which is a statement about the tool's certainty rather than
 * about the run's result.
 */

import type { EvidenceFact, ExecutionEvidence, TerminationEvidence } from "../domain/evidence.ts"
import type {
  DeadlineCrossedPhase,
  InfrastructureReason,
  InterruptionPhase,
  ProcessTerminationTrigger,
} from "../domain/outcome.ts"
import type { ChildExit, GatedChild } from "./gate.ts"
import { signallingIsSafe, type ProcessProbe } from "./identity.ts"
import type { Storage } from "./paths.ts"
import { advance, writeRunRecord, type RunRecord } from "./state.ts"
import {
  descendantsConfirmedExited,
  DRAIN_BUDGET_MS,
  ESCALATION,
  quarantineRequired,
  runnerFailureApplies,
  TerminationTrigger,
} from "./termination.ts"

/** Supervisor startup has its own deadline and never consumes the Test Run timeout. */
export const SUPERVISOR_STARTUP_DEADLINE_MS = 30_000

export type Cancellation = {
  readonly aborted: boolean
  readonly whenAborted: Promise<void>
}

export type SupervisionPorts = {
  storage: Storage
  probe: ProcessProbe
  /** Monotonic. Deadlines and durations never read the adjustable wall clock. */
  now(): number
  /** Wall-clock UTC, used only for timestamps. */
  timestamp(): string
  sleep(ms: number): Promise<void>
  spawn(): GatedChild
  cancellation?: Cancellation
  /**
   * Whether the private control channel has been lost since the handshake.
   *
   * Channel loss means the plugin is gone. That is a supervision failure, but
   * only when nothing has already fixed the outcome — a channel that dropped
   * while a cancelled run was being torn down does not change the fact that
   * the caller cancelled it.
   */
  channelLost?(): boolean
  /** Injectable so the stub suite can prove the ordering without real waits. */
  escalation?: typeof ESCALATION
  startupDeadlineMs?: number
}

export type SupervisionResult = {
  record: RunRecord
  trigger: ProcessTerminationTrigger
  termination: TerminationEvidence
  execution: ExecutionEvidence
  interruptionPhase?: InterruptionPhase
  deadlineCrossedPhase?: DeadlineCrossedPhase
  /** Set when the lifecycle could not be confirmed; the slot stays held. */
  quarantine?: string
  /** Set only when no cancellation or deadline already fixed the outcome. */
  failure?: { reason: InfrastructureReason; phase: "launching" | "terminating" }
  startedAt?: string
  processDurationMs?: number
}

export async function superviseRun(
  ports: SupervisionPorts,
  input: { record: RunRecord; supervisorIdentity: RunRecord["supervisor"] },
): Promise<SupervisionResult> {
  const trigger = new TerminationTrigger()
  let record = advance(ports.storage, input.record, "supervisorReady", {
    ...(input.supervisorIdentity === undefined ? {} : { supervisor: input.supervisorIdentity }),
  })

  // Cancelled before there is anything to terminate: no trigger, no request.
  if (ports.cancellation?.aborted === true) {
    return cancelledBeforeLaunch(record, trigger)
  }

  const child = ports.spawn()

  const recorded = await withDeadline(
    ports,
    child.recorded,
    ports.startupDeadlineMs ?? SUPERVISOR_STARTUP_DEADLINE_MS,
  )

  if (recorded === "expired" || recorded === undefined) {
    child.abandon()
    await child.exited
    return {
      record,
      trigger: trigger.trigger,
      termination: evidenceOf(trigger, { descendants: "yes" }),
      execution: { execObserved: "no", successfulExit: "no" },
      failure: { reason: "runnerFailure", phase: "launching" },
    }
  }

  record = advance(ports.storage, record, "childRecorded", {
    child: { ...recorded.identity, pgid: recorded.pgid },
  })

  // Cancelling here terminates a gated child that never executed Xcode, which
  // is a cooperative exit rather than a termination request.
  if (ports.cancellation?.aborted === true) {
    child.abandon()
    await child.exited
    return cancelledBeforeLaunch(record, trigger)
  }

  const startedAt = ports.timestamp()
  try {
    record = advance(ports.storage, record, "launchAuthorized", { startedAt })
  } catch {
    // Authorization that cannot be persisted is authorization that recovery
    // could not reason about, so the child is never released.
    child.abandon()
    await child.exited
    return {
      record,
      trigger: trigger.trigger,
      termination: evidenceOf(trigger, { descendants: "yes" }),
      execution: { execObserved: "no", successfulExit: "no" },
      failure: { reason: "processLaunchFailed", phase: "launching" },
    }
  }

  const launchedAt = ports.now()
  child.authorize()

  const timeoutMs = record.timeoutSeconds * 1000
  const outcome = await race(ports, child, timeoutMs)

  let deadlineCrossedPhase: DeadlineCrossedPhase | undefined
  let interruptionPhase: InterruptionPhase | undefined
  let durableStateUncertain = false

  if (outcome !== "exited") {
    if (outcome === "cancelled") {
      trigger.fix("callerCancellation")
      interruptionPhase = "testing"
    } else {
      trigger.fix("processDeadline")
      deadlineCrossedPhase = "testing"
    }
    // The trigger is persisted at event time, before any signal is sent. A
    // crash mid-escalation would otherwise leave recovery unable to tell a
    // cancelled run from a timed-out one, and the outcome would depend on who
    // happened to look at it afterwards.
    durableStateUncertain = !persistTrigger(ports, record, trigger) || durableStateUncertain
    await terminate(ports, trigger, recorded)
  }

  const exit = await child.exited
  const processDurationMs = ports.now() - launchedAt
  const execObserved = await child.execObserved

  const drained = await drain(ports, recorded.pgid)
  const descendants = descendantsConfirmedExited({
    groupEmpty: drained.groupEmpty,
    survivingDescendants: drained.surviving,
  })

  // A group still live after the drain is a supervision failure — but only the
  // trigger, and only if nothing already fixed one.
  // `fix` is already first-wins, so a channel that dropped while a cancelled
  // run was being torn down cannot rewrite what happened.
  const channelLost = ports.channelLost?.() === true
  if (channelLost && trigger.fix("toolFailure")) {
    durableStateUncertain = !persistTrigger(ports, record, trigger) || durableStateUncertain
  }

  if (descendants !== "yes" && runnerFailureApplies(trigger.trigger)) {
    trigger.fix("toolFailure")
    durableStateUncertain = !persistTrigger(ports, record, trigger) || durableStateUncertain
    await terminate(ports, trigger, recorded)
  }

  const quarantine = quarantineRequired({
    descendantsConfirmedExited: descendants,
    durableStateUncertain,
    logCaptureIncomplete: descendants !== "yes",
  })
    ? "the process lifecycle could not be confirmed"
    : undefined

  record = advance(ports.storage, record, "executionCompleted", {
    terminationTrigger: trigger.trigger,
    execObserved,
    descendantsConfirmedExited: descendants,
    ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
    ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    ...(quarantine === undefined ? {} : { quarantined: true, quarantineReason: quarantine }),
    // Recorded whether or not it became the trigger. Losing it when something
    // else fixed the outcome first would leave recovery unable to tell an
    // unpublished run from one whose adapter was no longer there to publish
    // it, which is the one thing that distinguishes them.
    ...(channelLost ? { controlChannelLost: true } : {}),
  })

  return {
    record,
    trigger: trigger.trigger,
    termination: evidenceOf(trigger, { descendants }),
    execution: executionEvidence(execObserved, exit),
    ...(interruptionPhase === undefined ? {} : { interruptionPhase }),
    ...(deadlineCrossedPhase === undefined ? {} : { deadlineCrossedPhase }),
    ...(quarantine === undefined ? {} : { quarantine }),
    ...(trigger.trigger === "toolFailure"
      ? { failure: { reason: "runnerFailure" as const, phase: "terminating" as const } }
      : {}),
    startedAt,
    processDurationMs,
  }
}

/**
 * A strictly bounded attempt to persist the fixed trigger before signalling.
 *
 * Persistence must never materially delay termination, so a failure is not
 * retried: signalling proceeds, the live protocol keeps the trigger, and the
 * durable state is declared uncertain so recovery fails closed rather than
 * guessing which event came first.
 */
function persistTrigger(
  ports: SupervisionPorts,
  record: RunRecord,
  trigger: TerminationTrigger,
): boolean {
  try {
    writeRunRecord(ports.storage, { ...record, terminationTrigger: trigger.trigger })
    return true
  } catch {
    return false
  }
}

function cancelledBeforeLaunch(
  record: RunRecord,
  trigger: TerminationTrigger,
): SupervisionResult {
  return {
    record,
    trigger: trigger.trigger,
    termination: evidenceOf(trigger, { descendants: "yes" }),
    execution: { execObserved: "no", successfulExit: "no" },
    interruptionPhase: "launching",
  }
}

type RaceOutcome = "exited" | "cancelled" | "timedOut"

async function race(
  ports: SupervisionPorts,
  child: GatedChild,
  timeoutMs: number,
): Promise<RaceOutcome> {
  const deadlineAt = ports.now() + timeoutMs
  const exited = child.exited.then<RaceOutcome>(() => "exited")
  const cancelled =
    ports.cancellation === undefined
      ? never<RaceOutcome>()
      : ports.cancellation.whenAborted.then<RaceOutcome>(() => "cancelled")

  for (;;) {
    const remaining = deadlineAt - ports.now()
    if (remaining <= 0) return "timedOut"
    const tick = ports.sleep(Math.min(remaining, 50)).then<RaceOutcome | "tick">(() => "tick")
    const outcome = await Promise.race([exited, cancelled, tick])
    if (outcome !== "tick") return outcome
  }
}

/**
 * Bounded escalation, and never a signal to a bare numeric PGID: immediately
 * before each signal at least one currently-live recorded process must validate
 * by PID, start identity and group membership. Without that check, PID reuse
 * eventually means signalling somebody else's work.
 */
async function terminate(
  ports: SupervisionPorts,
  trigger: TerminationTrigger,
  recorded: { identity: { pid: number; startedAt: string }; pgid: number },
): Promise<void> {
  const schedule = ports.escalation ?? ESCALATION

  for (const step of schedule) {
    if (!signallingIsSafe(ports.probe, { pgid: recorded.pgid, processes: [recorded.identity] })) {
      return
    }
    try {
      ports.probe.signalGroup(recorded.pgid, step.signal)
      trigger.markRequested()
    } catch {
      return
    }
    const gone = await waitForEmptyGroup(ports, recorded.pgid, step.waitMs)
    if (gone) return
  }
}

async function drain(
  ports: SupervisionPorts,
  pgid: number,
): Promise<{ groupEmpty: boolean | "unknown"; surviving: number | "unknown" }> {
  const gone = await waitForEmptyGroup(ports, pgid, DRAIN_BUDGET_MS)
  if (gone) return { groupEmpty: true, surviving: 0 }
  const members = ports.probe.membersOf(pgid)
  return { groupEmpty: members.length === 0, surviving: members.length }
}

async function waitForEmptyGroup(
  ports: SupervisionPorts,
  pgid: number,
  budgetMs: number,
): Promise<boolean> {
  const until = ports.now() + budgetMs
  for (;;) {
    if (ports.probe.membersOf(pgid).length === 0) return true
    if (ports.now() >= until) return false
    await ports.sleep(Math.min(25, Math.max(1, until - ports.now())))
  }
}

async function withDeadline<T>(
  ports: SupervisionPorts,
  work: Promise<T>,
  budgetMs: number,
): Promise<T | "expired" | undefined> {
  const expiry = ports.sleep(budgetMs).then(() => "expired" as const)
  try {
    return await Promise.race([work, expiry])
  } catch {
    return undefined
  }
}

function evidenceOf(
  trigger: TerminationTrigger,
  observed: { descendants: EvidenceFact },
): TerminationEvidence {
  const requested = trigger.requested
  return {
    requested,
    gracefulTerminationObserved: requested === "yes" ? "unknown" : "no",
    forceEscalationRequired: "unknown",
    terminationGraceExceeded: "unknown",
    descendantsConfirmedExited: observed.descendants,
  }
}

function executionEvidence(execObserved: EvidenceFact, exit: ChildExit): ExecutionEvidence {
  return {
    execObserved,
    ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
    ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    successfulExit: exit.signal !== undefined ? "no" : exit.exitCode === 0 ? "yes" : "no",
  }
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}
