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
 * - it goes to the tool-managed storage root, owner-only, never to the
 *   repository and never anywhere a `git add -A` could reach;
 * - it is addressed by the same key as the report that describes it, so the
 *   correlation is a property of where things are rather than a note somebody
 *   has to keep accurate;
 * - it is bounded absolutely. Not "usually small": after every preservation
 *   the store is pruned by age, by count and by bytes, and a single set too
 *   large for the whole budget is discarded rather than granted an exception.
 *   An unbounded diagnostic aid is a disk that fills up quietly.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { createPrivateDirectory, TOOL_DIRECTORY } from "../../src/runner/paths.ts"
import { directorySize } from "../../src/runner/retention.ts"

/**
 * The bound, stated in three ways because each catches what the others miss.
 *
 * Age alone lets a bad afternoon fill a disk; count alone lets three enormous
 * sets do it; bytes alone lets a set sit there for a year. All three apply,
 * and the byte budget is the one that makes the guarantee absolute.
 */
export const EVIDENCE_POLICY = {
  maxSets: 3,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 2 * 1024 * 1024 * 1024,
} as const

export type EvidencePolicy = typeof EVIDENCE_POLICY

/** The `evidence` directory inside the tool-managed storage root. */
export function evidenceDirectory(homeDir = homedir()): string {
  return join(homeDir, "Library", "Application Support", TOOL_DIRECTORY, "evidence")
}

/**
 * The key a preserved set is filed under.
 *
 * Derived from the run's start instant by the same rule the report file uses,
 * so a reader holding `acceptance-2026-09-15T19-35-54-775Z.json` knows where
 * its evidence is without the report having to say. A correlation that is a
 * recorded string is a correlation that can be wrong; this one cannot be.
 */
export function evidenceKeyFor(startedAt: string): string {
  return startedAt.replace(/[:.]/g, "-")
}

export type Preservation =
  | { status: "preserved"; key: string; bytes: number }
  | { status: "discarded"; key: string; bytes: number; reason: string }

/**
 * Keep a failed run's private evidence, then prune the store.
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
  const key = evidenceKeyFor(input.startedAt)
  const destination = join(evidenceDirectory(homeDir), key)

  // A run that threw before it wrote anything has nothing to keep, and saying
  // so is better than either a copy that fails or an empty directory that
  // reads as evidence somebody has already looked through.
  if (!existsSync(source)) {
    return {
      status: "discarded",
      key,
      bytes: 0,
      reason: "the run had not produced any evidence yet",
    }
  }

  createPrivateDirectory(evidenceDirectory(homeDir))
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  cpSync(source, destination, { recursive: true, dereference: false })

  const bytes = directorySize(destination)

  // Checked before pruning and against the whole budget, so the guarantee is
  // not "usually bounded". A set that cannot fit inside the entire budget
  // would otherwise sit there as a permanent exception to it.
  if (bytes > policy.maxBytes) {
    rmSync(destination, { recursive: true, force: true })
    pruneEvidence(homeDir, policy, nowMs)
    return {
      status: "discarded",
      key,
      bytes,
      reason: "the run's evidence is larger than the whole evidence budget",
    }
  }

  pruneEvidence(homeDir, policy, nowMs)
  return { status: "preserved", key, bytes }
}

/**
 * Bring the store back inside the policy, oldest first.
 *
 * Run after every preservation rather than on a schedule, because there is no
 * daemon here: a store that were pruned only by the next failure would keep
 * whatever the last one left for as long as nothing else went wrong.
 */
export function pruneEvidence(
  homeDir = homedir(),
  policy: EvidencePolicy = EVIDENCE_POLICY,
  nowMs = Date.now(),
): string[] {
  const directory = evidenceDirectory(homeDir)
  if (!existsSync(directory)) return []

  const sets = readdirSync(directory)
    .map((name) => ({ name, path: join(directory, name) }))
    .filter((entry) => isDirectory(entry.path))
    .map((entry) => ({
      ...entry,
      modifiedMs: statSync(entry.path).mtimeMs,
      bytes: directorySize(entry.path),
    }))
    // Newest first, so everything below is "drop from the end".
    .sort((a, b) => b.modifiedMs - a.modifiedMs)

  const removed: string[] = []
  let kept = 0
  let bytes = 0

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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
