/**
 * What a failed Layer 4 run leaves behind (issue #73).
 *
 * Layer 4 builds its whole world in a temp workspace and deleted it on the way
 * out, unconditionally. On a pass that is exactly right. On a failure it threw
 * away the only copy of the thing anyone would want: the Run Record that says
 * what the supervisor decided, the raw log, the normalized index, and the
 * Result Bundle the interpreter read. What survived was one line of text
 * saying the scenario did not pass, which is enough to know something is wrong
 * and never enough to know what.
 *
 * So a failing run keeps its evidence, and three rules keep that from becoming
 * its own problem:
 *
 * - it goes to the tool-managed storage root, owner-only all the way down,
 *   never to the repository and never anywhere a `git add -A` could reach;
 * - it is addressed by the same key as the report that describes it, through
 *   the same function, so the correlation is a property of where things are
 *   rather than a note somebody has to keep accurate;
 * - it is bounded before anything is copied, not after. Measuring first is
 *   what makes the bound hold at every instant rather than only once the dust
 *   settles: a policy that copied 40GB and then tidied up would have been
 *   telling the truth about the end state and nothing about the disk.
 */

import { cpSync, chmodSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { createPrivateDirectory, toolRootFor } from "../../src/runner/paths.ts"
import { directorySize } from "../../src/runner/retention.ts"
import { keyFor } from "./report.ts"

/**
 * The bound, stated in three ways because each catches what the others miss.
 *
 * Age alone lets a bad afternoon fill a disk; count alone lets three enormous
 * sets do it; bytes alone lets a set sit there for a year. All three apply,
 * and the byte budget is the one that makes the guarantee absolute.
 */
export type EvidencePolicy = {
  maxSets: number
  maxAgeMs: number
  maxBytes: number
}

export const EVIDENCE_POLICY: EvidencePolicy = {
  maxSets: 3,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 2 * 1024 * 1024 * 1024,
}

/** The `evidence` directory inside the tool-managed storage root. */
export function evidenceDirectory(homeDir = homedir()): string {
  return join(toolRootFor(homeDir), "evidence")
}

export type Preservation =
  | { status: "preserved"; key: string; bytes: number }
  | { status: "discarded"; key: string; bytes: number; reason: string }

/**
 * Keep a failed run's private evidence, then prune the store.
 *
 * The order is the design. The source is measured, the store is pruned to make
 * room for it, and only then is anything copied — so the evidence directory
 * never holds more than the budget even for the duration of a copy. Measuring
 * afterwards would leave a window in which it held the old store *and* an
 * arbitrarily large new set, which is the failure this is meant to prevent
 * rather than a moment on the way to preventing it.
 *
 * Copied rather than moved: the workspace is under the system temp directory
 * and the store is under the user's home, which are routinely different
 * filesystems, and a rename across one fails rather than falling back.
 */
export function preserveEvidence(
  source: string,
  input: { startedAt: string; homeDir?: string; policy?: EvidencePolicy; nowMs?: number },
): Preservation {
  const homeDir = input.homeDir ?? homedir()
  const policy = input.policy ?? EVIDENCE_POLICY
  const nowMs = input.nowMs ?? Date.now()
  const key = keyFor(input.startedAt)

  // A run that threw before it wrote anything has nothing to keep, and saying
  // so is better than either a copy that fails or an empty directory that
  // reads as evidence somebody has already looked through.
  if (!existsSync(source)) {
    return { status: "discarded", key, bytes: 0, reason: "the run had not produced any evidence yet" }
  }

  const bytes = directorySize(source)

  // Against the whole budget, so the rule is not "usually bounded". A set that
  // cannot fit inside the entire budget would otherwise be a permanent
  // exception to it, and a permanent exception to a bound is not a bound.
  //
  // Nothing partial is kept in its place, deliberately. A subset of a run's
  // evidence looks exactly like the whole of it to anyone reading it later,
  // and a diagnosis drawn from silently missing artifacts is worse than no
  // diagnosis. The report says it was not kept, and why.
  if (bytes > policy.maxBytes) {
    pruneEvidence(homeDir, policy, nowMs)
    return {
      status: "discarded",
      key,
      bytes,
      reason: "the run's evidence is larger than the whole evidence budget",
    }
  }

  // Room made before the copy starts, not after it finishes.
  pruneEvidence(homeDir, policy, nowMs, bytes)

  const destination = join(evidenceDirectory(homeDir), key)
  createPrivateDirectory(evidenceDirectory(homeDir))
  rmSync(destination, { recursive: true, force: true })
  createPrivateDirectory(destination)
  cpSync(source, destination, { recursive: true, dereference: false })

  // `cpSync` carries the source's modes, and a Result Bundle is created by
  // `xcodebuild` at 0755/0644. The 0700 root contains it in practice, and "in
  // practice" is not what the rest of this tool's storage promises.
  restrictToOwner(destination)

  return { status: "preserved", key, bytes }
}

/**
 * Bring the store back inside the policy, oldest first.
 *
 * `reserveBytes` is room to leave for a set about to be written. Without it
 * the store would be pruned to exactly the budget and then written past it,
 * which is the same as not having pruned.
 *
 * Run before every preservation rather than on a schedule, because there is no
 * daemon here: a store pruned only by the next failure would keep whatever the
 * last one left for as long as nothing else went wrong.
 */
export function pruneEvidence(
  homeDir = homedir(),
  policy: EvidencePolicy = EVIDENCE_POLICY,
  nowMs = Date.now(),
  reserveBytes = 0,
): string[] {
  const directory = evidenceDirectory(homeDir)
  if (!existsSync(directory)) return []

  const sets = readdirSync(directory)
    .map((name) => ({ name, path: join(directory, name) }))
    .filter((entry) => isDirectory(entry.path))
    .map((entry) => ({
      ...entry,
      // Stamped "now" by the copy that created it, because `cpSync` does not
      // preserve timestamps unless asked. Age here is therefore age *in the
      // store*, which is what the policy is about — turning that on would make
      // every freshly kept set look as old as the run it came from.
      modifiedMs: statSync(entry.path).mtimeMs,
      bytes: directorySize(entry.path),
    }))
    // Newest first, so everything below is "drop from the end". Ties break by
    // name, which for these keys is the same order, so the result is stable
    // rather than dependent on directory listing order.
    .sort((a, b) => b.modifiedMs - a.modifiedMs || b.name.localeCompare(a.name))

  const removed: string[] = []
  let kept = reserveBytes > 0 ? 1 : 0
  let bytes = reserveBytes

  for (const set of sets) {
    const tooOld = nowMs - set.modifiedMs > policy.maxAgeMs
    const tooMany = kept >= policy.maxSets
    const tooLarge = bytes + set.bytes > policy.maxBytes

    if (tooOld || tooMany || tooLarge) {
      rmSync(set.path, { recursive: true, force: true })
      removed.push(set.name)
      continue
    }

    kept += 1
    bytes += set.bytes
  }

  return removed
}

/**
 * Make a preserved tree unreadable to anyone but its owner.
 *
 * Directories 0700 and files 0600, matching what the runner writes for its own
 * artifacts. Symbolic links are skipped rather than followed: `chmod` through
 * a link changes whatever it points at, which for a tree copied from somewhere
 * else is exactly the thing not to do.
 */
function restrictToOwner(path: string): void {
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
        const stats = lstatSync(child)
        if (stats.isSymbolicLink()) continue
        chmodSync(child, stats.isDirectory() ? 0o700 : 0o600)
        if (stats.isDirectory()) walk(child)
      } catch {
        // A file that vanished mid-walk needs no permissions.
      }
    }
  }
  chmodSync(path, 0o700)
  walk(path)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
