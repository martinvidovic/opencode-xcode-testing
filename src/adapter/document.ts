/**
 * The rendered document: blocks with priorities, before any budget is applied.
 *
 * Separating "what to say" from "how much fits" is what makes the output budget
 * provable. The renderer produces a complete document and never thinks about
 * size; the serializer drops whole low-priority blocks in a fixed order and,
 * only as a last resort, truncates. Neither has to know about the other.
 */

/**
 * Lower survives longer. The ordering follows #7's truncation priority:
 * the envelope, status and identifiers first, then the facts a caller needs to
 * act, then the detail that inspection can deliver later anyway.
 */
export const PRIORITY = {
  /** Outcome line, run id, and anything that identifies the response. */
  envelope: 0,
  /** Counts, evidence completeness, scope verdict — the classification facts. */
  facts: 1,
  /** Why an outcome was reached: reasons, messages, validation errors. */
  reason: 2,
  /** Failure and build-error diagnostics. */
  diagnostics: 3,
  /** Provenance, timing, inspection availability. */
  context: 4,
  /**
   * The first thing worth dropping, whatever it is.
   *
   * Sampled observed tests, and a log window's text — which a caller can ask
   * for again, unlike the byte range that says where to ask from (issue #82).
   * Named for its rank rather than for one of its occupants, because a
   * priority whose comment lists a single facet stops describing the ladder
   * the moment anything else needs the same rank.
   */
  sample: 5,
} as const

export type Block = {
  priority: number
  lines: string[]
}

export type Document = Block[]

export function block(priority: number, ...lines: Array<string | undefined>): Block {
  return { priority, lines: lines.filter((line): line is string => line !== undefined) }
}

/** A blank line between blocks, rendered only where blocks actually survive. */
export const SEPARATOR = ""

/** The label column every fact line aligns to. */
const LABEL_WIDTH = 15

export function field(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

/**
 * Whether a rendered line is one of the `label   value` fields above.
 *
 * Here rather than at the one call site that reads a rendered document back
 * (the acceptance gate, which quotes the reason under a mismatched headline),
 * because a reader that reverse-engineers this layout from somewhere else goes
 * quietly wrong the moment `LABEL_WIDTH` changes, and nothing fails.
 */
export function isField(line: string): boolean {
  const label = line.slice(0, LABEL_WIDTH)
  return (
    line.length > LABEL_WIDTH &&
    label.trimEnd().length > 0 &&
    label.endsWith(" ") &&
    line[LABEL_WIDTH] !== " "
  )
}

/** Indented continuation, for the lines beneath a diagnostic. */
export function indent(depth: number, text: string): string {
  return `${"  ".repeat(depth)}${text}`
}
