/**
 * Describing a failure without describing the machine (ADR 0001).
 *
 * Scenario details land in a durable report and are pasted into issues. A
 * thrown error's message routinely carries a temp directory, a home
 * directory, or a full path to someone's checkout — none of which a reader
 * elsewhere can act on, and all of which say where this machine keeps things.
 *
 * The error's *kind* and its first line, with anything path-shaped removed, is
 * what is left: enough to tell a timeout from a refused connection, and
 * nothing that belongs to the person who ran it.
 */

/** An absolute POSIX path, wherever it appears in a message. */
const ABSOLUTE_PATH = /(?<![\w.])\/[^\s"'`,)]+/g

export function safeDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return "an unrecognized failure"

  const first = (error.message.split("\n")[0] ?? "").trim()
  const redacted = first.replace(ABSOLUTE_PATH, "<path>").slice(0, 200)
  return redacted.length === 0 ? error.name : `${error.name}: ${redacted}`
}
