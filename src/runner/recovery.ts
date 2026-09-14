/**
 * Crash reconciliation and quarantine (#3).
 *
 * There is no daemon. Reconciliation runs at plugin startup, before queue
 * enrollment, and before retention cleanup — and it is the reason a crashed
 * OpenCode does not leave a trusted root permanently unusable.
 *
 * Two disciplines govern everything here.
 *
 * **Uncertainty holds the execution slot rather than releasing it.** A run whose
 * lifecycle cannot be established keeps the root quarantined, because admitting
 * a second `xcodebuild` while an unaccounted-for one may still be writing the
 * same DerivedData is how a test tool starts producing results nobody can
 * explain.
 *
 * **Recovery never invents a terminal result.** It does not mark a run
 * `completed` on its own: interpretation belongs to the caller, which publishes
 * the same immutable summary and index a normal completed run publishes, and
 * only then releases the slot. Recovery reports which runs need that and holds
 * the slot until it happens.
 *
 * The whole pass runs under one acquisition of the root lock, so it is
 * serialized against live finalization and never observes half-written state.
 * Nothing inside re-acquires it — the lock is not reentrant.
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { allIdentitiesGone, signallingIsSafe, type ProcessIdentity, type ProcessProbe } from "./identity.ts"
import { withLock, withTryLock } from "./locks.ts"
import { isRunId, RUN_ARTIFACTS, runDirectory, type Storage } from "./paths.ts"
import { QUARANTINE_REASON, readQueue, writeQueue, type QueueState } from "./queue.ts"
import { readRunRecord, writeRunRecord, type RunRecord } from "./state.ts"

export type RecoveryStatus =
  | "recovered"
  | "alreadyHealthy"
  | "busy"
  | "deferred"
  | "stillQuarantined"
  | "cancelled"
  | "failed"

export type RecoveryEnvironment = {
  storage: Storage
  probe: ProcessProbe
  timestamp(): string
  /**
   * Stops the pass between runs. It covers both cancellation and an expiring
   * budget, because a synchronous scan cannot be interrupted from outside: a
   * timer cannot fire while the work it bounds is still on the stack, so the
   * only deadline that can hold is one the scan checks itself.
   */
  signal?: { aborted: boolean }
  /**
   * The process that will finalize whatever this pass adopts. Recorded onto
   * each adopted run so a concurrent instance sees a live owner and defers.
   */
  claimant?: ProcessIdentity
}

export type RecoveryReport = {
  status: RecoveryStatus
  /**
   * Runs whose artifacts are complete and whose processes are gone, but whose
   * terminal summary and index have not been published. The caller finalizes
   * them; the slot is held until it does.
   */
  needsFinalization: string[]
  /** Runs whose lifecycle is still uncertain, and which hold the root quarantined. */
  uncertain: string[]
  /** Completed runs whose own recorded quarantine had never been published. */
  quarantined: string[]
  /** Slots released because their run is no longer live or already finished. */
  slotsReleased: string[]
  /** Completed runs whose isolated DerivedData was reclaimed. */
  derivedDataCleaned: string[]
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
  const report = withTryLock(environment.storage.rootLock, () => reconcileLocked(environment))

// A held root lock means a live instance is already doing exactly this, and
  // the answer for this one is to get out of its way. ADR 0002 requires it:
  // "Both reconciliation passes try the lock without waiting."
  //
  // `deferred`, not `busy`. They sound alike and mean opposite things: `busy`
  // is something this pass *found* — a live run owning the slot — and
  // `deferred` is the absence of any finding at all, because nothing was
  // examined. A caller told `busy` has been told about the root; a caller told
  // `deferred` has been told about this attempt.
  return report ?? { ...emptyReport(), status: "deferred" }
}

/**
 * A fresh report with nothing in it.
 *
 * A function rather than a constant because every field but one is an array,
 * and a shared constant spread into each pass would hand them all the same
 * arrays to push into.
 */
function emptyReport(): RecoveryReport {
  return {
    status: "alreadyHealthy",
    needsFinalization: [],
    uncertain: [],
    quarantined: [],
    slotsReleased: [],
    derivedDataCleaned: [],
    quarantineCleared: false,
  }
}

