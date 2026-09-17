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

import { lstatSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { isRecord } from "../domain/json.ts"
import {
  isRootKey,
  isRunId,
  readPrivateFile,
  runDirectory,
  sharedCacheRoot,
  UnknownRunError,
  writePrivateFileAtomic,
  type Storage,
} from "./paths.ts"
import { readQueue } from "./queue.ts"
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
  /**
   * Time from last use before a shared build cache is reclaimed.
   *
   * Longer than a run's own retention, because the two are different things.
   * Evidence is kept so a caller can read it; a cache is kept so the next
   * build is fast, and a cache for a container nobody has built in a
   * fortnight is buying a speed-up nobody is waiting for.
   */
  cacheMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
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
  /**
   * Set when something has established that no process attributable to this
   * root is alive (issue #110).
   *
   * The build-cache guard is about a build *writing* into a cache, and the
   * execution slot is a proxy for that — a good one while a run is in flight,
   * and a permanent one after a run crashes. A slot held by a run that has no
   * live process is a run waiting to be finalized, not a build in progress,
   * and nothing is writing into its cache.
   *
   * Only recovery can say this, because saying it needs a process probe. So
   * it arrives as a fact from a caller that asked recovery, and its absence
   * means the slot is believed — which is the conservative answer and the one
   * this had before.
   */
  nothingIsRunning?: boolean
}

export type RetentionReport = {
  evicted: string[]
  reasons: Record<string, "age" | "count" | "perRootBytes" | "userWideBytes">
  tombstonesRemoved: string[]
  /**
   * Every tool-owned byte this root still holds: retained runs **and** the
   * shared build caches beside them (issue #96).
   *
   * It used to be the runs alone, which made the byte targets a bound on an
   * eighth of what the tool occupied — 5.0 GB accounted for against 34.3 GB of
   * DerivedData in the same tree. A cap computed over part of what it is
   * capping is not a cap.
   */
  retainedBytes: number
  /** Of `retainedBytes`, what the shared build caches account for. */
  cacheBytes: number
  /**
   * Shared build caches reclaimed, by opaque container key.
   *
   * Reported apart from `evicted` because they are not the same event. An
   * evicted run is evidence someone may have wanted; a reclaimed cache costs
   * the next build its warm start and nothing else (AC5).
   */
  cachesReclaimed: string[]
  cacheBytesReclaimed: number
  /** Retained runs whose Result Bundle changed after it was published. */
  mutatedBundles: string[]
}

/** One shared build cache: a container key, its bytes, and when it was used. */
export type SharedCache = { key: string; path: string; bytes: number; modifiedMs: number }

/**
 * The shared build caches under one root.
 *
 * Only directories named by a well-formed key are counted, for the reason the
 * roots sweep applies the same rule: these paths are deleted, and anything
 * else that happens to sit here must not be able to inflate a byte total or to
 * be walked at all.
 */
export function sharedCaches(storage: Storage): SharedCache[] {
  const cacheRoot = sharedCacheRoot(storage)
  let entries: string[]
  try {
    entries = readdirSync(cacheRoot).sort()
  } catch {
    return []
  }

  const caches: SharedCache[] = []
  for (const key of entries) {
    // A container key is a SHA-256 digest, exactly as a root key is, and is
    // checked by the same function for the same reason: it names a directory
    // this recursively deletes.
    if (!isRootKey(key)) continue
    const path = join(cacheRoot, key)
    if (!isDirectory(path)) continue
    try {
      caches.push({ key, path, bytes: directorySize(path), modifiedMs: statSync(path).mtimeMs })
    } catch {
      // A cache that vanished mid-sweep is a cache already reclaimed.
    }
  }
  return caches
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

  // Caches first, and that order is the whole design (issue #96). A build
  // cache is a warm start `xcodebuild` rebuilds on demand; a Result Bundle is
  // evidence a caller asked for and nothing can regenerate. Reclaiming after
  // eviction meant the byte targets — which now count caches — evicted
  // evidence to make room for bytes the very next step was about to give back,
  // trading the unregenerable for the regenerable.
  //
  // Age and count are untouched by this: they are hard rules about evidence,
  // and no amount of cache reclamation makes an eight-day-old run young.
  const reclaimed = reclaimCaches(
    environment,
    runs.reduce((total, run) => total + run.bytes, 0),
    nowMs,
  )

  const plan = planEviction(runs, {
    ...environment,
    ...(environment.userWideBytes === undefined
      ? {}
      : { userWideBytes: environment.userWideBytes - reclaimed.bytesReclaimed }),
  })
  for (const runId of plan.evict) evictRun(environment.storage, runId, nowMs)

  const tombstonesRemoved = sweepTombstones(environment.storage, nowMs)
  const runBytes = runs
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
    retainedBytes: runBytes + reclaimed.cacheBytes,
    cacheBytes: reclaimed.cacheBytes,
    cachesReclaimed: reclaimed.keys,
    cacheBytesReclaimed: reclaimed.bytesReclaimed,
    mutatedBundles,
  }
}

