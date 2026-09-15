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

/** An absolute POSIX path, wherever it appears in a message. */
const ABSOLUTE_PATH = /(?<![\w.])\/[^\s"'`,)]+/g

/** Longer than this and it is no longer a line; it is a payload. */
const FIRST_LINE_CHAR_CAP = 200

export function safeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "an unrecognized failure"

  const first = (error.message.split("\n")[0] ?? "").trim()
  const redacted = first.replace(ABSOLUTE_PATH, "<path>").slice(0, FIRST_LINE_CHAR_CAP)
  return redacted.length === 0 ? error.name : `${error.name}: ${redacted}`
}
