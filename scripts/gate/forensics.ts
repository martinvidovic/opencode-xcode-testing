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
 * One named tree within a run's evidence set.
 *
 * Named because a run now keeps evidence from more than one place. Layer 4
 * builds its whole world under a temp home and keeps that; B2 drives the real
 * host, whose artifacts land in the user's own storage root under one opaque
 * key per project (issue #98) — so a set is several trees that have to stay
 * told apart, and "the evidence" as a single anonymous directory would bury
 * which host, which project, which suite.
 */
export type EvidenceSource = {
  name: string
  path: string
  /**
   * What within this tree is worth keeping. Applied to the measurement and to
   * the copy alike, so the bound is a bound on what is actually written —
   * measuring the whole tree and copying part of it would discard sets that
   * would have fitted.
   */
  keep?: (path: string) => boolean
}

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
  source: string | readonly EvidenceSource[],
  input: { startedAt: string; homeDir?: string; policy?: EvidencePolicy; nowMs?: number },
): Preservation {
  const homeDir = input.homeDir ?? homedir()
  const policy = input.policy ?? EVIDENCE_POLICY
  const nowMs = input.nowMs ?? Date.now()
  const key = keyFor(input.startedAt)

  // A named tree lands beside whatever the run has already kept; an unnamed
  // one is the whole set, as it was when a run only ever had one (issue #73).
  const sources = (typeof source === "string" ? [{ name: "", path: source }] : source).filter(
    (entry) => existsSync(entry.path),
  )

  // A run that threw before it wrote anything has nothing to keep, and saying
  // so is better than either a copy that fails or an empty directory that
  // reads as evidence somebody has already looked through.
  if (sources.length === 0) {
    return { status: "discarded", key, bytes: 0, reason: "the run had not produced any evidence yet" }
  }

  const bytes = sources.reduce(
    (total, entry) => total + directorySize(entry.path, entry.keep ?? (() => true)),
    0,
  )

  // Against the whole budget, so the rule is not "usually bounded". A set that
  // cannot fit inside the entire budget would otherwise be a permanent
  // exception to it, and a permanent exception to a bound is not a bound.
  //
  // Nothing partial is kept in its place, deliberately. A subset of a run's
  // evidence looks exactly like the whole of it to anyone reading it later,
  // and a diagnosis drawn from silently missing artifacts is worse than no
  // diagnosis. The report says it was not kept, and why.
  // Against the whole budget, and against what this run has *already* filed
  // under the same key. Two suites now keep evidence in one set, and a check
  // that only ever weighed the half in front of it would let the second one
  // carry the store past a bound the first had already half spent.
  const alreadyKept = directorySize(join(evidenceDirectory(homeDir), key))
  if (bytes + alreadyKept > policy.maxBytes) {
    pruneEvidence({ homeDir, policy, nowMs, protectKey: key })
    return {
      status: "discarded",
      key,
      bytes,
      reason: "the run's evidence is larger than the whole evidence budget",
    }
  }

  // Room made before the copy starts, not after it finishes.
  pruneEvidence({ homeDir, policy, nowMs, reserveBytes: bytes, protectKey: key })


  const setDirectory = join(evidenceDirectory(homeDir), key)
  createPrivateDirectory(evidenceDirectory(homeDir))
  createPrivateDirectory(setDirectory)

  for (const entry of sources) {
    // Only the named subtree is replaced. Wiping the set would mean the second
    // suite to fail in a run destroyed the first one's evidence, which is a
    // strange way to preserve it.
    // The named subtree is replaced, and so is an unnamed whole set: a key
    // written twice must not merge with what a previous run left under it.
    const destination = entry.name === "" ? setDirectory : join(setDirectory, entry.name)
    rmSync(destination, { recursive: true, force: true })
    createPrivateDirectory(destination)
    cpSync(entry.path, destination, {
      recursive: true,
      dereference: false,
      ...(entry.keep === undefined ? {} : { filter: entry.keep }),
    })
  }

  // `cpSync` carries the source's modes, and a Result Bundle is created by
  // `xcodebuild` at 0755/0644. The 0700 root contains it in practice, and "in
  // practice" is not what the rest of this tool's storage promises.
  restrictToOwner(setDirectory)

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
export type PruneInput = {
  homeDir?: string
  policy?: EvidencePolicy
  nowMs?: number
  /** Room to leave for a set about to be written. */
  reserveBytes?: number
  /** The set the current run is writing into, which is never pruned. */
  protectKey?: string
}

export function pruneEvidence(input: PruneInput = {}): string[] {
  const homeDir = input.homeDir ?? homedir()
  const policy = input.policy ?? EVIDENCE_POLICY
  const nowMs = input.nowMs ?? Date.now()
  const reserveBytes = input.reserveBytes ?? 0
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
    // The set this run is writing into is never a candidate, whatever the
    // policy says about it. Evidence removed before the report that names it
    // is durably written leaves a reader a key that points at nothing — and
    // the run that fails twice, once per suite, is exactly the run whose
    // second failure would otherwise delete the account of its first.
    if (set.name === input.protectKey) {
      kept += 1
      bytes += set.bytes
      continue
    }

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