function reconcileLocked(environment: RecoveryEnvironment): RecoveryReport {
  const { storage } = environment
  const report: RecoveryReport = emptyReport()

  if (environment.signal?.aborted === true) return { ...report, status: "cancelled" }

  let state: QueueState
  try {
    state = readQueue(storage)
  } catch {
    // Malformed coordination state fails closed; the suspect file is preserved.
    return { ...report, status: "failed" }
  }

  let runIds: string[]
  try {
    runIds = readdirSync(storage.runsDir).sort()
  } catch {
    return report
  }

  let busy = false

  for (const runId of runIds) {
    // Recovery quarantines, releases slots and deletes directories. A name it
    // could not have issued is not a run of ours, and is left exactly alone.
    if (!isRunId(runId)) continue

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

    if (record.state === "completed") {
      // A run that recorded its own quarantine and then crashed before
      // publishing it is exactly the window the quarantine exists to cover —
      // but only while something is still attributable to it. The flag records
      // why the root was held, not whether it must go on being held.
      if (
        record.quarantined === true &&
        state.quarantine === undefined &&
        stillAttributable(environment, record)
      ) {
        report.quarantined.push(runId)
      }
      if (reclaimIsolatedDerivedData(storage, record)) report.derivedDataCleaned.push(runId)
      continue
    }

    const outcome = classify(environment, record)
    if (outcome === "busy") {
      busy = true
    } else if (outcome === "uncertain") {
      report.uncertain.push(runId)
    } else {
      // Claim it before releasing the lock. Finalization happens outside this
      // lock — it has to interpret — so without a claim two instances would
      // both adopt the same run and both publish a terminal summary.
      if (environment.claimant !== undefined) {
        writeRunRecord(storage, { ...record, owner: environment.claimant })
      }
      report.needsFinalization.push(runId)
    }
  }

  // Slot bookkeeping. An active slot naming a run with no durable record is,
  // by protocol invariant, a run that never started — admission writes the
  // record before the slot transfers.
  const active = state.activeRunId
  if (active !== undefined && !report.needsFinalization.includes(active) && !report.uncertain.includes(active)) {
    const record = readRunRecord(storage, active)
    if (record === undefined || record.state === "completed") {
      state = withoutActive(state)
      report.slotsReleased.push(active)
    }
  }

  const holding = [...report.uncertain, ...report.quarantined]
  if (holding.length > 0) {
    // Publishing quarantine and dropping ownership is one transition: a root
    // that is quarantined must never also look busy, or admission would wait
    // out its whole deadline instead of failing fast.
    const runId = holding[0] as string
    state = {
      ...withoutActive(state),
      quarantine: { runId, reason: QUARANTINE_REASON, since: environment.timestamp() },
    }
  } else if (state.quarantine !== undefined && report.needsFinalization.length === 0) {
    if (canClearQuarantine(environment, state.quarantine.runId)) {
      const next = { ...state }
      delete next.quarantine
      state = next
      report.quarantineCleared = true
    }
  }

  writeQueue(storage, state)

  if (busy) return { ...report, status: "busy" }
  if (report.uncertain.length > 0) return { ...report, status: "stillQuarantined" }

  const changed =
    report.needsFinalization.length > 0 ||
    report.quarantined.length > 0 ||
    report.slotsReleased.length > 0 ||
    report.derivedDataCleaned.length > 0 ||
    report.quarantineCleared
  return { ...report, status: changed ? "recovered" : "alreadyHealthy" }
}

function withoutActive(state: QueueState): QueueState {
  const next = { ...state }
  delete next.activeRunId
  return next
}

type RunOutcome = "finalizable" | "busy" | "uncertain"

function classify(environment: RecoveryEnvironment, record: RunRecord): RunOutcome {
  const { probe } = environment

  // A live owner is still driving this run — including through the window
  // between the supervisor exiting and the summary being published, where no
  // child and no supervisor exist but the run is not finished.
  if (record.owner !== undefined && !allIdentitiesGone(probe, [record.owner])) return "busy"

  // An admitted run with no durable supervisor identity proves, by protocol
  // invariant, that Xcode was never started: the supervisor publishes its
  // identity before it may create the future child.
  if (record.state === "admitted" && record.supervisor === undefined) return "finalizable"

  if (record.child !== undefined) {
    // A live, identity-validated member means an active run. Recovery never
    // interrupts one.
    if (signallingIsSafe(probe, { pgid: record.child.pgid, processes: [record.child] })) return "busy"
  }

  if (record.supervisor !== undefined) {
    const current = probe.identify(record.supervisor.pid)
    if (current !== undefined && current.startedAt === record.supervisor.startedAt) return "busy"
  }

  // Numeric PGID reuse alone must not preserve quarantine forever, so a group
  // whose recorded identities are all gone is reconciled even if the number is
  // now in use by something unrelated.
  return allIdentitiesGone(probe, recordedIdentities(record)) ? "finalizable" : "uncertain"
}

/**
 * Quarantine clears once nothing is attributable to the run that caused it and
 * that run is durably finished.
 *
 * Deliberately **not** conditioned on the record's own `quarantined` flag. That
 * flag says why the root was held — the lifecycle could not be confirmed at the
 * time — and a run that was never confirmed is exactly the kind that ends up
 * quarantined. Refusing to clear while it is set means the root is held for as
 * long as the artifacts exist, which is the same practical outcome as a tool
 * that stopped working, with no way out but deleting state by hand.
 *
 * What replaces it is a fresh answer to the only question that matters now: is
 * anything still running that belongs to this run?
 */
