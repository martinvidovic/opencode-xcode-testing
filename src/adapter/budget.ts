/**
 * The adapter's output budget (ADR 0002).
 *
 * The adapter enforces its own cap so that **host truncation is unreachable by
 * construction**. This matters beyond tidiness: when the host truncates, it
 * replaces the output with a pointer to a truncation directory — and the model
 * has no file access, so that pointer is worse than useless. Never tripping it
 * is an adapter invariant, and tripping our own last-resort truncation is a
 * defect the tests cover.
 *
 * The host does not materialize `tool_output` defaults: an unset block arrives
 * as `undefined`, so the adapter applies the documented defaults itself, and
 * then keeps a safety margin under whatever the effective limit turns out to be.
 */

import { SEPARATOR, type Document } from "./document.ts"

/** The documented host defaults, applied because the host does not. */
export const HOST_DEFAULT_MAX_LINES = 2_000
export const HOST_DEFAULT_MAX_BYTES = 51_200

/** Baseline self-caps, per ADR 0002. */
export const SELF_CAP_LINES = 1_900
export const SELF_CAP_BYTES = 32 * 1024

/** Kept clear of the host limit so rounding can never reach it. */
export const SAFETY_MARGIN_LINES = 50
export const SAFETY_MARGIN_BYTES = 2_048

export type HostOutputLimits = { max_lines?: number; max_bytes?: number } | undefined

/**
 * The host's effective `tool_output` limits, or undefined when they cannot be
 * read.
 *
 * Undefined is not "no limits": the host does not materialize its own
 * defaults, so `resolveBudget` applies the documented ones. A host that cannot
 * be asked is therefore treated exactly like a host that was never configured,
 * which is the conservative reading of both.
 */
export async function readOutputLimits(client: {
  config: { get(): Promise<{ data?: unknown }> }
}): Promise<HostOutputLimits> {
  try {
    return outputLimitsIn((await client.config.get()).data)
  } catch {
    return undefined
  }
}

/**
 * `tool_output`, if what came back has one this shape (issue #74).
 *
 * Narrowed rather than asserted, because the declared shape and the real one
 * do not agree. The `Config` the linked `@opencode-ai/plugin` client returns
 * has **no `tool_output` at all**; the SDK's own v2 types do declare it. So a
 * signature naming the field was describing a payload the installed types say
 * cannot contain it, and only Bun's willingness to strip the claim kept it
 * from being an error.
 *
 * Which of the two is right about the host this adapter runs against is #82's
 * question. What this can do is stop asserting an answer: it reads whatever
 * arrives, takes the numbers if they are numbers, and otherwise says it could
 * not be read — which `resolveBudget` already treats as "apply the documented
 * defaults", the conservative reading either way.
 */
function outputLimitsIn(config: unknown): HostOutputLimits {
  if (typeof config !== "object" || config === null) return undefined
  const limits = (config as { tool_output?: unknown }).tool_output
  if (typeof limits !== "object" || limits === null) return undefined

  const { max_lines: maxLines, max_bytes: maxBytes } = limits as Record<string, unknown>
  return {
    ...(typeof maxLines === "number" ? { max_lines: maxLines } : {}),
    ...(typeof maxBytes === "number" ? { max_bytes: maxBytes } : {}),
  }
}

export type Budget = { maxLines: number; maxBytes: number }

/**
 * Resolve the effective budget once per session — the host's configuration is
 * not hot-reloaded, so re-reading it per call could only invent the
 * possibility of two calls in one session disagreeing.
 *
 * Once, but not at startup: the plugin factory runs inside the host's own
 * bootstrap, and asking the host for its configuration from there deadlocks it.
 * ADR 0002 records the amendment and why it is unavoidable.
 */
export function resolveBudget(limits: HostOutputLimits): Budget {
  const hostLines = limits?.max_lines ?? HOST_DEFAULT_MAX_LINES
  const hostBytes = limits?.max_bytes ?? HOST_DEFAULT_MAX_BYTES

  // The host's own limit is part of the minimum, not only the margined one:
  // flooring above it would put us back over the very line the margin exists
  // to keep us under, absurdly small limits included.
  return {
    maxLines: Math.max(1, Math.min(SELF_CAP_LINES, hostLines - SAFETY_MARGIN_LINES, hostLines)),
    maxBytes: Math.max(1, Math.min(SELF_CAP_BYTES, hostBytes - SAFETY_MARGIN_BYTES, hostBytes)),
  }
}

