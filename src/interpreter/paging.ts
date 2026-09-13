/**
 * Ordinary paging over the published index (#7).
 *
 * Everything here reads the immutable index and nothing else — inspection never
 * reruns tests, never reopens the Result Bundle for a plain page, and never
 * accepts a Result Bundle path. A missing run is an answer, not an exception:
 * only a defect in the Test Tool itself throws.
 */

import type { DiagnosticSummary, InspectRunRequest, TestRecord } from "../domain/inspection.ts"
import type { InspectionResponse, TruncationState } from "../domain/inspection.ts"
import { INSPECTION_PAGE_DEFAULT, INSPECTION_PAGE_MAX } from "../domain/limits.ts"
import type { ScopeAttestation } from "../domain/scope.ts"
import { CURSOR_ORDERING_VERSION, decodeCursor, encodeCursor } from "./cursor.ts"
import type { NormalizedIndex } from "./index-model.ts"

/** One page of a structured facet, tagged so a caller cannot confuse two facets. */
export type FacetPage =
  | { facet: "scope"; records: ScopeAttestation[] }
  | { facet: "failures"; records: DiagnosticSummary[] }
  | { facet: "buildErrors"; records: DiagnosticSummary[] }
  | { facet: "tests"; records: TestRecord[] }

export function inspectIndex(
  index: NormalizedIndex,
  request: InspectRunRequest,
  secret: Buffer,
): InspectionResponse<FacetPage> {
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

  if (request.facet === "log") {
    // Log content lives on disk under the retention contract, not in the index.
    return { status: "unsupported", facet: "log" }
  }

  if (request.diagnosticId !== undefined) return focusDiagnostic(index, request.diagnosticId)
  if (request.testId !== undefined) return focusTest(index, request.testId)

  const position = resolveCursor(index, request, secret)
  if (position.ok === false) return position.response

  const limit = request.limit ?? INSPECTION_PAGE_DEFAULT
  return page(index, request.facet, position.value, limit, secret)
}

function page(
  index: NormalizedIndex,
  facet: "scope" | "failures" | "buildErrors" | "tests",
  position: number,
  limit: number,
  secret: Buffer,
): InspectionResponse<FacetPage> {
  const all = recordsFor(index, facet)
  const slice = all.slice(position, position + limit)
  const nextPosition = position + slice.length
  const hasMore = nextPosition < all.length

  const truncation: TruncationState = {
    fieldTruncated: false,
    collectionTruncated: hasMore,
    responseTruncated: false,
    hasMore,
    ...(hasMore
      ? {
          nextCursor: encodeCursor(secret, {
            runId: index.runId,
            facet,
            orderingVersion: CURSOR_ORDERING_VERSION,
            position: nextPosition,
          }),
        }
      : {}),
  }

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
    case "scope":
    case "failures":
    case "tests":
      return index.tests.completeness
  }
}

function focusDiagnostic(index: NormalizedIndex, id: string): InspectionResponse<FacetPage> {
  const failure = index.testFailures.find((record) => record.id === id)
  if (failure !== undefined) {
    return single({ facet: "failures", records: [failure] })
  }
  const buildError = index.buildErrors.find((record) => record.id === id)
  if (buildError !== undefined) {
    return single({ facet: "buildErrors", records: [buildError] })
  }
  // Deliberately does not say which run it was not found in.
  return { status: "notFound", subject: "diagnostic" }
}

function focusTest(index: NormalizedIndex, id: string): InspectionResponse<FacetPage> {
  const occurrence = index.occurrences.find((record) => record.id === id)
  if (occurrence === undefined) return { status: "notFound", subject: "test" }
  return single({ facet: "tests", records: [toTestRecord(occurrence)] })
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
