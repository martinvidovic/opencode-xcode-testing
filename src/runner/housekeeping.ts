/**
 * The global registry and user-wide housekeeping (#3, amended by ADR 0002).
 *
 * Housekeeping exists for roots whose repositories moved, disappeared, or are
 * simply never opened again — nothing else would ever evict their artifacts.
 *
 * ADR 0002's amendment is the reason for the interval guard: housekeeping is
 * *triggered by* a plugin instance starting, but runs at most once an hour.
 * Without that, a project with no Xcode in it would pay for user-wide
 * maintenance it has no stake in on every single session start.
 *
 * Both passes try the lock without waiting. A held lock means a sibling
 * instance is already doing this work, and the right answer is to return, not
 * to queue behind it and delay host startup.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { LockUnavailableError, withTryLock } from "./locks.ts"
import { createPrivateDirectory, writePrivateFileAtomic, type Storage } from "./paths.ts"
import { directorySize, runRetention, type RetentionReport } from "./retention.ts"

/** ADR 0002: user-wide housekeeping runs at most once per hour. */
export const HOUSEKEEPING_MIN_INTERVAL_MS = 60 * 60 * 1000

export type Registry = {
  schemaVersion: 1
  lastHousekeepingAtMs?: number
  roots: Record<string, { lastSeenAtMs: number }>
  /**
   * The last runtime probe that succeeded, revalidated by `stat` rather than
   * re-spawned. First start pays for a subprocess; later starts pay for a
   * stat, which is the identity-recheck philosophy #8 applies to toolchains.
   */
  runtime?: { path: string; mtimeMs: number; size: number; version?: string }
}

const EMPTY_REGISTRY: Registry = { schemaVersion: 1, roots: {} }

export function readRegistry(storage: Storage): Registry {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storage.registryFile, "utf8"))
    if (isRegistry(parsed)) return parsed
  } catch {
    // A malformed registry is rebuilt rather than trusted; it holds no evidence.
  }
  return { ...EMPTY_REGISTRY, roots: {} }
}

export function writeRegistry(storage: Storage, registry: Registry): void {
  createPrivateDirectory(storage.registryDir)
  writePrivateFileAtomic(storage.registryFile, `${JSON.stringify(registry, null, 2)}\n`)
}

/** Record that this trusted root was opened, so housekeeping can find it later. */
export function noteRootSeen(storage: Storage, nowMs: number): void {
  withTryLock(storage.registryLock, () => {
    const registry = readRegistry(storage)
    writeRegistry(storage, {
      ...registry,
      roots: { ...registry.roots, [storage.rootKey]: { lastSeenAtMs: nowMs } },
    })
  })
}

export function housekeepingIsDue(registry: Registry, nowMs: number): boolean {
  const last = registry.lastHousekeepingAtMs
  return last === undefined || nowMs - last >= HOUSEKEEPING_MIN_INTERVAL_MS
}

export type HousekeepingOutcome =
  | { status: "ran"; reports: Record<string, RetentionReport> }
  | { status: "skipped"; reason: "tooSoon" }
  | { status: "skipped"; reason: "lockHeld" }

export type HousekeepingEnvironment = {
  storage: Storage
  now(): number
  /** Build a per-root storage view for another root key. */
  storageForRootKey(rootKey: string): Storage
  /** Runs currently under a read lease, per root key. */
  leased?(rootKey: string): ReadonlySet<string>
}

/**
 * Evict across every registered root.
 *
 * The registry lock is released before any root lock is taken, and the registry
 * is re-read afterwards — the two locks are never held at once, so a root lock
 * held by a live run can never block user-wide maintenance of other roots.
 */
export function runHousekeeping(environment: HousekeepingEnvironment): HousekeepingOutcome {
  const { storage } = environment
  const nowMs = environment.now()

  const claimed = withTryLock(storage.registryLock, () => {
    const registry = readRegistry(storage)
    if (!housekeepingIsDue(registry, nowMs)) return undefined
    writeRegistry(storage, { ...registry, lastHousekeepingAtMs: nowMs })
    return Object.keys(registry.roots).sort()
  })

  if (claimed === undefined) {
    // Either a sibling holds the lock, or the previous pass is under an hour
    // old. Both mean the same thing to this instance: there is nothing to do.
    return {
      status: "skipped",
      reason: withTryLock(storage.registryLock, () => true) === undefined ? "lockHeld" : "tooSoon",
    }
  }

  const userWideBytes = totalCompletedBytes(storage)
  const reports: Record<string, RetentionReport> = {}

  for (const rootKey of claimed) {
    const rootStorage = environment.storageForRootKey(rootKey)
    const report = withTryLock(rootStorage.rootLock, () =>
      runRetention({
        storage: rootStorage,
        now: () => nowMs,
        userWideBytes,
        ...(environment.leased === undefined ? {} : { leased: environment.leased(rootKey) }),
      }),
    )
    // A held root lock means a live run owns that root; skipping it is correct.
    if (report !== undefined) reports[rootKey] = report
  }

  return { status: "ran", reports }
}

/** Apparent bytes across every root's retained artifacts. */
export function totalCompletedBytes(storage: Storage): number {
  const rootsDir = join(storage.toolRoot, "roots")
  try {
    return readdirSync(rootsDir)
      .map((rootKey) => directorySize(join(rootsDir, rootKey, "runs")))
      .reduce((total, bytes) => total + bytes, 0)
  } catch {
    return 0
  }
}

function isRegistry(value: unknown): value is Registry {
  if (typeof value !== "object" || value === null) return false
  const registry = value as Partial<Registry>
  return registry.schemaVersion === 1 && typeof registry.roots === "object" && registry.roots !== null
}

export { LockUnavailableError }
