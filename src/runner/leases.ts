/**
 * Read leases over retained evidence (issue #116).
 *
 * Retention deletes completed runs, and inspection reads them. Nothing stood
 * between the two: user-wide housekeeping runs in whichever OpenCode instance
 * happens to reach the hour first, and it would evict a run that another
 * instance, in another window, was in the middle of paging through. The reader
 * gets `notFound` for evidence that existed when it asked — or worse, an
 * `ENOENT` part-way through a Result Bundle it had already started reading.
 *
 * A lease is a file, because the two processes share nothing else. A set held
 * in memory would be a claim one instance makes to itself, and the instance
 * doing the deleting is the other one.
 *
 * Two rules make it safe to act on:
 *
 * **It expires.** An inspection is one call and takes seconds; a lease lasts a
 * minute. A holder that crashes mid-read therefore pins evidence for at most
 * that minute, which is what makes this need no process probe and no recovery
 * pass of its own. The alternative — liveness by PID — has to be identity-safe
 * to be worth anything, and PID reuse would make a lease outlive its holder in
 * exactly the case it is supposed to cover.
 *
 * **Anything unreadable counts as held.** A lease file this code cannot parse
 * is not evidence that nothing is being read; it is evidence that something is
 * wrong. Deletion is irreversible and waiting is not, so an unreadable lease
 * blocks eviction — until it too ages past the lifetime, after which it is
 * garbage rather than a lease, and is removed.
 */

import { randomBytes } from "node:crypto"
import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { isRecord } from "../domain/json.ts"
import {
  createPrivateDirectory,
  isRunId,
  readPrivateFile,
  UnknownRunError,
  writePrivateFileAtomic,
  type Storage,
} from "./paths.ts"

/**
 * How long a published lease is believed.
 *
 * Long enough that no inspection reaches the end of it — the tool's own
 * budgets are far shorter — and short enough that a crashed inspector costs
 * one housekeeping pass rather than a root's storage for ever.
 */
export const LEASE_LIFETIME_MS = 60_000

export type LeaseFile = { schemaVersion: 1; runId: string; expiresAtMs: number }

/** A published lease. Releasing twice is not an error; nothing else is either. */
export type ReadLease = { release(): void }

/** What the leases under one root say about what may be deleted. */
export type LeaseState = {
  /** Runs a live lease names. */
  runs: ReadonlySet<string>
  /**
   * Set when something here is held but could not be read: a malformed file,
   * one this code has no version for, a directory that cannot be listed. It
   * means "do not delete anything in this root", because the one thing not
   * known is which run is being read.
   */
  uncertain: boolean
}

/** True when anything at all is holding this root's evidence. */
export function anyLeaseHeld(state: LeaseState): boolean {
  return state.uncertain || state.runs.size > 0
}

/**
 * Publish a lease over `runId` before reading anything of its.
 *
 * Published before the first read and released after the last, so the window
 * it covers is the whole inspection — including a lazy Result Bundle
 * extraction, which is the longest read there is and the one whose failure
 * mid-way is hardest to describe to a caller.
 *
 * It does not close the *other* window: a lease published after a
 * housekeeping pass has already read this root is not seen by that pass. The
 * inspection then meets the storage it would have met before any of this
 * existed, which is the honest bound on what a lease can promise — it
 * protects a read already under way, not one about to start.
 *
 * The clock is wall-clock and defaulted here rather than injected at the call
 * site. The reader of this file is another process comparing it against its
 * own `Date.now()`, so a caller whose clock is fixed or monotonic would
 * publish a lease that is already expired — no protection, and no error to
 * say so.
 *
 * Never throws for an I/O failure. A lease that cannot be written is a
 * missing guarantee, not a reason to refuse an inspection that would
 * otherwise succeed: without it the caller is exactly where they were before
 * this existed. An unusable `runId` is different, and is refused — it is a
 * defect in the caller, and this file's name is a path.
 */
export function acquireReadLease(storage: Storage, runId: string, nowMs = Date.now()): ReadLease {
  if (!isRunId(runId)) throw new UnknownRunError()

  const path = join(storage.leasesDir, `${runId}.${randomBytes(8).toString("hex")}.json`)
  const lease: LeaseFile = { schemaVersion: 1, runId, expiresAtMs: nowMs + LEASE_LIFETIME_MS }

  try {
    // Created here rather than assumed: a root written before leases existed
    // has no such directory, and a lease that silently fails to publish is
    // indistinguishable from one nobody needed.
    createPrivateDirectory(storage.leasesDir)
    writePrivateFileAtomic(path, `${JSON.stringify(lease)}\n`)
  } catch {
    return { release() {} }
  }

  return {
    release() {
      try {
        rmSync(path, { force: true })
      } catch {
        // It expires on its own. A release that failed costs a minute of a
        // run's eviction eligibility, which is not worth failing an
        // inspection that has already answered.
      }
    },
  }
}

/**
 * What is currently leased under one root, sweeping what no longer is.
 *
 * Named for the sweeping as well as the reading, because it does both: an
 * expired lease is removed as it is passed over, which is the whole of the
 * reconciling an abandoned lease needs. The holder said when it would stop
 * mattering, and that moment has passed — no probe, and no second pass to
 * arrange one.
 */
export function reconcileLeases(storage: Storage, nowMs: number): LeaseState {
  const runs = new Set<string>()
  let uncertain = false

  let names: string[]
  try {
    names = readdirSync(storage.leasesDir)
  } catch (error) {
    // A missing directory is no leases — this root has never been inspected,
    // or predates them. Anything else is a directory that exists and cannot
    // be listed, which is not the same fact at all.
    return { runs, uncertain: !isAbsent(error) }
  }

  for (const name of names) {
    const path = join(storage.leasesDir, name)
    const lease = readLease(path)

    if (lease === undefined) {
      // Unreadable. Recent enough to be somebody's lease, or old enough to be
      // nobody's — and the second is the only reason this cannot pin a root
      // for ever on one corrupt file.
      if (ageOf(path, nowMs) <= LEASE_LIFETIME_MS) uncertain = true
      else sweep(path)
      continue
    }

    if (lease.expiresAtMs <= nowMs) {
      sweep(path)
      continue
    }
    runs.add(lease.runId)
  }

  return { runs, uncertain }
}

function readLease(path: string): LeaseFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readPrivateFile(path))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const candidate = parsed as Partial<LeaseFile>
  if (candidate.schemaVersion !== 1) return undefined
  if (!isRunId(candidate.runId)) return undefined
  if (typeof candidate.expiresAtMs !== "number" || !Number.isFinite(candidate.expiresAtMs)) {
    return undefined
  }
  return candidate as LeaseFile
}

/**
 * How long ago this file was last written, or `0` when that cannot be told.
 *
 * Zero rather than infinity: a file whose age is unknowable is treated as
 * new, so it holds the root rather than being swept. The unreadable case is
 * the one that has to fail closed.
 */
function ageOf(path: string, nowMs: number): number {
  try {
    return nowMs - statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function sweep(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Another instance swept it first, or it is not ours to remove. Either
    // way it is expired, and an expired lease holds nothing.
  }
}

function isAbsent(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT"
}
