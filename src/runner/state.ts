/**
 * Durable run state (#3).
 *
 * The states are monotonic, and that is the whole point: `launchAuthorized`
 * proves the supervisor persisted authorization *before* the gated child could
 * `exec`, which is what eliminates the spawn-to-record crash window. Recovery
 * reads these records after a crash and can reason about what must have
 * happened, because a state can only ever have moved forward.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { EvidenceFact } from "../domain/evidence.ts"
import type { ProcessTerminationTrigger } from "../domain/outcome.ts"
import type { ProcessIdentity } from "./identity.ts"
import { assertSafeFile, RUN_ARTIFACTS, runDirectory, type Storage, writePrivateFileAtomic } from "./paths.ts"

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
  timeoutSeconds: number
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
  const path = metadataPath(storage, runId)
  try {
    assertSafeFile(path)
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
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

function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<RunRecord>
  return (
    record.schemaVersion === 1 &&
    typeof record.runId === "string" &&
    typeof record.rootKey === "string" &&
    typeof record.state === "string" &&
    (RUN_STATES as readonly string[]).includes(record.state)
  )
}
