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
import { safeFailure } from "./sanitize.ts"

/** The documented host defaults, applied because the host does not. */
export const HOST_DEFAULT_MAX_LINES = 2_000
export const HOST_DEFAULT_MAX_BYTES = 51_200

/** Baseline self-caps, per ADR 0002. */
export const SELF_CAP_LINES = 1_900
export const SELF_CAP_BYTES = 32 * 1024

/** Kept clear of the host limit so rounding can never reach it. */
export const SAFETY_MARGIN_LINES = 50
export const SAFETY_MARGIN_BYTES = 2_048

/**
 * What the host said about `tool_output`, and whether it said anything.
 *
 * Three answers, not two (issue #82). "The host has no limits configured" and
 * "the host could not be asked" were the same value, and they are not the same
 * situation: the first means the documented defaults are exactly right, and
 * the second means nothing is known — including whether the user has
 * configured something *lower* than the defaults this adapter would then help
 * itself to.
 *
 * That was the whole failure mode. A read that failed silently produced a
 * budget built from 2,000 lines, on a machine whose owner may have set 200 —
 * and the adapter's one invariant is that host truncation is unreachable,
 * because a truncated response is replaced with a pointer to a directory the
 * model cannot open.
 */
export type HostLimits =
  | { status: "configured"; maxLines?: number; maxBytes?: number }
  /** The host answered, and has no `tool_output` block. */
  | { status: "absent" }
  /** The host could not be asked, or did not answer usefully. */
  | { status: "unreadable"; detail: string }

/**
 * Ask the host for its effective `tool_output` limits.
 *
 * Never throws: a configuration route that is unavailable is an answer about
 * the host, not a reason for the plugin to fail to load.
 */
export async function readOutputLimits(client: {
  config: { get(): Promise<{ data?: unknown }> }
}): Promise<HostLimits> {
  let payload: unknown
  try {
    payload = (await client.config.get()).data
  } catch (error) {
    return { status: "unreadable", detail: safeFailure(error) }
  }

  if (typeof payload !== "object" || payload === null) {
    return { status: "unreadable", detail: "the host's configuration route returned no object" }
  }
  return outputLimitsIn(payload)
}

/**
 * `tool_output` out of a host configuration payload.
 *
 * Narrowed rather than asserted, because the declared shape and the real one
 * do not agree. The `Config` the linked `@opencode-ai/plugin` client returns
 * has **no `tool_output` at all**; the SDK's own v2 types do declare it. So a
 * signature naming the field was describing a payload the installed types say
 * cannot contain it, and only Bun's willingness to strip the claim kept it
 * from being an error (issue #74).
 *
 * A block that is absent and a block whose numbers are unusable are different
 * answers. The first is a host with nothing configured, where the documented
 * defaults are exactly right. The second is a host that said something this
 * adapter could not read, which is not a reason to assume anything about it.
 */
function outputLimitsIn(config: object): HostLimits {
  const limits = (config as { tool_output?: unknown }).tool_output
  if (limits === undefined) return { status: "absent" }
  if (typeof limits !== "object" || limits === null) {
    return { status: "unreadable", detail: "the host's `tool_output` is not an object" }
  }

  const { max_lines: maxLines, max_bytes: maxBytes } = limits as Record<string, unknown>
  const usable = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0

  // A block that is present and carries neither usable number tells us nothing
  // we can act on, and saying "absent" about it would be a guess.
  //
  // One unusable field discards the other on purpose. A host whose
  // `max_bytes` is nonsense is a host this adapter does not understand, and
  // keeping its `max_lines` would mean trusting half of an answer that has
  // already been shown to be malformed — while quietly assuming the documented
  // default for the half that was not.
  if (maxLines !== undefined && !usable(maxLines)) {
    return { status: "unreadable", detail: "the host's `tool_output.max_lines` is not a count" }
  }
  if (maxBytes !== undefined && !usable(maxBytes)) {
    return { status: "unreadable", detail: "the host's `tool_output.max_bytes` is not a count" }
  }
  if (maxLines === undefined && maxBytes === undefined) return { status: "absent" }

  return {
    status: "configured",
    ...(usable(maxLines) ? { maxLines } : {}),
    ...(usable(maxBytes) ? { maxBytes } : {}),
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
export function resolveBudget(limits: HostLimits): Budget {
  const ceiling = ceilingFor(limits)

  // The host's own limit is part of the minimum, not only the margined one:
  // flooring above it would put us back over the very line the margin exists
  // to keep us under, absurdly small limits included.
  return {
    maxLines: Math.max(
      1,
      Math.min(SELF_CAP_LINES, ceiling.lines - SAFETY_MARGIN_LINES, ceiling.lines),
    ),
    maxBytes: Math.max(
      1,
      Math.min(SELF_CAP_BYTES, ceiling.bytes - SAFETY_MARGIN_BYTES, ceiling.bytes),
    ),
  }
}

/**
 * The limit to stay under, given what the host was able to tell us.
 *
 * An **absent** block means the host has none configured, and the documented
 * defaults are what it will apply — so they are the right ceiling.
 *
 * An **unreadable** answer means nothing is known, and that is the case the
 * defaults get wrong. Helping ourselves to 2,000 lines because we could not
 * ask is precisely how a user who configured 200 gets their output replaced by
 * a pointer to a directory their model cannot open.
 */
function ceilingFor(limits: HostLimits): { lines: number; bytes: number } {
  switch (limits.status) {
    case "configured":
      return {
        lines: limits.maxLines ?? HOST_DEFAULT_MAX_LINES,
        bytes: limits.maxBytes ?? HOST_DEFAULT_MAX_BYTES,
      }
    case "absent":
      return { lines: HOST_DEFAULT_MAX_LINES, bytes: HOST_DEFAULT_MAX_BYTES }
    case "unreadable":
      return { lines: UNREADABLE_MAX_LINES, bytes: UNREADABLE_MAX_BYTES }
  }
}

/**
 * What to assume when the host could not be asked.
 *
 * A tenth of the documented defaults, and the number is a policy rather than a
 * measurement: it covers every lowering anyone is likely to configure by hand,
 * and it cannot cover all of them. **No fallback can** — a user may set
 * `max_lines: 10`, and an adapter that cannot read the configuration cannot
 * know. ADR 0002 records that the no-host-truncation guarantee is unconditional
 * only while the limits are readable, and conditional on this floor otherwise.
 *
 * Which is why an unreadable read is also *announced*. A conservative guess
 * nobody is told about is still a guess; one that is printed is a fact the
 * person running it can act on.
 */
export const UNREADABLE_MAX_LINES = 200
export const UNREADABLE_MAX_BYTES = 5_120

/** The budget for a host that has told us nothing, and could be asked. */
export const DEFAULT_BUDGET: Budget = resolveBudget({ status: "absent" })

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
