/**
 * The per-root storage a gate suite makes a real host create (issue #98).
 *
 * Any suite that drives the live OpenCode host against a generated project
 * leaves a directory behind under the user's own storage, keyed by a hash of
 * that project's path. The project is in a temp workspace and is deleted on
 * the way out; the storage is not, and nothing downstream can ever collect it,
 * because the registry stores a hash and a timestamp by design and never a
 * path. One directory per suite run, for ever.
 *
 * It was found by counting rather than by reading: 314 roots before a gate run
 * and 320 after three of them. B2 was fixed first and the same arithmetic then
 * showed B1 leaving two more per run — which is why this is a shared piece
 * rather than a second copy of the same care.
 */

import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"

import { isRootKey, storageFor } from "../../src/runner/paths.ts"
import { join } from "node:path"
import { readRegistry, writeRegistry } from "../../src/runner/housekeeping.ts"
import { withTryLock } from "../../src/runner/locks.ts"

export class DrivenRoots {
  readonly #homeDir: string
  readonly #roots = new Map<string, string>()
  readonly #openedAtMs: number | undefined

  /**
   * `collectUnclaimedSince` opts in to attributing storage this run caused but
   * could not name, and is the moment the run began (issue #104).
   *
   * Opt-in, and explicitly so. It is the one rule here that deletes a
   * directory nothing named, on an inference rather than a record, and a rule
   * like that belongs at a call site that has decided to want it — not on by
   * default for every caller that constructs one of these.
   */
  constructor(homeDir: string = homedir(), collectUnclaimedSince?: number) {
    this.#homeDir = homeDir
    this.#openedAtMs = collectUnclaimedSince
  }

  /**
   * Register a project root a host will be pointed at, and hand it back.
   *
   * Returns its argument so a caller can register at the moment it creates
   * each project rather than after creating all of them: a throw in the second
   * would otherwise leave the first registered nowhere, and a root nobody
   * knows about is the accumulation this exists to stop.
   *
   * Canonicalized, because `storageFor` hashes a canonical root and the host
   * resolves one before it stores anything. A temp workspace is reached
   * through a symbolic link on macOS, so a key hashed from the path as written
   * addresses a directory that does not exist — and every `existsSync` after
   * it politely declines to do anything, which is how this reads as working.
   */
  add(path: string): string {
    this.#roots.set(canonicalize(path), path)
    return path
  }

  /** The opaque key one registered root is filed under. */
  keyOf(path: string): string {
    return storageFor(this.#homeDir, canonicalize(path)).rootKey
  }

  /** Every registered root's storage directory that exists, with its key. */
  directories(): Array<{ key: string; path: string }> {
    return [...this.#roots.keys()]
      .map((root) => storageFor(this.#homeDir, root))
      .filter((storage) => existsSync(storage.rootDir))
      .map((storage) => ({ key: storage.rootKey, path: storage.rootDir }))
  }

  /**
   * Remove that storage. Returns the keys it collected.
   *
   * Run on every path, pass or fail — and on a failing one only after any
   * evidence has been copied out of it.
   */
  clean(): string[] {
    const removed: string[] = []
    for (const { key, path } of [...this.directories(), ...this.#unclaimed()]) {
      try {
        rmSync(path, { recursive: true, force: true })
        removed.push(key)
      } catch {
        // Storage that will not delete is storage left behind, which is worth
        // knowing and is not a reason to fail a gate about the tool.
      }
    }

    // The registration goes with the storage (issue #101). Removing the
    // directory and leaving the entry was the shape this had, and it is how
    // three gate runs added twelve registry entries against three surviving
    // directories: the entries outlive everything they describe, and every
    // later housekeeping pass reopens the question of a root that has not
    // existed since the run that made it.
    this.#forget([...this.#roots.keys()].map((root) => storageFor(this.#homeDir, root).rootKey))
    return removed
  }

  /**
   * Storage that appeared while this run was going and belongs to nobody.
   *
   * The B1 suite leaves one such directory per run, prepared and empty, for a
   * trusted root the host resolves and the suite cannot name: it drives the
   * host from directories it created, and what the host reports as a worktree
   * is the host's own business (issue #104). Registering every path the suite
   * knows about did not cover it, because the path is not one of them.
   *
   * So it is attributed rather than named. Three conditions together: created
   * after this run opened, holding no runs at all, and not registered before
   * this run opened. A real project's storage fails all three — it predates
   * the run, it holds runs, and it was registered when someone last opened it.
   *
   * The registry condition is about *when*, not whether. The host registers
   * whatever trusted root it resolved, so the orphan is registered — by this
   * run, moments after creating it. Treating any registration as a claim was
   * the first shape of this and it excluded exactly the directory it was
   * written to collect.
   */
  #unclaimed(): Array<{ key: string; path: string }> {
    const openedAtMs = this.#openedAtMs
    if (openedAtMs === undefined) return []

    const toolRoot = storageFor(this.#homeDir, this.#homeDir).toolRoot
    const rootsDir = join(toolRoot, "roots")

    let registered: Record<string, { lastSeenAtMs: number }>
    let names: string[]
    try {
      registered = readRegistry(storageFor(this.#homeDir, this.#homeDir)).roots
      names = readdirSync(rootsDir).filter(isRootKey)
    } catch {
      return []
    }

    const claimed = new Set([...this.#roots.keys()].map((root) => this.keyOf(root)))
    const found: Array<{ key: string; path: string }> = []

    for (const key of names) {
      if (claimed.has(key)) continue
      // A registration from before this run began belongs to a root someone
      // was already using, whatever else is true of it. One made during the
      // run is this run's own doing: the host registers whatever trusted root
      // it resolved, which is how the directory came to exist at all.
      const seenAtMs = registered[key]?.lastSeenAtMs
      if (seenAtMs !== undefined && seenAtMs < openedAtMs) continue
      const path = join(rootsDir, key)
      try {
        if (statSync(path).birthtimeMs < openedAtMs) continue
        if (readdirSync(join(path, "runs")).length > 0) continue
      } catch {
        continue
      }
      found.push({ key, path })
    }
    return found
  }

  #forget(keys: readonly string[]): void {
    const storage = storageFor(this.#homeDir, this.#homeDir)
    try {
      withTryLock(storage.registryLock, () => {
        const registry = readRegistry(storage)
        const roots = { ...registry.roots }
        let changed = false
        for (const key of keys) {
          if (roots[key] === undefined) continue
          delete roots[key]
          changed = true
        }
        if (changed) writeRegistry(storage, { ...registry, roots })
      })
    } catch {
      // A registry that cannot be written leaves entries behind, which the
      // age policy collects eventually. It is not a reason to fail a gate.
    }
  }
}

/**
 * The path the tool would have hashed, or the one given if it cannot be had.
 *
 * Never throws: a root that has already gone is a root with no storage to
 * find, and failing a gate over it would trade a diagnostic aid for the thing
 * it was meant to diagnose.
 */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
