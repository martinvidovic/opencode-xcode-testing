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

import { readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

import { isRecord } from "../domain/json.ts"
import { LockUnavailableError, withTryLock } from "./locks.ts"
import { readQueue, type QueueState } from "./queue.ts"
import {
  createPrivateDirectory,
  isRootKey,
  readPrivateFile,
  writePrivateFileAtomic,
  type Storage,
} from "./paths.ts"
import { directorySize, runRetention, type RetentionReport } from "./retention.ts"

/** ADR 0002: user-wide housekeeping runs at most once per hour. */
export const HOUSEKEEPING_MIN_INTERVAL_MS = 60 * 60 * 1000

/**
 * How long a root goes unopened before its storage is collected (issue #96).
 *
 * Generous, and long enough to survive a holiday: this deletes the diagnostics
 * for a project someone may simply not have touched for a while, and the cost
 * of waiting is disk while the cost of being wrong is evidence.
 *
 * `lastSeenAtMs` is the only signal available, and that is not an accident.
 * The registry stores a hash and a timestamp and deliberately never a path, so
 * nothing here can ask whether a repository still exists — which is the
 * privacy property, and also why an age policy is the *whole* of what stale
 * collection can be. Without one the directories are permanent: 344 roots had
 * accumulated on the machine where this was written, against a handful of real
 * projects.
 */
export const STALE_ROOT_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

export type Registry = {
  schemaVersion: 1
  lastHousekeepingAtMs?: number
  roots: Record<string, { lastSeenAtMs: number }>
  /**
   * The last runtime probe that succeeded, revalidated by `stat` rather than
   * re-spawned. First start pays for a subprocess; later starts pay for a
   * stat, which is the identity-recheck philosophy #8 applies to toolchains.
   */
  runtime?: {
    path: string
    mtimeMs: number
    size: number
    source: "configuration" | "host" | "path"
    version?: string
  }
}

const EMPTY_REGISTRY: Registry = { schemaVersion: 1, roots: {} }

export function readRegistry(storage: Storage): Registry {
  try {
    // The registry is tool-managed storage like any other: owner-only, and
    // never a link. It decides which directories housekeeping deletes from.
    const parsed: unknown = JSON.parse(readPrivateFile(storage.registryFile))
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
  | {
      status: "ran"
      reports: Record<string, RetentionReport>
      /**
       * Roots collected whole, by opaque key (AC5).
       *
       * Reported apart from the per-root reports because it is a different
       * event: those describe eviction inside a root someone still opens,
       * this is a root nobody has opened in two months going away entirely.
       */
      staleRoots: string[]
    }
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

  // Stale roots first, so the user-wide total the byte targets are measured
  // against is the one that remains rather than one inflated by storage this
  // pass is about to remove — otherwise a single sweep evicts evidence from
  // live roots to make room for roots it then deletes anyway.
  const staleRoots = collectStaleRoots(environment, claimed, nowMs)
  const surviving = claimed.filter((rootKey) => !staleRoots.includes(rootKey))

  const userWideBytes = totalToolBytes(storage)
  const reports: Record<string, RetentionReport> = {}

  for (const rootKey of surviving) {
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

  return { status: "ran", reports, staleRoots }
}

/**
 * Every root this pass might collect: the registered ones, and the directories
 * nobody registered.
 *
 * The second kind is not hypothetical. A root's registry entry is the only
 * record that it exists, so a directory without one is storage no policy can
 * see — and the entry and the directory are written by different calls, so a
 * crash between them leaves exactly this.
 */
function candidates(storage: Storage, claimed: readonly string[]): string[] {
  const known = new Set(claimed)
  try {
    for (const name of readdirSync(join(storage.toolRoot, "roots"))) {
      if (isRootKey(name)) known.add(name)
    }
  } catch {
    // No roots directory is no candidates, which the registry already said.
  }
  return [...known].sort()
}

/** How long an unregistered directory has sat there, by its own timestamp. */
function orphanAge(
  environment: HousekeepingEnvironment,
  rootKey: string,
  nowMs: number,
): number | undefined {
  try {
    return nowMs - statSync(environment.storageForRootKey(rootKey).rootDir).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Delete the storage of every root nobody has opened in `STALE_ROOT_MAX_AGE_MS`.
 *
 * Under that root's own lock, tried and not waited for, like everything else
 * here: a held lock means a live instance owns the root, which is the clearest
 * possible evidence that it is not stale.
 *
 * The registry entry goes with the directory, in that order. A directory
 * removed with its entry left behind would be collected again on every pass
 * for ever; an entry removed first would leave a directory nothing knows
 * about, which is the accumulation this exists to end.
 *
 * Nothing is reconstructed and nothing is stored: the key is all there is,
 * the key is what names the directory, and `lastSeenAtMs` is the only fact
 * about it. The privacy guarantee and the collection policy are the same
 * design decision seen from two sides.
 */
function collectStaleRoots(
  environment: HousekeepingEnvironment,
  claimed: readonly string[],
  nowMs: number,
): string[] {
  const seen = withTryLock(environment.storage.registryLock, () => readRegistry(environment.storage))
  if (seen === undefined) return []

  const collected: string[] = []
  for (const rootKey of candidates(environment.storage, claimed)) {
    const lastSeenAtMs = seen.roots[rootKey]?.lastSeenAtMs

    // A directory with no registry entry is storage nothing will ever account
    // for: the entry is the only record that a root exists, so an orphan is
    // invisible to every policy including this one. Judged by its own age
    // instead, which is the same rule applied to the only timestamp left.
    const age = lastSeenAtMs === undefined ? orphanAge(environment, rootKey, nowMs) : nowMs - lastSeenAtMs
    if (age === undefined || age <= STALE_ROOT_MAX_AGE_MS) continue

    const rootStorage = environment.storageForRootKey(rootKey)

    // Renamed under the lock, deleted outside it — and never deleted in
    // place. `rootLock` is a file *inside* `rootDir`, and the lock is a flock
    // on that inode: removing it while holding it leaves a later acquirer
    // opening the path, creating a fresh inode and taking the lock at once,
    // so two instances proceed while one of them is deleting the other's
    // storage. A rename moves the whole tree, lock included, in one step.
    const graveyard = join(environment.storage.toolRoot, "roots", `.collected-${rootKey}`)
    const removed = withTryLock(rootStorage.rootLock, () => {
      // A root holding the execution slot or under quarantine is not stale,
      // whatever its timestamp says. The slot means a run is live in it; the
      // quarantine is state a recovery pass has to find, and sixty days of
      // silence is not permission to discard it.
      // Fails closed, including on coordination state that cannot be read at
      // all: a root whose queue is unreadable is a root nothing can say is
      // idle, and the answer to that is to leave it rather than to delete it
      // and find out.
      let queue: QueueState
      try {
        queue = readQueue(rootStorage)
      } catch {
        return false
      }
      if (queue.activeRunId !== undefined || queue.quarantine !== undefined) return false

      try {
        renameSync(rootStorage.rootDir, graveyard)
      } catch {
        return false
      }
      return true
    })

    if (removed !== true) continue
    rmSync(graveyard, { recursive: true, force: true })
    collected.push(rootKey)
  }

  if (collected.length > 0) {
    withTryLock(environment.storage.registryLock, () => {
      const registry = readRegistry(environment.storage)
      const roots = { ...registry.roots }
      for (const rootKey of collected) delete roots[rootKey]
      writeRegistry(environment.storage, { ...registry, roots })
    })
  }
  return collected
}

/**
 * Apparent bytes across every root's tool-owned storage.
 *
 * The **whole** root directory, not its `runs` alone (issue #96). Counting the
 * runs made the user-wide target a bound on a fraction of what the tool
 * occupied: 5.0 GB accounted for against 34.3 GB of shared DerivedData in the
 * same tree on the machine where this was measured. A cap computed over an
 * eighth of what it is capping is not a cap, and the number it produced was
 * always comfortably under target while the disk filled.
 *
 * Only directories named by a well-formed root key are counted. This number
 * drives user-wide eviction, so anything else that happens to sit in the roots
 * directory must not be able to inflate it — or to be walked at all.
 */
export function totalToolBytes(storage: Storage): number {
  const rootsDir = join(storage.toolRoot, "roots")
  try {
    return readdirSync(rootsDir)
      .filter(isRootKey)
      .map((rootKey) => directorySize(join(rootsDir, rootKey)))
      .reduce((total, bytes) => total + bytes, 0)
  } catch {
    return 0
  }
}

/**
 * Validate the registry down to its keys.
 *
 * Every key in `roots` becomes a directory name that housekeeping renames and
 * recursively deletes. A key of `../../Documents` in a file that was only
 * checked for having a `roots` object at all would evict outside the tool root
 * entirely — so the keys are the validation, not an afterthought to it.
 */
function isRegistry(value: unknown): value is Registry {
  if (!isRecord(value)) return false
  const registry = value as Partial<Registry>

  return (
    registry.schemaVersion === 1 &&
    isRecord(registry.roots) &&
    Object.entries(registry.roots).every(
      ([rootKey, entry]) =>
        isRootKey(rootKey) && isRecord(entry) && typeof entry.lastSeenAtMs === "number",
    ) &&
    (registry.lastHousekeepingAtMs === undefined ||
      typeof registry.lastHousekeepingAtMs === "number") &&
    (registry.runtime === undefined || isRuntimeEntry(registry.runtime))
  )
}

function isRuntimeEntry(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.path === "string" &&
    typeof value.mtimeMs === "number" &&
    typeof value.size === "number" &&
    (value.source === "configuration" || value.source === "host" || value.source === "path") &&
    (value.version === undefined || typeof value.version === "string")
  )
}

export { LockUnavailableError }
