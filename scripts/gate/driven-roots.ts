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

import { existsSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"

import { storageFor } from "../../src/runner/paths.ts"
import { readRegistry, writeRegistry } from "../../src/runner/housekeeping.ts"
import { withTryLock } from "../../src/runner/locks.ts"

export class DrivenRoots {
  readonly #homeDir: string
  readonly #roots = new Map<string, string>()

  constructor(homeDir: string = homedir()) {
    this.#homeDir = homeDir
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
    for (const { key, path } of this.directories()) {
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