/**
 * Whether a run holds this root's execution slot.
 *
 * Fails closed, unreadable coordination state included: a root whose queue
 * cannot be read is a root nothing can say is idle, and reclaiming a cache a
 * build may be writing into is not the way to find out. It is also not a
 * reason to fail retention — the runs beside it are still worth sweeping.
 */
function slotIsHeld(storage: Storage): boolean {
  try {
    return readQueue(storage).activeRunId !== undefined
  } catch {
    return true
  }
}

/**
 * Reclaim shared build caches, and report what is left (issue #96).
 *
 * Run **after** eviction, and only against what eviction could not bring
 * inside the target — evidence is what a caller asked for, and a cache is a
 * speed-up. Reclaiming the cache first would trade something nobody can
 * regenerate for something `xcodebuild` rebuilds on demand.
 *
 * Age applies on its own, the way it does to runs: a cache for a container
 * nobody has built in a fortnight is buying a warm start nobody is waiting
 * for, whatever the byte totals say.
 *
 * Nothing is reclaimed while a build may be writing into a cache. A cache is
 * safe to delete because it is regenerable, not because it is idle, and that
 * one moment is the exception.
 *
 * The execution slot is the proxy for it, and a good one only while a run is
 * in flight: a run that crashed leaves the slot held for ever, and every later
 * pass reads it and declines (issue #110). So a caller that has asked recovery
 * whether anything attributable to this root is still alive can say so, and
 * that answer outranks the slot — a slot held by a run with no live process is
 * a run waiting to be finalized, not a build in progress.
 */
function reclaimCaches(
  environment: RetentionEnvironment & { userWideBytes?: number },
  runBytes: number,
  nowMs: number,
): { keys: string[]; bytesReclaimed: number; cacheBytes: number } {
  const caches = sharedCaches(environment.storage)
  const total = () => caches.reduce((sum, cache) => sum + cache.bytes, 0)

  // Read off the queue, not off the caller (issue #96). The root lock is held
  // around admission transitions and **not** for a build's duration, so a
  // housekeeping pass that reached this root proves only that nothing was
  // changing the queue at that instant — `xcodebuild` may be writing into one
  // of these directories right now. The execution slot in `queue.json` is the
  // fact that actually says so, and it is the fact every other path uses.
  const held =
    environment.activeRunId !== undefined ||
    (environment.nothingIsRunning !== true && slotIsHeld(environment.storage))
  if (held) {
    return { keys: [], bytesReclaimed: 0, cacheBytes: total() }
  }

  // Oldest first, so the cache that buys the least goes first.
  const ordered = [...caches].sort((a, b) => a.modifiedMs - b.modifiedMs || a.key.localeCompare(b.key))

  const keys: string[] = []
  let bytesReclaimed = 0
  let kept = runBytes + total()
  let userWide = environment.userWideBytes

  for (const cache of ordered) {
    const tooOld = nowMs - cache.modifiedMs > RETENTION.cacheMaxAgeMs
    const overRoot = kept > RETENTION.perRootByteTarget
    const overUserWide = userWide !== undefined && userWide > RETENTION.userWideByteTarget
    if (!tooOld && !overRoot && !overUserWide) break

    try {
      rmSync(cache.path, { recursive: true, force: true })
    } catch {
      // A cache that will not delete is bytes still accounted for, which the
      // totals below keep saying until something can remove it.
      continue
    }
    keys.push(cache.key)
    bytesReclaimed += cache.bytes
    kept -= cache.bytes
    if (userWide !== undefined) userWide -= cache.bytes
  }

  return { keys, bytesReclaimed, cacheBytes: kept - runBytes }
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
