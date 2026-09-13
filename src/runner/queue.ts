/**
 * Durable cross-process FIFO admission (#3).
 *
 * V1 serializes Test Runs per trusted root regardless of DerivedData mode or
 * destination, because isolated DerivedData alone does not make concurrent
 * simulator, device, package-cache or runner-storage use trustworthy.
 *
 * The queue is durable and cross-process, so it survives a crashed instance and
 * coordinates two OpenCode instances against one worktree. The advisory lock is
 * held only for the short state transitions — never for the length of a run.
 */

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

import type { QueuedFailureReason } from "../domain/outcome.ts"
import { identityMatches, type ProcessIdentity, type ProcessProbe } from "./identity.ts"
import { withLock } from "./locks.ts"
import { newRunId, type Storage, writePrivateFileAtomic } from "./paths.ts"

/** Reconciliation runs before enrollment, under its own fixed deadline. */
export const RECONCILIATION_DEADLINE_MS = 60_000

/** The concurrency wait after enrollment. Queue time never consumes the Test Run timeout. */
export const CONCURRENCY_WAIT_DEADLINE_MS = 300_000

/** Free space required on the artifact volume before a run is admitted. */
export const MINIMUM_FREE_BYTES = 1024 ** 3

/** Bounded jittered polling: correctness never depends on a notification. */
export const POLL_INTERVAL_MS = 250
export const POLL_JITTER_MS = 100

export type Ticket = {
  /** Immutable and monotonic. It is what makes the queue a FIFO. */
  sequence: number
  ticketId: string
  owner: ProcessIdentity
  createdAt: string
  deadlineAtMs: number
}

export type Quarantine = { runId: string; reason: string; since: string }

export type QueueState = {
  schemaVersion: 1
  nextSequence: number
  tickets: Ticket[]
  /** The run currently holding the root's execution slot, if any. */
  activeRunId?: string
  quarantine?: Quarantine
}

const EMPTY: QueueState = { schemaVersion: 1, nextSequence: 1, tickets: [] }

export function readQueue(storage: Storage): QueueState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storage.queueFile, "utf8"))
    if (!isQueueState(parsed)) throw new Error("malformed")
    return parsed
  } catch (error) {
    if (isMissing(error)) return { ...EMPTY, tickets: [] }
    // Malformed, unsupported or inconsistent coordination state fails closed.
    // The suspect file is preserved rather than discarded.
    throw new CoordinationStateError()
  }
}

export class CoordinationStateError extends Error {
  constructor() {
    super("the durable coordination state could not be read")
    this.name = "CoordinationStateError"
  }
}

export function writeQueue(storage: Storage, state: QueueState): void {
  writePrivateFileAtomic(storage.queueFile, `${JSON.stringify(state, null, 2)}\n`)
}

export type AdmissionEnvironment = {
  storage: Storage
  probe: ProcessProbe
  /** Monotonic, for deadlines. Wall-clock time is used only for timestamps. */
  now(): number
  /** Wall-clock UTC, for the timestamps a result reports. */
  timestamp(): string
  /** Free bytes on the artifact volume. */
  freeBytes(): number
  owner: ProcessIdentity
  sleep(ms: number): Promise<void>
  /** Jitter source, injectable so tests are deterministic. */
  jitter?(): number
}

export type AdmissionResult =
  | {
      status: "admitted"
      runId: string
      admittedAt: string
      queuedAt: string
      queueDurationMs: number
    }
  | { status: "cancelled"; queuedAt: string; queueDurationMs: number }
  | {
      status: "failed"
      reason: QueuedFailureReason
      queuedAt: string
      queueDurationMs: number
    }

/**
 * Enroll and wait for the root's execution slot.
 *
 * `queuedAt` begins when the request first enters root coordination — before
 * reconciliation — so the reported queue duration covers everything the caller
 * actually waited through, not just the FIFO portion.
 */
