/**
 * Focused inspection of one diagnostic or one test (#7).
 *
 * A facet page answers "what happened"; a focused request answers "what
 * exactly happened here". The difference is not a larger page — it is a
 * different shape, with the detail a compact record deliberately leaves out:
 * the full message rather than the capped one, the identity the diagnostic
 * belongs to, the frames beneath it, and every attempt a flaky test made.
 *
 * All of it comes from the immutable index. Nothing here reopens the Result
 * Bundle, and nothing here reruns anything — bundle-backed detail is layered
 * on afterwards by the caller, precisely so that its absence degrades this
 * view instead of preventing it.
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
} from "../domain/inspection.ts"
import {
  ACTIVITY_TEXT_CHAR_CAP,
  ATTACHMENT_METADATA_CAP,
  ATTACHMENT_TEXT_CHAR_CAP,
  FOCUSED_ACTIVITY_DEPTH_CAP,
  FOCUSED_ACTIVITY_NODE_CAP,
  FOCUSED_MESSAGE_CHAR_CAP,
  FOCUSED_STACK_FRAME_CAP,
  STACK_FRAME_TEXT_CHAR_CAP,
} from "../domain/limits.ts"
import type { IndexedOccurrence } from "./diagnostics.ts"
import { normalizeMessage } from "./diagnostics.ts"
import type { NormalizedIndex } from "./index-model.ts"

/** Bundle-backed detail, when a lazy read was possible. Empty otherwise. */
export type LazyDetail = {
  stackFrames?: StackFrame[]
  activities?: ActivityNode[]
  attachments?: AttachmentMetadata[]
}

/**
 * The expanded view of a diagnostic, from the index alone.
 *
 * The full message is recovered from the occurrence the diagnostic came from:
 * a `DiagnosticSummary` carries a message capped for a summary, and the point
 * of focusing is to see past that cap. Matching is by the same key that
 * deduplicated them in the first place — occurrence, normalized message and
 * location — so a focused view can never be built from a different failure
 * that merely reads alike.
 */
export function focusedDiagnostic(
  index: NormalizedIndex,
  diagnostic: DiagnosticSummary,
  lazy: LazyDetail = {},
): FocusedDiagnostic {
  const occurrence = occurrenceOf(index, diagnostic)
  const failure = matchingFailure(occurrence, diagnostic)

  return {
    id: diagnostic.id,
    kind: diagnostic.kind,
    message: capTo(failure?.message ?? diagnostic.message, FOCUSED_MESSAGE_CHAR_CAP),
    ...(occurrence === undefined ? {} : { identity: occurrence.identity }),
    ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
    stackFrames: capStackFrames(lazy.stackFrames ?? framesFromLocation(diagnostic.location)),
    activities: capActivities(lazy.activities ?? []),
    attachments: capAttachments(lazy.attachments ?? []),
  }
}

/**
 * The expanded view of a test, from the index alone.
 *
 * Its diagnostics travel with it because the alternative is a caller paging
 * the whole failures facet looking for the ones that mention this test, which
 * is both slower and easy to get subtly wrong.
 */
export function focusedTest(index: NormalizedIndex, occurrence: IndexedOccurrence): FocusedTest {
  return {
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
    diagnostics: index.testFailures.filter((entry) => entry.testId === occurrence.id),
  }
}

function occurrenceOf(
  index: NormalizedIndex,
  diagnostic: DiagnosticSummary,
): IndexedOccurrence | undefined {
  if (diagnostic.testId === undefined) return undefined
  return index.occurrences.find((occurrence) => occurrence.id === diagnostic.testId)
}

function matchingFailure(
  occurrence: IndexedOccurrence | undefined,
  diagnostic: DiagnosticSummary,
): { message: string; location?: SafeLocation } | undefined {
  if (occurrence === undefined) return undefined
  return occurrence.failures.find((failure) => {
    const normalized = normalizeMessage(failure.message)
    // The summary's message is a prefix of the full one whenever the cap bit,
    // and equal to it otherwise.
    return normalized.startsWith(diagnostic.message) && sameLocation(failure.location, diagnostic.location)
  })
}

function sameLocation(a: SafeLocation | undefined, b: SafeLocation | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.path === b.path && a.line === b.line && a.column === b.column
}

/**
 * A diagnostic with a source location has one frame that is certainly true:
 * where it was reported. That is not a stack, and it is not presented as a
 * deeper one — but a caller asking for frames and getting an empty list would
 * reasonably read it as "no location known", which is a different claim.
 */
function framesFromLocation(location: SafeLocation | undefined): StackFrame[] {
  return location === undefined ? [] : [{ location }]
}

function capStackFrames(frames: StackFrame[]): StackFrame[] {
  return frames.slice(0, FOCUSED_STACK_FRAME_CAP).map((frame) => ({
    ...(frame.symbol === undefined ? {} : { symbol: capTo(frame.symbol, STACK_FRAME_TEXT_CHAR_CAP) }),
    ...(frame.module === undefined ? {} : { module: capTo(frame.module, STACK_FRAME_TEXT_CHAR_CAP) }),
    ...(frame.location === undefined ? {} : { location: frame.location }),
  }))
}

/**
 * Cap the activity tree by total nodes and by depth at once.
 *
 * Both bounds are needed and neither implies the other: a hundred siblings and
 * a hundred-deep chain are the same node count and very different things to
 * read, and a tree that respected only one of them could still be unbounded in
 * the other.
 */
function capActivities(nodes: ActivityNode[]): ActivityNode[] {
  let remaining = FOCUSED_ACTIVITY_NODE_CAP

  const walk = (level: ActivityNode[], depth: number): ActivityNode[] => {
    if (depth > FOCUSED_ACTIVITY_DEPTH_CAP) return []
    const kept: ActivityNode[] = []
    for (const node of level) {
      if (remaining <= 0) break
      remaining -= 1
      kept.push({
        title: capTo(node.title, ACTIVITY_TEXT_CHAR_CAP),
        ...(node.message === undefined ? {} : { message: capTo(node.message, ACTIVITY_TEXT_CHAR_CAP) }),
        children: walk(node.children, depth + 1),
      })
    }
    return kept
  }

  return walk(nodes, 1)
}

function capAttachments(attachments: AttachmentMetadata[]): AttachmentMetadata[] {
  return attachments.slice(0, ATTACHMENT_METADATA_CAP).map((attachment) => ({
    name: capTo(attachment.name, ATTACHMENT_TEXT_CHAR_CAP),
    ...(attachment.mediaType === undefined
      ? {}
      : { mediaType: capTo(attachment.mediaType, ATTACHMENT_TEXT_CHAR_CAP) }),
    ...(attachment.byteSize === undefined ? {} : { byteSize: attachment.byteSize }),
    // Metadata only. v1 exposes no attachment contents and no attachment paths.
    contentAccessible: false,
  }))
}

function capTo(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap)
}
