/**
 * Durable run state (#3).
 *
 * The states are monotonic, and that is the whole point: `launchAuthorized`
 * proves the supervisor persisted authorization *before* the gated child could
 * `exec`, which is what eliminates the spawn-to-record crash window. Recovery
 * reads these records after a crash and can reason about what must have
 * happened, because a state can only ever have moved forward.
 */

import { join } from "node:path"

import type { EvidenceFact } from "../domain/evidence.ts"
import { isRecord } from "../domain/json.ts"
import type { ResolvedTestRun } from "../domain/request.ts"
import type { RequestedScope } from "../domain/scope.ts"
import type { ProcessTerminationTrigger } from "../domain/outcome.ts"
import type { ProcessIdentity } from "./identity.ts"
import {
  isRootKey,
  isRunId,
  readPrivateFile,
  RUN_ARTIFACTS,
  runDirectory,
  writePrivateFileAtomic,
  type Storage,
} from "./paths.ts"

export const RUN_STATES = [
  "admitted",
  "supervisorReady",
  "childRecorded",
  "launchAuthorized",
  "executionCompleted",
  "completed",
] as const

export type RunState = (typeof RUN_STATES)[number]

/** A state may only ever move forward. A backwards write is a defect. */
export function isMonotonicTransition(from: RunState, to: RunState): boolean {
  return RUN_STATES.indexOf(to) > RUN_STATES.indexOf(from)
}

export type ChildRecord = ProcessIdentity & { pgid: number }

export type RunRecord = {
  schemaVersion: 1
  runId: string
  rootKey: string
  state: RunState
  admittedAt: string
  /** Recorded so a recovered run can report what it really waited, not zero. */
  queueDurationMs?: number
  timeoutSeconds: number
  /**
   * The resolved contract and the Requested Scope, recorded at admission.
   *
   * Recovery has to be able to publish a terminal summary for a run whose
   * process is long gone, and a summary needs to say what was asked for. A
   * record that did not carry this would leave a recovered run describable only
   * as "something happened here".
   */
  resolved?: ResolvedTestRun
  requestedScope?: RequestedScope
  /**
   * The process that admitted this run and is driving it to completion.
   *
   * Between the supervisor exiting and the summary being published there is a
   * window in which no child and no supervisor are alive, but the run is very
   * much in progress. Without an owner identity, recovery would see a dead
   * lifecycle, adopt the run, and publish a second terminal summary alongside
   * the one its owner is already writing.
   */
  owner?: ProcessIdentity
  supervisor?: ProcessIdentity
  child?: ChildRecord
  /** Present exactly when `launchAuthorized` was reached. */
  startedAt?: string
  terminationTrigger?: ProcessTerminationTrigger
  execObserved?: EvidenceFact
  descendantsConfirmedExited?: EvidenceFact
  exitCode?: number
  signal?: string
  completedAt?: string
  /** Set when the lifecycle could not be confirmed and the slot is held. */
  quarantined?: boolean
  quarantineReason?: string
  /** Set when the caller cancelled while interpretation was already running. */
  cancelledDuringInterpretation?: boolean
  derivedDataMode?: "shared" | "isolated"
  /**
   * The runtime that ran this run's supervisor, and the host that asked for
   * it. Recorded durably so a report can name them after the fact; the path is
   * machine-local and never reaches a model-facing result.
   */
  runtimePath?: string
  runtimeVersion?: string
  hostVersion?: string
  /**
   * The Result Bundle digest recorded at stabilization. A later read compares
   * against it to say whether it is looking at the same bytes.
   */
  bundleDigest?: string
  /**
   * Whether the digest still matched when the run was published. Recorded so
   * retention can flag a bundle that changed underneath a completed run rather
   * than quietly evicting it as if nothing had happened.
   */
  bundleDigestVerified?: "yes" | "no" | "unknown"
  /** Isolated DerivedData has been reclaimed; retention may then evict the run. */
  derivedDataCleaned?: boolean
}

export function metadataPath(storage: Storage, runId: string): string {
  return join(runDirectory(storage, runId), RUN_ARTIFACTS.metadata)
}

export function writeRunRecord(storage: Storage, record: RunRecord): void {
  writePrivateFileAtomic(metadataPath(storage, record.runId), `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * Read a run record. Malformed or unreadable state is never guessed at — the
 * caller treats `undefined` as a reason to fail closed, not as an empty run.
 */
export function readRunRecord(storage: Storage, runId: string): RunRecord | undefined {
  try {
    // Inside the `try`: deriving the path is itself a validation step, and a
    // handle that cannot address storage must read as "no record", not as a
    // thrown error escaping a function whose whole contract is to return one.
    const parsed: unknown = JSON.parse(readPrivateFile(metadataPath(storage, runId)))
    return isRunRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Advance a run's state, refusing any transition that is not forward. */
export function advance(
  storage: Storage,
  record: RunRecord,
  to: RunState,
  fields: Partial<RunRecord> = {},
): RunRecord {
  if (!isMonotonicTransition(record.state, to)) {
    throw new Error(`a run may not move from ${record.state} back to ${to}`)
  }
  const next: RunRecord = { ...record, ...fields, state: to }
  writeRunRecord(storage, next)
  return next
}

/**
 * Validate the record, nested process identities included.
 *
 * The fields here are not merely described by this file — they are acted on.
 * `child.pgid` reaches `signalGroup`, `supervisor` and `owner` decide whether
 * recovery adopts a run, and `runId` addresses a directory. A check that
 * confirmed only the four top-level fields would let a corrupted or planted
 * `metadata.json` send a signal to a process group of its own choosing, which
 * is the sharpest thing anything in this codebase does.
 */
function isRunRecord(value: unknown): value is RunRecord {
  if (!isRecord(value)) return false
  const record = value as Partial<RunRecord>

  return (
    record.schemaVersion === 1 &&
    isRunId(record.runId) &&
    isRootKey(record.rootKey) &&
    typeof record.state === "string" &&
    (RUN_STATES as readonly string[]).includes(record.state) &&
    typeof record.admittedAt === "string" &&
    typeof record.timeoutSeconds === "number" &&
    (record.owner === undefined || isProcessIdentity(record.owner)) &&
    (record.supervisor === undefined || isProcessIdentity(record.supervisor)) &&
    (record.child === undefined || isChildRecord(record.child))
  )
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value)) return false
  return (
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string"
  )
}

/**
 * A process group is signalled by this number, so it is checked like one:
 * an integer greater than one. Zero and negative values are not identifiers
 * at all to `kill(2)` — they select the caller's own group, or every process
 * the user may signal.
 */
function isChildRecord(value: unknown): value is ChildRecord {
  return isProcessIdentity(value) && Number.isInteger(value.pgid) && (value.pgid as number) > 1
}