export async function admit(
  environment: AdmissionEnvironment,
  options: { signal?: { aborted: boolean }; waitDeadlineMs?: number } = {},
): Promise<AdmissionResult> {
  const { storage } = environment
  const queuedAt = environment.timestamp()
  const enteredAt = environment.now()
  const queued = () => ({ queuedAt, queueDurationMs: environment.now() - enteredAt })

  if (options.signal?.aborted === true) return { status: "cancelled", ...queued() }

  if (environment.freeBytes() < MINIMUM_FREE_BYTES) {
    return { status: "failed", reason: "insufficientStorage", ...queued() }
  }

  const ticket = withLock(storage.rootLock, () => {
    const state = reap(environment, readQueue(storage))
    const allocated: Ticket = {
      sequence: state.nextSequence,
      ticketId: randomBytes(8).toString("hex"),
      owner: environment.owner,
      createdAt: queuedAt,
      deadlineAtMs:
        environment.now() + (options.waitDeadlineMs ?? CONCURRENCY_WAIT_DEADLINE_MS),
    }
    writeQueue(storage, {
      ...state,
      nextSequence: state.nextSequence + 1,
      tickets: [...state.tickets, allocated],
    })
    return allocated
  })

  const release = (result: AdmissionResult): AdmissionResult => {
    withLock(storage.rootLock, () => {
      const state = readQueue(storage)
      writeQueue(storage, {
        ...state,
        tickets: state.tickets.filter((entry) => entry.ticketId !== ticket.ticketId),
      })
    })
    return result
  }

  for (;;) {
    if (options.signal?.aborted === true) return release({ status: "cancelled", ...queued() })

    const attempt = withLock(storage.rootLock, (): AdmissionResult | undefined => {
      const state = reap(environment, readQueue(storage))

      if (state.quarantine !== undefined) {
        return { status: "failed", reason: "executionSlotQuarantined", ...queued() }
      }
      if (state.activeRunId !== undefined) return undefined

      // A newer eligible ticket must never overtake an older live one.
      const head = state.tickets[0]
      if (head === undefined || head.ticketId !== ticket.ticketId) return undefined

      const runId = newRunId()
      writeQueue(storage, {
        ...state,
        activeRunId: runId,
        tickets: state.tickets.filter((entry) => entry.ticketId !== ticket.ticketId),
      })
      return {
        status: "admitted",
        runId,
        admittedAt: environment.timestamp(),
        ...queued(),
      }
    })

    if (attempt !== undefined) {
      return attempt.status === "admitted" ? attempt : release(attempt)
    }

    if (environment.now() >= ticket.deadlineAtMs) {
      return release({ status: "failed", reason: "concurrencyWaitTimedOut", ...queued() })
    }

    const jitter = (environment.jitter?.() ?? 0) * POLL_JITTER_MS
    await environment.sleep(POLL_INTERVAL_MS + jitter)
  }
}

/** Release the execution slot once a run is durably completed or quarantined. */
export function releaseSlot(
  storage: Storage,
  runId: string,
  quarantine?: { reason: string; since: string },
): void {
  withLock(storage.rootLock, () => {
    const state = readQueue(storage)
    if (state.activeRunId !== runId) return
    const next: QueueState = { ...state, tickets: state.tickets }
    delete next.activeRunId
    if (quarantine !== undefined) next.quarantine = { runId, ...quarantine }
    writeQueue(storage, next)
  })
}

/** Clear quarantine. Only recovery calls this, and only when it is certain. */
export function clearQuarantine(storage: Storage): void {
  withLock(storage.rootLock, () => {
    const state = readQueue(storage)
    const next = { ...state }
    delete next.quarantine
    writeQueue(storage, next)
  })
}

/**
 * Drop tickets that are expired or whose owner is provably gone, preserving
 * order among the survivors.
 *
 * Liveness is decided by start identity, never by a heartbeat alone: a
 * heartbeat that stopped might mean a dead owner or a stalled one, and
 * abandoning a live caller's place in the queue is not recoverable.
 */
export function reap(environment: AdmissionEnvironment, state: QueueState): QueueState {
  const now = environment.now()
  const tickets = state.tickets.filter((ticket) => {
    if (ticket.deadlineAtMs <= now) return false
    if (identityMatches(ticket.owner, environment.owner)) return true
    const current = environment.probe.identify(ticket.owner.pid)
    return current !== undefined && identityMatches(current, ticket.owner)
  })

  return tickets.length === state.tickets.length ? state : { ...state, tickets }
}

function isQueueState(value: unknown): value is QueueState {
  if (typeof value !== "object" || value === null) return false
  const state = value as Partial<QueueState>
  return (
    state.schemaVersion === 1 &&
    typeof state.nextSequence === "number" &&
    Array.isArray(state.tickets)
  )
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  )
}
