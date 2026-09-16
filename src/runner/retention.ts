/**
 * Retention, eviction and tombstones (#3).
 *
 * Diagnostics are worth keeping only while they are still about work someone
 * cares about, and storage is not free. The limits below are therefore a mix of
 * hard rules and soft targets, and the difference matters:
 *
 * - **Age and count are hard.** A run older than seven days is evicted even if
 *   it is the newest, the only, and an oversized one.
 * - **Byte limits are soft targets.** A root always keeps its newest completed
 *   run, because evicting the evidence a caller is about to inspect in order to
 *   satisfy a storage goal is the wrong trade.
 *
 * Eviction publishes a tombstone *before* deleting, so an inspection of an
 * evicted run reports `expired` rather than a misleading `notFound`.
 */

import { lstatSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"

import { isRecord } from "../domain/json.ts"
import {
  isRunId,
  readPrivateFile,
  runDirectory,
  UnknownRunError,
  writePrivateFileAtomic,
  type Storage,
} from "./paths.ts"
import { readRunRecord } from "./state.ts"

export const RETENTION = {
  /** Completed runs retained per trusted root. */
  maxCompletedRuns: 20,
  /** Time from completion. Hard: age evicts regardless of every other rule. */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Soft byte target per trusted root. */
  perRootByteTarget: 5 * 1024 ** 3,
  /** Soft byte target across every root's completed artifacts. */
  userWideByteTarget: 20 * 1024 ** 3,
  tombstoneLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  maxTombstones: 10_000,
} as const

export type RetainedRun = {
  runId: string
  /** Wall-clock milliseconds. Absent for a run that never completed. */
  completedAtMs?: number
  bytes: number
  /** Active, unfinished, quarantined and read-leased runs are never evicted. */
  evictable: boolean
  /**
   * Whether this run's Result Bundle still matched its recorded digest. A
   * mutated bundle is still evictable — it is retention's business to reclaim
   * it — but the mutation is surfaced rather than passing unremarked.
   */
  bundleDigestVerified?: "yes" | "no" | "unknown"
}

export type Tombstone = { schemaVersion: 1; runId: string; expiresAtMs: number }

export type RetentionEnvironment = {
  storage: Storage
  /** Wall-clock milliseconds. Injectable so age is testable without waiting. */
  now(): number
  /** Runs currently held by an inspection read lease. */
  leased?: ReadonlySet<string>
  /** The active run, which holds the execution slot and is never evictable. */
  activeRunId?: string
}

export type RetentionReport = {
  evicted: string[]
  reasons: Record<string, "age" | "count" | "perRootBytes" | "userWideBytes">
  tombstonesRemoved: string[]
  retainedBytes: number
  /** Retained runs whose Result Bundle changed after it was published. */
  mutatedBundles: string[]
}

/** Read every run directory, classifying what may be evicted and what may not. */
export function collectRuns(environment: RetentionEnvironment): RetainedRun[] {
  const { storage } = environment
  let entries: string[]
  try {
    entries = readdirSync(storage.runsDir).sort()
  } catch {
    return []
  }

  const runs: RetainedRun[] = []
  for (const runId of entries) {
    // A name that could not address storage is not a run of ours, whatever
    // put it here. Skipping it keeps retention from ever deleting, counting
    // or reporting something it does not own.
    if (!isRunId(runId)) continue

    const path = runDirectory(storage, runId)
    if (!isDirectory(path)) continue

    const record = readRunRecord(storage, runId)
    const completedAtMs =
      record?.completedAt === undefined ? undefined : Date.parse(record.completedAt)

    runs.push({
      runId,
      ...(completedAtMs === undefined || Number.isNaN(completedAtMs) ? {} : { completedAtMs }),
      bytes: directorySize(path),
      ...(record?.bundleDigestVerified === undefined
        ? {}
        : { bundleDigestVerified: record.bundleDigestVerified }),
      evictable:
        record !== undefined &&
        record.state === "completed" &&
        record.quarantined !== true &&
        completedAtMs !== undefined &&
        !Number.isNaN(completedAtMs) &&
        // Eligibility begins only once isolated DerivedData has been reclaimed.
        // Evicting before then would delete the run's record and leave the
        // scratch directory behind with nothing left to attribute it to.
        (record.derivedDataMode !== "isolated" || record.derivedDataCleaned === true) &&
        environment.leased?.has(runId) !== true &&
        environment.activeRunId !== runId,
    })
  }

  return runs
}

/**
 * Decide what to evict. Oldest completed runs go first, and the newest
 * completed run is protected from the byte targets only.
 */
export function planEviction(
  runs: RetainedRun[],
  environment: { now(): number; userWideBytes?: number },
): { evict: string[]; reasons: RetentionReport["reasons"] } {
  const reasons: RetentionReport["reasons"] = {}
  const evictable = runs
    .filter((run) => run.evictable)
    .sort((a, b) => (a.completedAtMs ?? 0) - (b.completedAtMs ?? 0))

  const newest = evictable[evictable.length - 1]
  const now = environment.now()

  for (const run of evictable) {
    if (now - (run.completedAtMs ?? 0) > RETENTION.maxAgeMs) reasons[run.runId] = "age"
  }

  const surviving = () => evictable.filter((run) => reasons[run.runId] === undefined)

  // Count is hard, and applies after age has already removed what it will.
  for (const run of surviving()) {
    if (surviving().length <= RETENTION.maxCompletedRuns) break
    reasons[run.runId] = "count"
  }

  const bytesOf = (runs_: RetainedRun[]) => runs_.reduce((total, run) => total + run.bytes, 0)
  const protectedRunId = newest?.runId

  for (const run of surviving()) {
    if (bytesOf(surviving()) <= RETENTION.perRootByteTarget) break
    if (run.runId === protectedRunId) continue
    reasons[run.runId] = "perRootBytes"
  }

  if (environment.userWideBytes !== undefined) {
    let userWide = environment.userWideBytes
    for (const run of surviving()) {
      if (userWide <= RETENTION.userWideByteTarget) break
      if (run.runId === protectedRunId) continue
      reasons[run.runId] = "userWideBytes"
      userWide -= run.bytes
    }
  }

  return { evict: Object.keys(reasons).sort(), reasons }
}

/**
 * Move a run into private trash, publish its tombstone, then delete.
 *
 * The order is the guarantee: trash continues to count toward byte targets
 * until deletion succeeds, and a crash between the move and the tombstone is
 * detectable — trash without a tombstone means "publish the tombstone first,
 * then resume deleting".
 */
export function evictRun(storage: Storage, runId: string, nowMs: number): void {
  // This function ends in a recursive delete, so the identifier is validated
  // before either path exists. `runDirectory` does it for the source; the
  // trash path is derived only once that has passed.
  const source = runDirectory(storage, runId)
  const trashed = join(storage.trashDir, runId)

  if (isDirectory(source)) renameSync(source, trashed)
  publishTombstone(storage, runId, nowMs)
  rmSync(trashed, { recursive: true, force: true })
}

export function publishTombstone(storage: Storage, runId: string, nowMs: number): void {
  const tombstone: Tombstone = {
    schemaVersion: 1,
    runId,
    expiresAtMs: nowMs + RETENTION.tombstoneLifetimeMs,
  }
  writePrivateFileAtomic(tombstonePath(storage, runId), `${JSON.stringify(tombstone)}\n`)
}

export function tombstonePath(storage: Storage, runId: string): string {
  if (!isRunId(runId)) throw new UnknownRunError()
  return join(storage.tombstonesDir, `${runId}.json`)
}

/**
 * A tombstone, or `undefined` if there is not a well-formed one.
 *
 * Every field is checked rather than the presence of `runId` alone: the value
 * that matters here is `expiresAtMs`, which sweeping sorts and compares — a
 * missing or non-numeric one would make `NaN` the comparison key and quietly
 * rearrange what gets deleted.
 */
export function readTombstone(storage: Storage, runId: string): Tombstone | undefined {
  try {
    const parsed: unknown = JSON.parse(readPrivateFile(tombstonePath(storage, runId)))
    return isTombstone(parsed) && parsed.runId === runId ? parsed : undefined
  } catch {
    return undefined
  }
}

function isTombstone(value: unknown): value is Tombstone {
  if (!isRecord(value)) return false
  const tombstone = value as Partial<Tombstone>
  return (
    tombstone.schemaVersion === 1 &&
    typeof tombstone.runId === "string" &&
    typeof tombstone.expiresAtMs === "number" &&
    Number.isFinite(tombstone.expiresAtMs)
  )
}

/** Expire tombstones by age, then by count, oldest first. */
export function sweepTombstones(storage: Storage, nowMs: number): string[] {
  let entries: string[]
  try {
    entries = readdirSync(storage.tombstonesDir)
  } catch {
    return []
  }

  const tombstones = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(isRunId)
    .map((runId) => ({ runId, tombstone: readTombstone(storage, runId) }))
    .filter((entry): entry is { runId: string; tombstone: Tombstone } => entry.tombstone !== undefined)
    .sort((a, b) => a.tombstone.expiresAtMs - b.tombstone.expiresAtMs)

  const removed: string[] = []
  const surviving: typeof tombstones = []

  for (const entry of tombstones) {
    if (entry.tombstone.expiresAtMs <= nowMs) {
      removed.push(entry.runId)
      continue
    }
    surviving.push(entry)
  }

  const excess = surviving.length - RETENTION.maxTombstones
  for (let index = 0; index < excess; index += 1) {
    const entry = surviving[index]
    if (entry !== undefined) removed.push(entry.runId)
  }

  for (const runId of removed) rmSync(tombstonePath(storage, runId), { force: true })
  return removed.sort()
}

/**
 * Reconcile trash left behind by a crash: a trashed run without a tombstone
 * gets one published before deletion resumes, so it can never be mistaken for a
 * run that was never known.
 */
export function reconcileTrash(storage: Storage, nowMs: number): string[] {
  let entries: string[]
  try {
    entries = readdirSync(storage.trashDir).sort()
  } catch {
    return []
  }

  const reconciled: string[] = []
  for (const runId of entries) {
    // Trash is deleted recursively; anything not named like a run of ours is
    // left exactly where it is.
    if (!isRunId(runId)) continue
    if (readTombstone(storage, runId) === undefined) {
      publishTombstone(storage, runId, nowMs)
      reconciled.push(runId)
    }
    rmSync(join(storage.trashDir, runId), { recursive: true, force: true })
  }
  return reconciled
}

export function runRetention(environment: RetentionEnvironment & { userWideBytes?: number }): RetentionReport {
  const nowMs = environment.now()
  reconcileTrash(environment.storage, nowMs)

  const runs = collectRuns(environment)
  const plan = planEviction(runs, environment)
  for (const runId of plan.evict) evictRun(environment.storage, runId, nowMs)

  const tombstonesRemoved = sweepTombstones(environment.storage, nowMs)
  const retainedBytes = runs
    .filter((run) => !plan.evict.includes(run.runId))
    .reduce((total, run) => total + run.bytes, 0)

  const mutatedBundles = runs
    .filter((run) => run.bundleDigestVerified === "no")
    .map((run) => run.runId)
    .sort()

  return {
    evicted: plan.evict,
    reasons: plan.reasons,
    tombstonesRemoved,
    retainedBytes,
    mutatedBundles,
  }
}

/**
 * Apparent size, not allocated blocks — which is exactly what lets the byte-cap
 * tests use sparse files and exercise real accounting without consuming disk.
 *
 * Every entry is examined with `lstat` and symbolic links are skipped outright,
 * for two independent reasons: a link into someone else's data would make
 * retention account for — and then evict against — bytes it does not own, and
 * a link back to an ancestor would make this walk never finish.
 */
export function directorySize(path: string, keep: (path: string) => boolean = () => true): number {
  let total = 0
  const walk = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(current, entry)
      // What is measured has to be what would be copied, or a caller that
      // excludes a build cache from the copy still sizes it in — and discards
      // sets that would have fitted.
      if (!keep(child)) continue
      try {
        const stats = lstatSync(child)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) walk(child)
        else if (stats.isFile()) total += stats.size
      } catch {
        // A file that vanished mid-sweep contributes nothing, and is not an error.
      }
    }
  }
  walk(path)
  return total
}

/** A real directory, never a link that points at one. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
