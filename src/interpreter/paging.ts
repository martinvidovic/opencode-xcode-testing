/**
 * Ordinary paging over the published index (#7).
 *
 * Everything here reads the immutable index and nothing else — inspection never
 * reruns tests, never reopens the Result Bundle for a plain page, and never
 * accepts a Result Bundle path. A missing run is an answer, not an exception:
 * only a defect in the Test Tool itself throws.
 */

import type {
  DiagnosticSummary,
  FocusedDiagnostic,
  FocusedTest,
  InspectRunRequest,
  LogChunk,
  TestRecord,
} from "../domain/inspection.ts"
import type { InspectionResponse, TruncationState } from "../domain/inspection.ts"
import {
  INSPECTION_PAGE_DEFAULT,
  INSPECTION_PAGE_MAX,
  RESPONSE_BYTE_CAP,
} from "../domain/limits.ts"
import type { ScopeAttestation } from "../domain/scope.ts"
import { CURSOR_ORDERING_VERSION, decodeCursor, encodeCursor } from "./cursor.ts"
import { capRecords, responseBytes, withResponseTruncation } from "./cap.ts"
import { focusedDiagnostic, focusedTest, type LazyDetail } from "./focus.ts"
import {
  chunkLog,
  logWindow,
  LOG_CHUNK_MIN_BYTES,
  type ChunkedLog,
  type LogWindow,
} from "./log.ts"
import type { NormalizedIndex } from "./index-model.ts"

/** One page of a structured facet, tagged so a caller cannot confuse two facets. */
export type FacetPage =
  | { facet: "scope"; records: ScopeAttestation[] }
  | { facet: "failures"; records: DiagnosticSummary[] }
  | { facet: "buildErrors"; records: DiagnosticSummary[] }
  | { facet: "tests"; records: TestRecord[] }
  | { facet: "log"; chunk: LogChunk }
  | { facet: "failures"; focused: FocusedDiagnostic }
  | { facet: "buildErrors"; focused: FocusedDiagnostic }
  | { facet: "tests"; focused: FocusedTest }

/**
 * Room reserved for everything a page carries besides its records: the status,
 * the facet tag, the truncation state, and a cursor. Generous on purpose — the
 * cap is a ceiling to stay under, not a budget to spend exactly.
 */
const ENVELOPE_OVERHEAD_BYTES = 1_024

export function inspectIndex(
  index: NormalizedIndex,
  request: InspectRunRequest,
  secret: Buffer,
  lazy?: LazyDetail,
): InspectionResponse<FacetPage> {
  const rejection = validateRequest(index, request)
  if (rejection !== undefined) return rejection

  if (request.facet === "log") {
    // Log content lives on disk under the retention contract, not in the
    // index, so the caller reads the bytes and `inspectLog` shapes them.
    return invalid("the log facet is read by byte range, not by index position")
  }

  if (request.diagnosticId !== undefined) return focusDiagnostic(index, request.diagnosticId, lazy)
  if (request.testId !== undefined) return focusTest(index, request.testId)

  const position = resolveCursor(index, request, secret)
  if (position.ok === false) return position.response

  const limit = request.limit ?? INSPECTION_PAGE_DEFAULT
  return page(index, request.facet, position.value, limit, secret)
}

/**
 * The checks every facet shares, applied before any of them reads anything.
 *
 * Shared because a request that is malformed is malformed whichever facet it
 * names, and a log request that skipped these would be the one place a caller
 * could combine a cursor with an identifier.
 */
function validateRequest(
  index: NormalizedIndex,
  request: InspectRunRequest,
): InspectionResponse<FacetPage> | undefined {
  if (request.runId !== index.runId) return { status: "notFound", subject: "run" }

  if (request.diagnosticId !== undefined && request.testId !== undefined) {
    return invalid("a request may focus on a diagnostic or a test, not both")
  }
  if (request.cursor !== undefined && (request.diagnosticId ?? request.testId) !== undefined) {
    return invalid("identifiers and cursors cannot be combined")
  }
  if (request.limit !== undefined) {
    if (!Number.isInteger(request.limit) || request.limit < 1) {
      return invalid("limit must be a positive integer")
    }
    if (request.limit > INSPECTION_PAGE_MAX) {
      return invalid(`limit may be at most ${INSPECTION_PAGE_MAX}`)
    }
  }
  if (request.maxBytes !== undefined && (!Number.isInteger(request.maxBytes) || request.maxBytes < 1)) {
    return invalid("maxBytes must be a positive integer")
  }
  return undefined
}

/**
 * Where in the retained log a request starts, or why it cannot.
 *
 * Resolved before the file is opened, so the caller reads one bounded window
 * rather than deciding what to read after loading something.
 */
