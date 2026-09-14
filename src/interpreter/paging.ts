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
  InspectionFacet,
  InspectRunRequest,
  LogChunk,
  TestRecord,
  TruncationState,
} from "../domain/inspection.ts"
import type { InspectionResponse, TruncationState } from "../domain/inspection.ts"
import {
  INSPECTION_PAGE_DEFAULT,
  INSPECTION_PAGE_MAX,
  LOG_CHUNK_MIN_BYTES,
  RESPONSE_BYTE_CAP,
  RESPONSE_ENVELOPE_BYTES,
} from "../domain/limits.ts"
import type { ScopeAttestation } from "../domain/scope.ts"
import { CURSOR_ORDERING_VERSION, decodeCursor, encodeCursor } from "./cursor.ts"
import { capRecords, responseBytes } from "./cap.ts"
import { focusedDiagnostic, focusedTest, type LazyOutcome } from "./focus.ts"
import { chunkLog, logWindow, type ChunkedLog, type LogWindow } from "./log.ts"
import type { NormalizedIndex } from "./index-model.ts"

/** One page of a structured facet, tagged so a caller cannot confuse two facets. */
/**
 * One page of one facet.
 *
 * `view` discriminates, not `facet`: a focused diagnostic and a page of
 * diagnostics are both the `failures` facet and are entirely different
 * shapes, so the facet alone cannot tell a reader which one it is holding.
 */
export type FacetPage =
  | { view: "records"; facet: "scope"; records: ScopeAttestation[] }
  | { view: "records"; facet: "failures"; records: DiagnosticSummary[] }
  | { view: "records"; facet: "buildErrors"; records: DiagnosticSummary[] }
  | { view: "records"; facet: "tests"; records: TestRecord[] }
  | { view: "log"; facet: "log"; chunk: LogChunk }
  | { view: "focused"; facet: "failures" | "buildErrors"; focused: FocusedDiagnostic }
  | { view: "focused"; facet: "tests"; focused: FocusedTest }
  /**
   * The record was found and cannot be returned within the response cap.
   *
   * A distinct view rather than a focused one with an empty body, because the
   * two mean opposite things: an empty Focused Detail says the record had
   * nothing in it, and this says the record had too much and none of what is
   * left may be altered. A caller that cannot tell those apart reads "no
   * detail" from a test that has plenty.
   */
  | {
      view: "omitted"
      facet: InspectionFacet
      reason: string
      /** The protected fields that prevented it, by path. Never their values. */
      blockedBy: string[]
    }

export function inspectIndex(
  index: NormalizedIndex,
  request: InspectRunRequest,
  secret: Buffer,
  trustedRoot: string,
  lazy: LazyOutcome = { status: "incomplete" },
): InspectionResponse<FacetPage> {
  const rejection = validateRequest(index, request)
  if (rejection !== undefined) return rejection

  if (request.facet === "log") {
    // Log content lives on disk under the retention contract, not in the
    // index, so the caller reads the bytes and `inspectLog` shapes them.
    return invalid("the log facet is read by byte range, not by index position")
  }

  if (request.diagnosticId !== undefined) {
    return focusDiagnostic(index, request.diagnosticId, trustedRoot, lazy)
  }
  if (request.testId !== undefined) return focusTest(index, request.testId, lazy)

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
  window: LogWindow,
  totalBytes: number,
  secret: Buffer,
): InspectionResponse<FacetPage> {
  const byteOffset = window.byteOffset
  // Raw bytes are not response bytes: JSON escaping turns one newline into
  // two and one control character into six, so a window sized against the cap
  // in advance would still overshoot it. The chunk is shrunk against its own
  // serialized size instead, which is the only measure the cap is about.
  const fitted = fitChunk(bytes, byteOffset, totalBytes)
  const { chunk, hasMore } = fitted.chunked

  const cursor = nextCursor(secret, index, "log", hasMore ? fitted.chunked.nextByteOffset : undefined)

  const truncation: TruncationState = {
    fieldTruncated: false,
    collectionTruncated: hasMore,
    responseTruncated: fitted.shrunk,
    hasMore,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  }

  const data: FacetPage = { view: "log", facet: "log", chunk }
  // `incomplete` is the honest word for a log whose retained bytes are a lower
  // bound: an empty page does not authoritatively mean there was no output.
  return index.log.availability === "incomplete"
    ? { status: "incomplete", data, truncation }
    : { status: "available", completeness: "complete", data, truncation }
}