function canClearQuarantine(environment: RecoveryEnvironment, runId: string): boolean {
  const record = readRunRecord(environment.storage, runId)
  if (record === undefined) {
    // Nothing to attribute and no identities to validate. Holding a root
    // forever over a run whose artifacts no longer exist is the one failure
    // mode quarantine must not have; a run whose directory is still there but
    // unreadable is corruption, and keeps the root held.
    return !existsSync(runDirectory(environment.storage, runId))
  }
  // An unfinished run is not cleared by this path: it is either finalizable,
  // and the caller has to publish its summary first, or uncertain, and it is
  // already holding the root on its own account.
  if (record.state !== "completed") return false
  return !stillAttributable(environment, record)
}

/**
 * Whether anything belonging to this **completed** run may still be running.
 *
 * Both callers ask only about completed runs, and that is what makes the set
 * of processes worth asking about smaller than it first looks.
 *
 * The owner is deliberately not among them. It is the OpenCode process that
 * started the run — ordinarily the editor the user is still sitting in front
 * of, which will outlive the run by hours. While the run is unfinished a live
 * owner means someone is still driving it, and `classify` says so; once the
 * run is durably completed there is nothing left to drive, and holding the
 * root on the owner's account would mean a quarantine that cannot clear until
 * the user quits their editor. That is the failure mode quarantine must not
 * have, wearing the costume of caution.
 *
 * What is left is the two recorded processes that actually execute the run,
 * each checked by start identity so a reused PID number — ordinary on a busy
 * machine — never holds a root on its own.
 *
 * **Descendants are the hard case.** `xcodebuild` spawns processes this tool
 * never sees, and they are not recorded individually, so there are no
 * identities to ask about. When the run could not confirm they exited, the
 * absence of a recorded identity is *not* evidence of absence — reading it as
 * such would clear exactly the quarantine that condition exists to raise. What
 * can be asked is the process group: descendants inherit the gated child's
 * group, so an empty group is the one sound negative answer available, and it
 * is an answer that eventually arrives.
 */
function stillAttributable(environment: RecoveryEnvironment, record: RunRecord): boolean {
  const { probe } = environment

  if (
    record.child !== undefined &&
    signallingIsSafe(probe, { pgid: record.child.pgid, processes: [record.child] })
  ) {
    return true
  }
  if (!allIdentitiesGone(probe, recordedIdentities(record))) return true

  // Nothing recorded survives. If the run also never established that its
  // descendants had gone, the group is what is left to ask — but only while
  // the group is still ours to ask about.
  //
  // The gated child leads its own group, so the group's number is the child's
  // PID. A number now held by a process that is not the one recorded means it
  // was recycled, and its members are strangers: holding the root on their
  // account would keep it held for as long as an unrelated program happened to
  // own that number. A number that is simply free is different — a group
  // number cannot be reassigned while the group still has members, so anything
  // answering there is one of ours, still running, unrecorded.
  if (record.child !== undefined && record.descendantsConfirmedExited !== "yes") {
    if (probe.identify(record.child.pgid) !== undefined) return false
    return probe.membersOf(record.child.pgid).length > 0
  }

  return false
}

function recordedIdentities(record: RunRecord): ProcessIdentity[] {
  const identities: ProcessIdentity[] = []
  if (record.supervisor !== undefined) identities.push(record.supervisor)
  if (record.child !== undefined) identities.push(record.child)
  return identities
}

/**
 * Isolated DerivedData is a per-run scratch directory, not evidence, so it is
 * reclaimed once the run is durably completed — including after a crash that
 * happened between publication and cleanup. Shared DerivedData is a cache
 * across runs and is never touched here.
 */
export function reclaimIsolatedDerivedData(storage: Storage, record: RunRecord): boolean {
  if (record.derivedDataMode !== "isolated" || record.derivedDataCleaned === true) return false

  rmSync(join(runDirectory(storage, record.runId), RUN_ARTIFACTS.derivedData), {
    recursive: true,
    force: true,
  })
  writeRunRecord(storage, { ...record, derivedDataCleaned: true })
  return true
}

/** Quarantine the root's execution slot, holding it until recovery clears it. */
export function quarantineSlot(storage: Storage, runId: string, reason: string, since: string): void {
  withLock(storage.rootLock, () => {
    const state = readQueue(storage)
    const next = withoutActive(state)
    writeQueue(storage, { ...next, quarantine: { runId, reason, since } })
  })
}
