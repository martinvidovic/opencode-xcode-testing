/**
 * Focused inspection of one diagnostic or one test (#7, #8).
 *
 * A facet page answers "what happened"; a focused request answers "what
 * exactly happened here". The difference is not a larger page — it is a
 * different shape, with the detail a compact record deliberately leaves out:
 * the full message rather than the capped one, the identity the diagnostic
 * belongs to, the frames beneath it, and every attempt a flaky test made.
 *
 * Two things are load-bearing throughout. Every cap that bites is **reported**,
 * because a silently shortened message is indistinguishable from a short one.
 * And when the whole view still will not fit the response cap, content is shed
 * in the reverse of #7's priority order — attachments, then activities, then
 * frames, and only then the message, whose start is always preserved — so what
 * survives is what a caller most needed.
 */

import type {
  ActivityNode,
  AttachmentMetadata,
  DiagnosticSummary,
  FocusedDiagnostic,
  FocusedTest,
  SafeLocation,
  StackFrame,
  TestAttempt,
  TruncationState,
} from "../domain/inspection.ts"
import {
  ACTIVITY_TEXT_CHAR_CAP,
  ATTACHMENT_METADATA_CAP,
  ATTACHMENT_TEXT_CHAR_CAP,
  FOCUSED_ACTIVITY_DEPTH_CAP,
  FOCUSED_ACTIVITY_NODE_CAP,
  FOCUSED_MESSAGE_CHAR_CAP,
  FOCUSED_STACK_FRAME_CAP,
  RESPONSE_BYTE_CAP,
  RESPONSE_ENVELOPE_BYTES,
  STACK_FRAME_TEXT_CHAR_CAP,
  SUMMARY_TEST_FAILURE_CAP,
} from "../domain/limits.ts"
import { halve, responseBytes } from "./cap.ts"
import type { IndexedOccurrence } from "./diagnostics.ts"
import { extractFrames } from "./frames.ts"
import type { NormalizedIndex } from "./index-model.ts"

/** Bundle-backed detail, when a lazy read was possible. */
export type LazyDetail = {
  activities: ActivityNode[]
  attachments: AttachmentMetadata[]
}

/**
 * What a lazy detail read produced, in #8's three shapes.
 *
 * - `available` — the recorded toolchain ran and extracted the detail.
 * - `incomplete` — the right toolchain ran and could not completely associate
 *   or extract it, including when its deadline expired. `annotation` says
 *   which, because "we ran out of time" and "the evidence is ambiguous" ask
 *   different things of a caller.
 * - `unsupported` — the recorded Xcode installation is unavailable or no
 *   longer identity-matched, so nothing may read the bundle at all.
 */
export type LazyOutcome =
  | { status: "available"; detail: LazyDetail }
  | { status: "incomplete"; detail?: undefined; annotation?: string }
  | { status: "unsupported"; detail?: undefined }

/** A focused view and the truncation it had to apply to fit. */
/**
 * A focused view, or the absence of one it could not honestly produce.
 *
 * `focused` is optional because the cap is absolute and a focused record can
 * be oversized on its own. Everything sheddable goes first, and what is left
 * is the identity and the safe location — which a caller acts on and which are
 * never shortened. When that alone does not fit there is nothing honest left
 * to return, so nothing is.
 */
export type Focused<T> = { focused?: T; truncation: TruncationState }

const UNTRUNCATED: TruncationState = {
  fieldTruncated: false,
  collectionTruncated: false,
  responseTruncated: false,
  hasMore: false,
}

/**
 * The expanded view of a diagnostic.
 *
 * The full message comes from the index's own record of it, keyed by
 * diagnostic ID. Recovering it by matching the capped message back against
 * occurrences would work only for test failures — a build error has no
 * occurrence at all — and would match by prefix, which is a guess.
 */