/**
 * What the log facet's availability means, decided once.
 *
 * `undefined` is "there are bytes worth reading"; everything else is the whole
 * answer. The caller asks before it opens anything, because a log that was
 * never retained and one retention has since deleted look identical from the
 * filesystem and are different answers.
 */
export function logAvailability(index: NormalizedIndex): InspectionResponse<FacetPage> | undefined {
  switch (index.log.availability) {
    case "unavailable":
      return { status: "unsupported", facet: "log" }
    case "expired":
      return { status: "expired" }
    case "available":
    case "incomplete":
      return undefined
  }
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
    responseBytes(chunked.chunk) + RESPONSE_ENVELOPE_BYTES > RESPONSE_BYTE_CAP &&
    length > LOG_CHUNK_MIN_BYTES
  ) {
    length = Math.max(LOG_CHUNK_MIN_BYTES, Math.floor(length / 2))
    chunked = chunkLog(bytes.subarray(0, length), byteOffset, totalBytes)
  }

  return { chunked, shrunk: length < bytes.length }
}

/**
 * The cursor for the next page, or nothing when there is no next page.
 *
 * `position` means a record index for a structured facet and a byte offset for
 * the log. Both are "where the next read starts", which is the only thing a
 * cursor has ever encoded — giving them separate encodings would be two ways
 * to say one thing.
 */
function nextCursor(
  secret: Buffer,
  index: NormalizedIndex,
  facet: InspectionFacet,
  position: number | undefined,
): string | undefined {
  if (position === undefined) return undefined
  return encodeCursor(secret, {
    runId: index.runId,
    facet,
    orderingVersion: CURSOR_ORDERING_VERSION,
    position,
  })
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
  const capped = capRecords(asked)
  const slice = capped.records

  // By what the page *accounted for*, not by what it returned. A record too
  // large to represent is passed over rather than corrupted, and a cursor that
  // advanced only past returned records would come back to it on every
  // subsequent request — an empty page, forever, at the one position the
  // caller cannot get past.
  const nextPosition = position + capped.consumed
  const hasMore = nextPosition < all.length

  const cursor = nextCursor(secret, index, facet, hasMore ? nextPosition : undefined)

  // `responseTruncated` and `collectionTruncated` mean different things and
  // both can be true: the first says the cap cut this page, the second says
  // more records exist. A caller deciding whether to ask again needs the
  // second; one deciding whether the page is a faithful picture needs the first.
  const truncation: TruncationState = {
    // Set when a mandatory record had to be shortened to fit at all, which is
    // a different fact from records being dropped and both can be true.
    fieldTruncated: capped.fieldTruncated,
    collectionTruncated: hasMore,
    responseTruncated: capped.dropped > 0 || capped.fieldTruncated || capped.omitted > 0,
    hasMore,
    // Stated separately because it is the one kind of loss paging cannot undo.
    // Dropped records arrive on the next page; an omitted one never arrives,
    // and a caller counting records needs to know the difference.
    ...(capped.omitted === 0 ? {} : { recordsOmitted: capped.omitted }),
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  }

  const data = { view: "records", facet, records: slice } as FacetPage
  const completeness = facetCompleteness(index, facet)

  if (completeness === "unavailable") return { status: "unsupported", facet }
  if (completeness === "partial") return { status: "incomplete", data, truncation }

  // An omitted record makes the page incomplete, whatever the evidence behind
  // it says. `available` carries a strong promise — that an empty page
  // authoritatively means zero records — and a page that silently dropped the
  // only record it had would break exactly that promise, in the direction a
  // caller cannot detect: they would read "no failures" from a run that had
  // one too large to show them.
  if (capped.omitted > 0) {
    return {
      status: "incomplete",
      data,
      truncation,
      annotation: `${capped.omitted} record(s) could not be returned within the response cap`,
    }
  }

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
  trustedRoot: string,
  lazy: LazyOutcome,
): InspectionResponse<FacetPage> {
  const failure = index.testFailures.find((record) => record.id === id)
  const buildError = failure === undefined ? index.buildErrors.find((r) => r.id === id) : undefined
  const diagnostic = failure ?? buildError
  // Deliberately does not say which run it was not found in.
  if (diagnostic === undefined) return { status: "notFound", subject: "diagnostic" }

  if (lazy.status === "unsupported") return { status: "unsupported", facet: "failures" }

  const facet = failure !== undefined ? "failures" : "buildErrors"
  const view = focusedDiagnostic(index, diagnostic, trustedRoot, lazy.detail)
  if (view.focused === undefined) {
    return omittedResponse(facet, view.truncation, view.blockedBy ?? [])
  }

  return focusedResponse({ view: "focused", facet, focused: view.focused }, view.truncation, lazy)
}

