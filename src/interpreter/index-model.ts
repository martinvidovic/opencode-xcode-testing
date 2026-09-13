/**
 * The immutable normalized index (#8).
 *
 * Eager interpretation publishes this once; classification and ordinary paging
 * then read only this. A completed run is never reinterpreted, so this
 * structure — not the Result Bundle — is what a later inspection answers from.
 */

import type {
  BuildEvidence,
  EvidenceCompleteness,
  TestCounts,
  TestEvidence,
} from "../domain/evidence.ts"
import type { DiagnosticSummary, FacetAvailability } from "../domain/inspection.ts"
import type { ScopeAttestation, ScopeVerdict } from "../domain/scope.ts"
import { isArrayOf, isRecord } from "../domain/json.ts"
import type { IndexedOccurrence } from "./diagnostics.ts"

/**
 * Versioned independently of the public `schemaVersion: 1` and of Xcode's
 * `0.1.0` — three schemas that change for three unrelated reasons.
 */
export const INDEX_VERSION = 1

export type LogFacetEvidence = {
  availability: FacetAvailability
  retainedBytes?: number
  /** False when `retainedBytes` is a lower bound rather than an exact count. */
  retainedBytesExact: boolean
}

export type NormalizedIndex = {
  indexVersion: number
  runId: string
  decoderVersion: number
  schemaVersion: string
  occurrences: IndexedOccurrence[]
  testFailures: DiagnosticSummary[]
  buildErrors: DiagnosticSummary[]
  attestations: ScopeAttestation[]
  scopeVerdict: ScopeVerdict
  scopeDigest: string
  requestedSelectionCount: number
  observedOutsideScope: number
  counts?: TestCounts
  build: BuildEvidence
  tests: TestEvidence
  /**
   * How much of the *diagnostic* record survived, which is not the same
   * question as how many tests were counted.
   *
   * A run can count every test correctly and still lose failure detail — the
   * Result Summary's supplemental failures are the usual way, since the schema
   * declares that field with a shape the decoder has to work around. Folding
   * the two together would make an empty failures page look authoritative on
   * the strength of the test counts being fine, which is exactly the claim
   * that would be wrong.
   */
  diagnostics: { completeness: EvidenceCompleteness }
  log: LogFacetEvidence
  /**
   * Stabilization-time digest re-verification. A mismatch never invalidates
   * what is published here — the evidence was already read and normalized — but
   * it does mean lazy, bundle-backed detail can no longer be trusted to
   * describe the same bundle, so that detail returns `incomplete`.
   */
  bundleDigestVerified: "yes" | "no" | "unknown"
}

/**
 * Whether a parsed value is an index this decoder can page through.
 *
 * A retained index is a file on disk, and "on disk" is not the same as
 * "written by this version of this tool": it may have been published by an
 * older decoder, truncated by a full volume, or edited. Paging through it
 * without checking would answer a caller with whatever the bytes happened to
 * say, which is the one thing evidence must never do.
 *
 * The private `indexVersion` is checked rather than the public `schemaVersion`,
 * because it is the field that tracks this structure's shape — the other two
 * versions change for unrelated reasons.
 */
export function isNormalizedIndex(value: unknown): value is NormalizedIndex {
  if (!isRecord(value)) return false
  const index = value as Partial<NormalizedIndex>

  return (
    index.indexVersion === INDEX_VERSION &&
    typeof index.runId === "string" &&
    typeof index.decoderVersion === "number" &&
    typeof index.schemaVersion === "string" &&
    isArrayOf(index.occurrences, isIndexedOccurrence) &&
    isArrayOf(index.testFailures, isDiagnosticSummary) &&
    isArrayOf(index.buildErrors, isDiagnosticSummary) &&
    isArrayOf(index.attestations, isAttestation) &&
    typeof index.scopeVerdict === "string" &&
    typeof index.scopeDigest === "string" &&
    typeof index.requestedSelectionCount === "number" &&
    typeof index.observedOutsideScope === "number" &&
    isFacet(index.build) &&
    isFacet(index.tests) &&
    isFacet(index.diagnostics) &&
    isLogFacet(index.log) &&
    typeof index.bundleDigestVerified === "string"
  )
}

/**
 * Elements are checked, not merely counted.
 *
 * `Array.isArray` alone would let every object inside these collections
 * through untouched, and they are precisely what a facet page hands to a
 * model — so an index that passed a shallow check would be a validated
 * wrapper around unvalidated content.
 */
function isIndexedOccurrence(value: unknown): value is IndexedOccurrence {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    isRecord(value.identity) &&
    typeof value.identity.canonical === "string" &&
    typeof value.status === "string" &&
    typeof value.position === "string" &&
    Array.isArray(value.failures) &&
    Array.isArray(value.attempts) &&
    (value.durationMs === undefined || typeof value.durationMs === "number")
  )
}

function isDiagnosticSummary(value: unknown): value is DiagnosticSummary {
  if (!isRecord(value)) return false
  return (
    typeof value.id === "string" &&
    (value.kind === "testFailure" || value.kind === "buildError") &&
    typeof value.message === "string" &&
    typeof value.inspectionAvailable === "boolean" &&
    (value.testId === undefined || typeof value.testId === "string") &&
    (value.location === undefined || isSafeLocation(value.location))
  )
}

function isSafeLocation(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.path === "string" &&
    (value.line === undefined || typeof value.line === "number") &&
    (value.column === undefined || typeof value.column === "number")
  )
}

function isAttestation(value: unknown): value is ScopeAttestation {
  if (!isRecord(value)) return false
  return typeof value.verdict === "string" && isRecord(value.selection)
}

function isFacet(value: unknown): boolean {
  return isRecord(value) && typeof value.completeness === "string"
}

function isLogFacet(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.availability === "string" && typeof value.retainedBytesExact === "boolean"
}

/** Count every occurrence. Scope attestation is what deduplicates identities. */
export function countOccurrences(occurrences: IndexedOccurrence[]): TestCounts {
  const counts: TestCounts = {
    total: occurrences.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    expectedFailure: 0,
    unknown: 0,
  }
  for (const occurrence of occurrences) counts[occurrence.status] += 1
  return counts
}
