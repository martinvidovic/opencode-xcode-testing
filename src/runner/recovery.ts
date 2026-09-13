/**
 * Crash reconciliation and quarantine (#3).
 *
 * There is no daemon. Reconciliation runs at plugin startup, before queue
 * enrollment, and before retention cleanup — and it is the reason a crashed
 * OpenCode does not leave a trusted root permanently unusable.
 *
 * The discipline here is that uncertainty holds the execution slot rather than
 * releasing it. A run whose lifecycle cannot be established keeps the root
 * quarantined, because admitting a second `xcodebuild` while an unaccounted-for
 * one may still be writing the same DerivedData is how a test tool starts
 * producing results nobody can explain.
 */

import { readdirSync } from "node:fs"

import { allIdentitiesGone, signallingIsSafe, type ProcessIdentity, type ProcessProbe } from "./identity.ts"
import { withLock } from "./locks.ts"
import type { Storage } from "./paths.ts"
import { clearQuarantine, readQueue, releaseSlot, writeQueue } from "./queue.ts"
import { advance, readRunRecord, type RunRecord } from "./state.ts"

export type RecoveryStatus =
  | "recovered"
  | "alreadyHealthy"
  | "busy"
  | "stillQuarantined"
  | "cancelled"
  | "failed"

export type RecoveryEnvironment = {
  storage: Storage
  probe: ProcessProbe
  timestamp(): string
  signal?: { aborted: boolean }
}

export type RecoveryReport = {
  status: RecoveryStatus
  /** Runs this pass moved to a terminal state without rerunning anything. */
  finalized: string[]
  /** Runs whose lifecycle is still uncertain, and which still hold the slot. */
  uncertain: string[]
  quarantineCleared: boolean
}

/**
 * Reconcile every unfinished run under this trusted root.
 *
 * Explicit recovery is exposed through the Test Tool and is implicitly scoped
 * to the adapter-supplied trusted root: it accepts no PID, PGID, path, signal
 * or force option, because every one of those would be a way to aim the tool at
 * something it does not own.
 */
export function reconcileRoot(environment: RecoveryEnvironment): RecoveryReport {
  const { storage } = environment
  const report: RecoveryReport = {
    status: "alreadyHealthy",
    finalized: [],
    uncertain: [],
    quarantineCleared: false,
  }

  if (environment.signal?.aborted === true) return { ...report, status: "cancelled" }

  let runIds: string[]
  try {
    runIds = readdirSync(storage.runsDir).sort()
  } catch {
    return report
  }

  let busy = false

  for (const runId of runIds) {
    if (environment.signal?.aborted === true) {
      // Cancellation stops future work; it never undoes completed cleanup.
      return { ...report, status: "cancelled" }
    }

    const record = readRunRecord(storage, runId)
    if (record === undefined) {
      // Unreadable durable state is uncertainty, not absence.
      report.uncertain.push(runId)
      continue
    }
    if (record.state === "completed") continue

    const outcome = reconcileRun(environment, record)
    if (outcome === "busy") {
      busy = true
      continue
    }
    if (outcome === "uncertain") {
      report.uncertain.push(runId)
      continue
    }
    report.finalized.push(runId)
  }

  if (busy) return { ...report, status: "busy" }

  if (report.uncertain.length > 0) {
    return { ...report, status: "stillQuarantined" }
  }

  report.quarantineCleared = tryClearQuarantine(environment)
  report.status =
    report.finalized.length > 0 || report.quarantineCleared ? "recovered" : "alreadyHealthy"
  return report
}

type RunOutcome = "finalized" | "busy" | "uncertain"

function reconcileRun(environment: RecoveryEnvironment, record: RunRecord): RunOutcome {
  const { storage, probe } = environment
  const recorded = recordedIdentities(record)

  // An admitted run with no durable supervisor identity proves, by protocol
  // invariant, that Xcode was never started: the supervisor publishes its
  // identity before it may create the future child.
  if (record.state === "admitted" && record.supervisor === undefined) {
    finalize(storage, record, environment.timestamp(), {
      terminationTrigger: "toolFailure",
      execObserved: "no",
      descendantsConfirmedExited: "yes",
    })
    return "finalized"
  }

  if (record.child !== undefined) {
    if (signallingIsSafe(probe, { pgid: record.child.pgid, processes: [record.child] })) {
      // A live, identity-validated member means an active run. Recovery never
      // interrupts one.
      return "busy"
    }
  }

  if (record.supervisor !== undefined) {
    const current = probe.identify(record.supervisor.pid)
    if (current !== undefined && current.startedAt === record.supervisor.startedAt) return "busy"
  }

  if (!allIdentitiesGone(probe, recorded)) return "uncertain"

  // Numeric PGID reuse alone must not preserve quarantine forever, so a group
  // whose recorded identities are all gone is reconciled even if the number is
  // now in use by something unrelated.
  finalize(storage, record, environment.timestamp(), {
    descendantsConfirmedExited: record.descendantsConfirmedExited ?? "unknown",
  })
  return "finalized"
}

function finalize(
  storage: Storage,
  record: RunRecord,
  completedAt: string,
  fields: Partial<RunRecord>,
): void {
  let current = record
  // States are monotonic, so a run that never reached execution is walked
  // forward through the states it skipped rather than jumped over them.
  for (const state of ["supervisorReady", "childRecorded", "launchAuthorized", "executionCompleted"] as const) {
    if (indexOf(current.state) < indexOf(state)) current = advance(storage, current, state)
  }
  advance(storage, current, "completed", { ...fields, completedAt })
  releaseSlot(storage, record.runId)
}

function indexOf(state: RunRecord["state"]): number {
  return [
    "admitted",
    "supervisorReady",
    "childRecorded",
    "launchAuthorized",
    "executionCompleted",
    "completed",
  ].indexOf(state)
}

function recordedIdentities(record: RunRecord): ProcessIdentity[] {
  const identities: ProcessIdentity[] = []
  if (record.supervisor !== undefined) identities.push(record.supervisor)
  if (record.child !== undefined) identities.push(record.child)
  return identities
}

/**
 * Quarantine clears only when every condition holds at once: recorded
 * identities gone or mismatched, no active supervisor, durable state
 * consistent, and no identity-validated group member still attributable.
 */
function tryClearQuarantine(environment: RecoveryEnvironment): boolean {
  const { storage } = environment
  const state = readQueue(storage)
  const quarantine = state.quarantine
  if (quarantine === undefined) return false

  const record = readRunRecord(storage, quarantine.runId)
  if (record !== undefined && record.state !== "completed") return false
  if (record?.child !== undefined) {
    if (signallingIsSafe(environment.probe, { pgid: record.child.pgid, processes: [record.child] })) {
      return false
    }
  }
  if (record !== undefined && !allIdentitiesGone(environment.probe, recordedIdentities(record))) {
    return false
  }

  clearQuarantine(storage)
  return true
}

/** Quarantine the root's execution slot, holding it until recovery clears it. */
export function quarantineSlot(storage: Storage, runId: string, reason: string, since: string): void {
  withLock(storage.rootLock, () => {
    const state = readQueue(storage)
    writeQueue(storage, { ...state, quarantine: { runId, reason, since } })
  })
}