export function focusedDiagnostic(
  index: NormalizedIndex,
  diagnostic: DiagnosticSummary,
  trustedRoot: string,
  lazy: LazyDetail | undefined,
): Focused<FocusedDiagnostic> {
  const occurrence = occurrenceOf(index, diagnostic)
  const full = index.fullMessages[diagnostic.id] ?? diagnostic.message
  const message = capTo(full, FOCUSED_MESSAGE_CHAR_CAP)

  const extracted = extractFrames(full, trustedRoot)
  const frames = capCollection(extracted.frames.map(capFrame), FOCUSED_STACK_FRAME_CAP)
  const activities = capActivities(lazy?.activities ?? [])
  const attachments = capCollection(
    (lazy?.attachments ?? []).map(capAttachment),
    ATTACHMENT_METADATA_CAP,
  )

  const view: FocusedDiagnostic = {
    id: diagnostic.id,
    kind: diagnostic.kind,
    message: message.value,
    ...(occurrence === undefined ? {} : { identity: occurrence.identity }),
    ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
    stackFrames: frames.value,
    activities: activities.value,
    attachments: attachments.value,
  }

  return fit(view, {
    ...UNTRUNCATED,
    fieldTruncated: message.truncated,
    // Zero frames because none could be read is a collection we could not
    // fill, and #8 requires saying so rather than presenting an empty stack
    // as a complete one.
    collectionTruncated:
      frames.truncated || activities.truncated || attachments.truncated || !extracted.recognized,
  })
}

/**
 * The expanded view of a test.
 *
 * Its diagnostics travel with it because the alternative is a caller paging
 * the whole failures facet looking for the ones that mention this test, which
 * is both slower and easy to get subtly wrong.
 */
export function focusedTest(
  index: NormalizedIndex,
  occurrence: IndexedOccurrence,
  lazy: LazyDetail | undefined,
): Focused<FocusedTest> {
  const diagnostics = capCollection(
    index.testFailures.filter((entry) => entry.testId === occurrence.id),
    SUMMARY_TEST_FAILURE_CAP,
  )
  const activities = capActivities(lazy?.activities ?? [])

  const view: FocusedTest = {
    id: occurrence.id,
    identity: occurrence.identity,
    status: occurrence.status,
    ...(occurrence.durationMs === undefined ? {} : { durationMs: occurrence.durationMs }),
    attempts: occurrence.attempts.map(
      (attempt): TestAttempt => ({
        ordinal: attempt.ordinal,
        status: attempt.status,
        ...(attempt.durationMs === undefined ? {} : { durationMs: attempt.durationMs }),
      }),
    ),
    diagnostics: diagnostics.value,
    activities: activities.value,
  }

  return fit(view, {
    ...UNTRUNCATED,
    collectionTruncated: diagnostics.truncated || activities.truncated,
  })
}

/**
 * Shed content until the view fits the response cap, in reverse priority.
 *
 * #7 fixes the order: the envelope, identity and safe location come first,
 * then the full message, then leading stack frames, then parent-before-child
 * activities, then attachment metadata. Removing in reverse means a view that
 * barely fits still answers the question the caller most likely asked, and the
 * start of a truncated message is always what survives.
 */
function fit<T extends { message?: string }>(view: T, truncation: TruncationState): Focused<T> {
  const current: Record<string, unknown> = { ...view }
  let shedCollection = false
  let shortenedField = false

  const steps: Array<{ run: () => boolean; field: boolean }> = [
    { run: () => drop(current, "attachments"), field: false },
    { run: () => drop(current, "activities"), field: false },
    { run: () => drop(current, "stackFrames"), field: false },
    { run: () => drop(current, "diagnostics"), field: false },
    // Attempts are shed too. A focused test with a long retry history is
    // otherwise the one shape that can pass everything above and still not fit.
    { run: () => drop(current, "attempts"), field: false },
    { run: () => halveMessage(current), field: true },
  ]

  for (const step of steps) {
    if (fits(current)) break
    // Each step is retried until it stops helping, so halving the message runs
    // as many times as it must rather than once.
    while (!fits(current) && step.run()) {
      if (step.field) shortenedField = true
      else shedCollection = true
    }
  }

  // Everything sheddable is gone. If it still does not fit, what remains is
  // the identity and the location — the parts a caller acts on, and the parts
  // that cannot be shortened without becoming a different answer. Returning
  // them over the cap would break the one bound the contract fixes; returning
  // them halved would hand back an identifier that addresses nothing. So the
  // view is not returned at all, and the response says so.
  const overCap = !fits(current)

  const state: TruncationState = {
    ...truncation,
    // Each fact reported as itself. Saying a collection was cut when a string
    // was shortened is not a smaller inaccuracy than saying nothing.
    fieldTruncated: truncation.fieldTruncated || shortenedField,
    collectionTruncated: truncation.collectionTruncated || shedCollection,
    responseTruncated: shedCollection || shortenedField || overCap,
    ...(overCap ? { recordsOmitted: 1 } : {}),
  }

  return overCap ? { truncation: state } : { focused: current as T, truncation: state }
}