export function resolveLogWindow(
  index: NormalizedIndex,
  request: InspectRunRequest,
  secret: Buffer,
): { ok: true; window: LogWindow } | { ok: false; response: InspectionResponse<FacetPage> } {
  const rejection = validateRequest(index, request)
  if (rejection !== undefined) return { ok: false, response: rejection }
  if (request.diagnosticId !== undefined || request.testId !== undefined) {
    return { ok: false, response: invalid("the log facet has no diagnostics or tests to focus on") }
  }

  const position = resolveCursor(index, request, secret)
  if (position.ok === false) return { ok: false, response: position.response }
  return { ok: true, window: logWindow(request, position.value) }
}

/**
 * One chunk of the retained log, with the cursor that continues it.
 *
 * Whether the log exists at all is the caller's question, asked before it
 * opens anything: a log that was never retained and a log that retention has
 * since deleted are different answers, and a missing file looks the same for
 * both. What is left here is how much to trust the bytes that did arrive.
 */
export function inspectLog(
  index: NormalizedIndex,
  bytes: Buffer,
  byteOffset: number,
  totalBytes: number,
  secret: Buffer,
): InspectionResponse<FacetPage> {
  // Raw bytes are not response bytes: JSON escaping turns one newline into
  // two and one control character into six, so a window sized against the cap
  // in advance would still overshoot it. The chunk is shrunk against its own
  // serialized size instead, which is the only measure the cap is about.
  const fitted = fitChunk(bytes, byteOffset, totalBytes)
  const { chunk, hasMore, nextByteOffset } = fitted.chunked

  const cursor = hasMore
    ? encodeCursor(secret, {
        runId: index.runId,
        facet: "log",
        orderingVersion: CURSOR_ORDERING_VERSION,
        position: nextByteOffset,
      })
    : undefined

  const truncation: TruncationState = {
    fieldTruncated: false,
    collectionTruncated: hasMore,
    responseTruncated: fitted.shrunk,
    hasMore,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  }

  const data: FacetPage = { facet: "log", chunk }
  // `incomplete` is the honest word for a log whose retained bytes are a lower
  // bound: an empty page does not authoritatively mean there was no output.
  return index.log.availability === "incomplete"
    ? { status: "incomplete", data, truncation }
    : { status: "available", completeness: "complete", data, truncation }
}

/**
 * The largest prefix of `bytes` whose serialized chunk fits the response cap.
 *
 * Halving rather than measuring-and-solving: escaping expansion depends on the
 * content, so there is no size to compute directly, and a handful of halvings
 * converges from the maximum window to whatever this particular text allows.
 * The floor is one character's worth, so the cursor always moves.
 */
function fitChunk(
  bytes: Buffer,
  byteOffset: number,
  totalBytes: number,
): { chunked: ChunkedLog; shrunk: boolean } {
  let length = bytes.length
  let chunked = chunkLog(bytes, byteOffset, totalBytes)

  while (
    responseBytes(chunked.chunk) + ENVELOPE_OVERHEAD_BYTES > RESPONSE_BYTE_CAP &&
    length > LOG_CHUNK_MIN_BYTES
  ) {
    length = Math.max(LOG_CHUNK_MIN_BYTES, Math.floor(length / 2))
    chunked = chunkLog(bytes.subarray(0, length), byteOffset, totalBytes)
  }

  return { chunked, shrunk: length < bytes.length }
}

function page(
  index: NormalizedIndex,
  facet: "scope" | "failures" | "buildErrors" | "tests",
  position: number,
  limit: number,
  secret: Buffer,
): InspectionResponse<FacetPage> {
  const all = recordsFor(index, facet)
  const asked = all.slice(position, position + limit)

  // The cap is applied before the cursor is issued, not after the page is
  // built: a cursor that pointed past records the response had to drop would
  // skip evidence silently, which is the one paging failure a caller cannot
  // detect from the outside.
  const capped = capRecords(asked, ENVELOPE_OVERHEAD_BYTES)
  const slice = capped.records
  const nextPosition = position + slice.length
  const hasMore = nextPosition < all.length

  const cursor = hasMore
    ? encodeCursor(secret, {
        runId: index.runId,
        facet,
        orderingVersion: CURSOR_ORDERING_VERSION,
        position: nextPosition,
      })
    : undefined

  const truncation: TruncationState = withResponseTruncation(
    {
      fieldTruncated: false,
      collectionTruncated: hasMore,
      responseTruncated: false,
      hasMore,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
    },
    capped.dropped,
    cursor,
  )

  const data = { facet, records: slice } as FacetPage
  const completeness = facetCompleteness(index, facet)

  if (completeness === "unavailable") return { status: "unsupported", facet }
  if (completeness === "partial") return { status: "incomplete", data, truncation }
  return { status: "available", completeness, data, truncation }
}

