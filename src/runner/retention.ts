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

import { readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { writePrivateFileAtomic, type Storage } from "./paths.ts"
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
    const path = join(storage.runsDir, runId)
    if (!isDirectory(path)) continue

    const record = readRunRecord(storage, runId)
    const completedAtMs =
      record?.completedAt === undefined ? undefined : Date.parse(record.completedAt)

    runs.push({
      runId,
      ...(completedAtMs === undefined || Number.isNaN(completedAtMs) ? {} : { completedAtMs }),
      bytes: directorySize(path),
      evictable:
        record !== undefined &&
        record.state === "completed" &&
        record.quarantined !== true &&
        completedAtMs !== undefined &&
        !Number.isNaN(completedAtMs) &&
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
  const source = join(storage.runsDir, runId)
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
  return join(storage.tombstonesDir, `${runId}.json`)
}

export function readTombstone(storage: Storage, runId: string): Tombstone | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(tombstonePath(storage, runId), "utf8"))
    if (typeof parsed === "object" && parsed !== null && "runId" in parsed) return parsed as Tombstone
    return undefined
  } catch {
    return undefined
  }
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

  return { evicted: plan.evict, reasons: plan.reasons, tombstonesRemoved, retainedBytes }
}

/**
 * Apparent size, not allocated blocks — which is exactly what lets the byte-cap
 * tests use sparse files and exercise real accounting without consuming disk.
 */
export function directorySize(path: string): number {
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
      try {
        const stats = statSync(child)
        if (stats.isDirectory()) walk(child)
        else total += stats.size
      } catch {
        // A file that vanished mid-sweep contributes nothing, and is not an error.
      }
    }
  }
  walk(path)
  return total
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