function fits(view: unknown): boolean {
  return responseBytes(view) + RESPONSE_ENVELOPE_BYTES <= RESPONSE_BYTE_CAP
}

/** Remove the last element of a collection. Returns false when it is empty. */
function drop(view: Record<string, unknown>, key: string): boolean {
  const value = view[key]
  if (!Array.isArray(value) || value.length === 0) return false
  view[key] = value.slice(0, -1)
  return true
}

/** Halve the message, keeping its start. Returns false once it cannot shrink. */
function halveMessage(view: Record<string, unknown>): boolean {
  const message = view["message"]
  if (typeof message !== "string" || message.length <= 1) return false
  view["message"] = halve(message)
  return true
}

function occurrenceOf(
  index: NormalizedIndex,
  diagnostic: DiagnosticSummary,
): IndexedOccurrence | undefined {
  if (diagnostic.testId === undefined) return undefined
  return index.occurrences.find((occurrence) => occurrence.id === diagnostic.testId)
}

type Capped<T> = { value: T; truncated: boolean }

function capTo(text: string, cap: number): Capped<string> {
  return text.length <= cap
    ? { value: text, truncated: false }
    : { value: text.slice(0, cap), truncated: true }
}

function capCollection<T>(items: T[], cap: number): Capped<T[]> {
  return items.length <= cap
    ? { value: items, truncated: false }
    : { value: items.slice(0, cap), truncated: true }
}

function capFrame(frame: StackFrame): StackFrame {
  return {
    ...(frame.symbol === undefined
      ? {}
      : { symbol: capTo(frame.symbol, STACK_FRAME_TEXT_CHAR_CAP).value }),
    ...(frame.module === undefined
      ? {}
      : { module: capTo(frame.module, STACK_FRAME_TEXT_CHAR_CAP).value }),
    ...(frame.location === undefined ? {} : { location: capLocation(frame.location) }),
  }
}

function capLocation(location: SafeLocation): SafeLocation {
  return {
    path: capTo(location.path, STACK_FRAME_TEXT_CHAR_CAP).value,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
  }
}

/**
 * Cap the activity tree by total nodes and by depth at once.
 *
 * Both bounds are needed and neither implies the other: a hundred siblings and
 * a hundred-deep chain are the same node count and very different things to
 * read, and a tree that respected only one of them could still be unbounded in
 * the other. Parents are kept before children, per #7's priority order.
 */
function capActivities(nodes: ActivityNode[]): Capped<ActivityNode[]> {
  let remaining = FOCUSED_ACTIVITY_NODE_CAP
  let truncated = false

  const walk = (level: ActivityNode[], depth: number): ActivityNode[] => {
    if (depth > FOCUSED_ACTIVITY_DEPTH_CAP) {
      truncated = truncated || level.length > 0
      return []
    }
    const kept: ActivityNode[] = []
    for (const node of level) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      remaining -= 1
      const title = capTo(node.title, ACTIVITY_TEXT_CHAR_CAP)
      const message = node.message === undefined ? undefined : capTo(node.message, ACTIVITY_TEXT_CHAR_CAP)
      truncated = truncated || title.truncated || message?.truncated === true
      kept.push({
        title: title.value,
        ...(message === undefined ? {} : { message: message.value }),
        children: walk(node.children, depth + 1),
      })
    }
    return kept
  }

  return { value: walk(nodes, 1), truncated }
}

function capAttachment(attachment: AttachmentMetadata): AttachmentMetadata {
  return {
    name: capTo(attachment.name, ATTACHMENT_TEXT_CHAR_CAP).value,
    ...(attachment.mediaType === undefined
      ? {}
      : { mediaType: capTo(attachment.mediaType, ATTACHMENT_TEXT_CHAR_CAP).value }),
    ...(attachment.byteSize === undefined ? {} : { byteSize: attachment.byteSize }),
    // Metadata only. v1 exposes no attachment contents and no attachment paths.
    contentAccessible: false,
  }
}