/** The default budget, for a host that told us nothing. */
export const DEFAULT_BUDGET: Budget = resolveBudget(undefined)

export type SerializeResult = {
  text: string
  /** Whole blocks dropped to fit. Zero for every ordinary response. */
  droppedBlocks: number
  /** True when even the highest-priority blocks had to be cut mid-document. */
  hardTruncated: boolean
}

const OMITTED_NOTE = (count: number) =>
  `[${count} section${count === 1 ? "" : "s"} omitted to stay within the output budget]`

const TRUNCATED_NOTE = "[output truncated to stay within the output budget]"

/**
 * Serialize a document under a budget.
 *
 * Whole blocks are dropped from the lowest priority upward, because returning
 * fewer intact sections is more useful than returning every section shredded.
 * Only if that is not enough does the text get cut, and that path is a defect
 * rather than an expected cost.
 */
export function serialize(document: Document, budget: Budget): SerializeResult {
  const ordered = [...document].sort((a, b) => a.priority - b.priority)
  const keep = new Set(ordered)
  let droppedBlocks = 0

  for (;;) {
    const candidate = assemble(document, keep, droppedBlocks)
    if (fits(candidate, budget)) {
      return { text: candidate, droppedBlocks, hardTruncated: false }
    }

    // Drop the lowest-priority surviving block and try again. The
    // highest-priority block is never dropped: a response consisting only of a
    // note saying something was omitted tells the caller nothing at all, so if
    // even the envelope will not fit it is cut rather than removed.
    const victim =
      keep.size > 1 ? [...ordered].reverse().find((entry) => keep.has(entry)) : undefined
    if (victim === undefined) break
    keep.delete(victim)
    droppedBlocks += 1
  }

  const text = hardTruncate(assemble(document, keep, droppedBlocks), budget)
  return { text, droppedBlocks, hardTruncated: true }
}

function assemble(document: Document, keep: Set<Document[number]>, dropped: number): string {
  const rendered = document
    .filter((entry) => keep.has(entry) && entry.lines.length > 0)
    .map((entry) => entry.lines.join("\n"))

  if (dropped > 0) rendered.push(OMITTED_NOTE(dropped))
  return `${rendered.join(`\n${SEPARATOR}\n`)}\n`
}

function fits(text: string, budget: Budget): boolean {
  return lineCount(text) <= budget.maxLines && byteLength(text) <= budget.maxBytes
}

/**
 * The last resort. It preserves the start of the document, which is where the
 * envelope and the classification facts live, and always leaves room for the
 * note saying it happened.
 */
function hardTruncate(text: string, budget: Budget): string {
  const note = `${TRUNCATED_NOTE}\n`
  const noteBytes = byteLength(note)

  // With room for a single line, one line of real content beats one line
  // saying there was content.
  if (budget.maxLines <= 1) {
    return `${truncateToBytes(text.split("\n")[0] ?? "", Math.max(0, budget.maxBytes - 1))}\n`
  }

  let lines = text.split("\n")
  if (lines.length > budget.maxLines - 1) lines = lines.slice(0, Math.max(1, budget.maxLines - 1))

  let candidate = `${lines.join("\n")}\n`
  while (byteLength(candidate) + noteBytes > budget.maxBytes && lines.length > 1) {
    lines = lines.slice(0, -1)
    candidate = `${lines.join("\n")}\n`
  }

  // A single line that is itself oversized is cut on a byte boundary that
  // cannot split a UTF-8 sequence.
  if (byteLength(candidate) + noteBytes > budget.maxBytes) {
    candidate = `${truncateToBytes(lines[0] ?? "", budget.maxBytes - noteBytes - 1)}\n`
  }

  return `${candidate}${note}`
}

export function lineCount(text: string): number {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** Cut without ever splitting a multi-byte sequence. */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end -= 1
  return text.slice(0, end)
}