function recordsFor(
  index: NormalizedIndex,
  facet: "scope" | "failures" | "buildErrors" | "tests",
): Array<ScopeAttestation | DiagnosticSummary | TestRecord> {
  switch (facet) {
    case "scope":
      return index.attestations
    case "failures":
      return index.testFailures
    case "buildErrors":
      return index.buildErrors
    case "tests":
      return index.occurrences.map(toTestRecord)
  }
}

export function toTestRecord(occurrence: NormalizedIndex["occurrences"][number]): TestRecord {
  return {
    id: occurrence.id,
    identity: occurrence.identity,
    status: occurrence.status,
    ...(occurrence.durationMs === undefined ? {} : { durationMs: occurrence.durationMs }),
    failureCount: occurrence.failures.length,
  }
}

function facetCompleteness(
  index: NormalizedIndex,
  facet: "scope" | "failures" | "buildErrors" | "tests",
): "complete" | "partial" | "unavailable" {
  switch (facet) {
    case "buildErrors":
      return index.build.completeness
    // Failures answer to the diagnostic record, not to the test counts. A run
    // that counted every test and lost its supplemental failure detail has a
    // complete `tests` facet and an incomplete `failures` one.
    case "failures":
      return index.diagnostics.completeness
    case "scope":
    case "tests":
      return index.tests.completeness
  }
}

function focusDiagnostic(
  index: NormalizedIndex,
  id: string,
  lazy: LazyDetail | undefined,
): InspectionResponse<FacetPage> {
  const failure = index.testFailures.find((record) => record.id === id)
  if (failure !== undefined) {
    return focusedResponse({ facet: "failures", focused: focusedDiagnostic(index, failure, lazy) }, lazy)
  }
  const buildError = index.buildErrors.find((record) => record.id === id)
  if (buildError !== undefined) {
    return focusedResponse(
      { facet: "buildErrors", focused: focusedDiagnostic(index, buildError, lazy) },
      lazy,
    )
  }
  // Deliberately does not say which run it was not found in.
  return { status: "notFound", subject: "diagnostic" }
}

function focusTest(index: NormalizedIndex, id: string): InspectionResponse<FacetPage> {
  const occurrence = index.occurrences.find((record) => record.id === id)
  if (occurrence === undefined) return { status: "notFound", subject: "test" }
  // Nothing in a focused test is bundle-backed: attempts and diagnostics are
  // both indexed, so this view never degrades.
  return single({ facet: "tests", focused: focusedTest(index, occurrence) })
}

/**
 * A focused view, marked `incomplete` when bundle-backed detail was not read.
 *
 * The distinction matters to a caller in exactly one way, and it is the way
 * that counts: on an `available` response an empty `activities` list means the
 * test recorded none, and on an `incomplete` one it means nobody could look.
 */
function focusedResponse(data: FacetPage, lazy: LazyDetail | undefined): InspectionResponse<FacetPage> {
  if (lazy === undefined) {
    return {
      status: "incomplete",
      data,
      truncation: {
        fieldTruncated: false,
        collectionTruncated: false,
        responseTruncated: false,
        hasMore: false,
      },
    }
  }
  return single(data)
}

function single(data: FacetPage): InspectionResponse<FacetPage> {
  return {
    status: "available",
    completeness: "complete",
    data,
    truncation: {
      fieldTruncated: false,
      collectionTruncated: false,
      responseTruncated: false,
      hasMore: false,
    },
  }
}

type Position = { ok: true; value: number } | { ok: false; response: InspectionResponse<FacetPage> }

function resolveCursor(
  index: NormalizedIndex,
  request: InspectRunRequest,
  secret: Buffer,
): Position {
  if (request.cursor === undefined) return { ok: true, value: 0 }

  const decoded = decodeCursor(secret, request.cursor)
  if (!decoded.ok) {
    return { ok: false, response: invalid("the cursor could not be authenticated") }
  }
  if (decoded.payload.runId !== index.runId) {
    return { ok: false, response: invalid("the cursor belongs to another Test Run") }
  }
  if (decoded.payload.facet !== request.facet) {
    return { ok: false, response: invalid("the cursor belongs to another facet") }
  }
  if (decoded.payload.orderingVersion !== CURSOR_ORDERING_VERSION) {
    return { ok: false, response: invalid("the cursor uses an unsupported ordering version") }
  }
  return { ok: true, value: decoded.payload.position }
}

function invalid(message: string): InspectionResponse<FacetPage> {
  return { status: "invalid", message }
}
