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
  /** Sampled observed tests: the first thing worth dropping. */
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

/** Indented continuation, for the lines beneath a diagnostic. */
export function indent(depth: number, text: string): string {
  return `${"  ".repeat(depth)}${text}`
}
