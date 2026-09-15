/**
 * Progressive inspection (#7): reading deeper into a retained Test Run without
 * ever rerunning it, and without ever naming a Result Bundle path.
 */

import type { EvidenceCompleteness, TestStatus } from "./evidence.ts"
import type { TestIdentity } from "./scope.ts"

/** The closed set of facets a retained Test Run exposes. */
export type InspectionFacet = "scope" | "failures" | "buildErrors" | "tests" | "log"

export const INSPECTION_FACETS = ["scope", "failures", "buildErrors", "tests", "log"] as const

/**
 * Whether a facet can be read, and how much it is worth trusting.
 * `available` means an empty page authoritatively means zero records;
 * `incomplete` means it does not.
 */
export type FacetAvailability = "available" | "incomplete" | "unavailable" | "expired"

export const FACET_AVAILABILITIES = [
  "available",
  "incomplete",
  "unavailable",
  "expired",
] as const

/** Per-facet availability, carried on every Test Run summary. */
export type InspectionAvailability = Record<InspectionFacet, FacetAvailability>

/** A source location safe to show a model: repo-relative, or a display name. */
export type SafeLocation = {
  path: string
  line?: number
  column?: number
}

/** The compact diagnostic record that appears in summaries and in facet pages. */
export type DiagnosticSummary = {
  id: string
  kind: "testFailure" | "buildError"
  message: string
  testId?: string
  location?: SafeLocation
  inspectionAvailable: boolean
}

/** The compact record returned by the `tests` facet. */
export type TestRecord = {
  id: string
  identity: TestIdentity
  status: TestStatus
  durationMs?: number
  failureCount: number
}

/** What a caller asks of a retained Test Run. IDs and cursors never combine. */
export type InspectRunRequest = {
  runId: string
  facet: InspectionFacet
  limit?: number
  cursor?: string
  diagnosticId?: string
  testId?: string
  maxBytes?: number
}

/** Which kind of thing an inspection could not find. Never leaks membership. */
export type NotFoundSubject = "run" | "diagnostic" | "test"

export const NOT_FOUND_SUBJECTS = ["run", "diagnostic", "test"] as const

/** The truncation conditions a response reports. Several may coexist. */
export type TruncationState = {
  fieldTruncated: boolean
  collectionTruncated: boolean
  responseTruncated: boolean
  hasMore: boolean
  /** Points at the first unreturned record. Pagination always moves forward. */
  nextCursor?: string
  /**
   * Records passed over because they could not be represented within the cap
   * without altering an identifier, a kind, a status or a safe location.
   *
   * A different fact from every other field here, and the only one describing
   * a loss that asking again cannot undo. A record left off a page for size
   * arrives on the next one; one counted here never arrives. On a paged read
   * that is because the cursor has already moved past it, and on a focused
   * read it is because the record itself is what does not fit — the same fact
   * about the same cap, reached two ways.
   *
   * Additive, so it needs no `schemaVersion` bump, and absent on every
   * ordinary response.
   */
  recordsOmitted?: number
}

/**
 * Inspection responses are typed, not thrown. Only defects in the Test Tool
 * itself throw — a missing run is an answer, not an exception.
 */
export type InspectionResponse<T> =
  | { status: "available"; completeness: EvidenceCompleteness; data: T; truncation: TruncationState }
  | {
      status: "incomplete"
      data: T
      truncation: TruncationState
      /**
       * Why this is incomplete, when there is something specific to say —
       * a lazy read that ran out of its deadline, or detail that could not be
       * associated to exactly one occurrence. Additive, so it needs no
       * `schemaVersion` bump.
       */
      annotation?: string
    }
  | { status: "expired" }
  | { status: "notFound"; subject: NotFoundSubject }
  /**
   * The facet cannot be answered from what is here.
   *
   * `annotation` because that covers two different things (issue #76): a facet
   * that was never produced for this run, and one that was produced and that
   * nothing available can now read — a Result Bundle whose Xcode is gone, an
   * index a later decoder wrote. Told only "never produced", a caller draws a
   * conclusion about their run from a fact about this machine.
   */
  | { status: "unsupported"; facet: InspectionFacet; annotation?: string }
  | { status: "invalid"; message: string }

/** A chunk of the merged stdout/stderr log, labeled untrusted by the adapter. */
export type LogChunk = {
  text: string
  byteOffset: number
  byteLength: number
  /** Invalid UTF-8 was decoded with explicit replacement characters. */
  lossyDecoding: boolean
}

/** A stack frame, carrying no raw addresses and no absolute external paths. */
export type StackFrame = {
  symbol?: string
  module?: string
  location?: SafeLocation
}

/** Attachment metadata only. Contents and paths are not exposed in v1. */
export type AttachmentMetadata = {
  name: string
  mediaType?: string
  byteSize?: number
  contentAccessible: false
}

/** One node of a focused diagnostic's bounded activity hierarchy. */
export type ActivityNode = {
  title: string
  message?: string
  children: ActivityNode[]
}

/** The expanded view of a single diagnostic, reachable only by `diagnosticId`. */
export type FocusedDiagnostic = {
  id: string
  kind: DiagnosticSummary["kind"]
  message: string
  identity?: TestIdentity
  location?: SafeLocation
  stackFrames: StackFrame[]
  activities: ActivityNode[]
  attachments: AttachmentMetadata[]
}

/**
 * The expanded view of a single test, reachable only by `testId`.
 *
 * Carries the attempts because a test that passed on its second run is a
 * different fact from one that passed outright, and a compact record cannot
 * say which happened.
 */
export type FocusedTest = {
  id: string
  identity: TestIdentity
  status: TestStatus
  durationMs?: number
  attempts: TestAttempt[]
  /** Every diagnostic this test produced, so a caller need not search for them. */
  diagnostics: DiagnosticSummary[]
  /**
   * The bounded activity hierarchy, when bundle-backed detail could be read.
   * Empty on an `incomplete` response means nobody could look, not that the
   * test recorded none.
   */
  activities: ActivityNode[]
}

export type TestAttempt = {
  ordinal: number
  status: TestStatus
  durationMs?: number
}
