/**
 * Describing a failure without describing the machine.
 *
 * Anything this tool says can reach a model, and a thrown error's message
 * routinely carries a temp directory, a home directory, or the full path to
 * someone's checkout. None of it helps — a model cannot act on where this
 * machine keeps things — and all of it is a fact about the person running it
 * rather than about their run.
 *
 * What is left is the error's kind and its first line with anything
 * path-shaped removed: enough to tell a permission denial from a missing file,
 * and nothing that belongs to whoever ran it.
 *
 * Deliberately blunt. A redaction that tried to keep the useful parts of a
 * path would be a redaction with a bug in it, and the bug would be a leak.
 */

/**
 * An absolute POSIX path, wherever it appears in a message.
 *
 * Spaces are part of a path when what follows them is more path. That is not
 * an edge case on macOS: everything this tool keeps lives under `Application
 * Support`, and a rule that stopped at the first space redacted
 * `/Users/someone/Library` and left ` Support/opencode-xcode-test/roots/<key>`
 * in plain view — the half naming the machine removed, the half naming the
 * repository kept.
 *
 * A space continues the path only when the run after it contains a `/` before
 * the next space, so "held at /var/x by process 12" ends at `/var/x` and
 * "/Users/a/Application Support/b" does not.
 */
const ABSOLUTE_PATH = /(?<![\w.])\/(?:[^\s"'`,)]|\s(?=[^\s"'`,)]*\/))*/g

/** A home-relative path, which names a user as surely as an absolute one. */
const HOME_PATH = /(?<![\w.])~\/(?:[^\s"'`,)]|\s(?=[^\s"'`,)]*\/))*/g

/**
 * A run id, a root key, or a bundle digest.
 *
 * Private identifiers rather than paths, and the reason to remove them is
 * different: they are not secret, they are *addresses*. A root key names a
 * repository on this machine; a run id addresses retained evidence. Neither
 * tells a model anything it can act on inside an error message, and a caller
 * who needs one has it already — they asked with it.
 */
const PRIVATE_IDENTIFIER = /\b[0-9a-f]{32,}\b/g

/** Longer than this and it is no longer a line; it is a payload. */
const FIRST_LINE_CHAR_CAP = 200

export function safeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "an unrecognized failure"

  const first = (error.message.split("\n")[0] ?? "").trim()
  const redacted = first
    // Home-relative first: `~/x` contains `/x`, so the absolute rule would
    // take the tail and leave a stray `~` standing in front of `<path>`.
    .replace(HOME_PATH, "<path>")
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(PRIVATE_IDENTIFIER, "<id>")
    .slice(0, FIRST_LINE_CHAR_CAP)
  return redacted.length === 0 ? error.name : `${error.name}: ${redacted}`
}