function focusTest(
  index: NormalizedIndex,
  id: string,
  lazy: LazyOutcome,
): InspectionResponse<FacetPage> {
  const occurrence = index.occurrences.find((record) => record.id === id)
  if (occurrence === undefined) return { status: "notFound", subject: "test" }
  if (lazy.status === "unsupported") return { status: "unsupported", facet: "tests" }

  const view = focusedTest(index, occurrence, lazy.detail)
  if (view.focused === undefined) {
    return omittedResponse("tests", view.truncation, view.blockedBy ?? [])
  }

  return focusedResponse({ view: "focused", facet: "tests", focused: view.focused }, view.truncation, lazy)
}

/**
 * A Focused Detail, marked `incomplete` when bundle-backed detail was not read.
 *
 * The distinction matters to a caller in exactly one way, and it is the way
 * that counts: on an `available` response an empty `activities` list means the
 * test recorded none, and on an `incomplete` one it means nobody could look.
 * #8 fixes which is which — `unsupported` when the recorded installation is
 * gone or no longer identity-matched, `incomplete` when the right toolchain
 * ran and still could not associate or extract what was asked for.
 */
function focusedResponse(
  data: FacetPage,
  truncation: TruncationState,
  lazy: LazyOutcome,
): InspectionResponse<FacetPage> {
  if (lazy.status === "incomplete") {
    return {
      status: "incomplete",
      data,
      truncation,
      ...(lazy.annotation === undefined ? {} : { annotation: lazy.annotation }),
    }
  }
  return { status: "available", completeness: "complete", data, truncation }
}

/**
 * A record that exists and cannot be shown within the cap.
 *
 * `incomplete`, never `available`: `available` promises that what is absent
 * from a response was absent from the run, and here it is absent from the
 * response only. The annotation says which, because "no detail" and "detail
 * too large to send" ask completely different things of a caller.
 *
 * It also says *what* would have had to change, which is the difference
 * between a diagnostic and a shrug. Every field named here is protected for
 * the same reason and in two flavours: shorten an identifier and it addresses
 * nothing, shorten a safe location and it names a file that does not exist.
 * Both look like answers afterwards, which is what makes them worse than
 * absence — and a caller told only "it did not fit" has no way to tell an
 * enormous test name from a pathological path.
 */
function omittedResponse(
  facet: InspectionFacet,
  truncation: TruncationState,
  blockedBy: readonly string[],
): InspectionResponse<FacetPage> {
  const reason =
    blockedBy.length === 0
      ? "this record cannot be returned within the response cap"
      : `this record cannot be returned within the response cap: ${blockedBy.join(", ")} would have to be shortened, and a shortened identifier or safe location names something that does not exist`

  return {
    status: "incomplete",
    data: { view: "omitted", facet, reason, blockedBy: [...blockedBy] },
    truncation,
    annotation: reason,
  }
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
