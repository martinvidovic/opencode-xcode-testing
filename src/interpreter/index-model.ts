/**
 * The immutable normalized index (#8).
 *
 * Eager interpretation publishes this once; classification and ordinary paging
 * then read only this. A completed run is never reinterpreted, so this
 * structure — not the Result Bundle — is what a later inspection answers from.
 */

import type { BuildEvidence, TestCounts, TestEvidence } from "../domain/evidence.ts"
import type { DiagnosticSummary, FacetAvailability } from "../domain/inspection.ts"
import type { ScopeAttestation, ScopeVerdict } from "../domain/scope.ts"
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
  if (typeof value !== "object" || value === null) return false
  const index = value as Partial<NormalizedIndex>

  return (
    index.indexVersion === INDEX_VERSION &&
    typeof index.runId === "string" &&
    typeof index.decoderVersion === "number" &&
    typeof index.schemaVersion === "string" &&
    Array.isArray(index.occurrences) &&
    Array.isArray(index.testFailures) &&
    Array.isArray(index.buildErrors) &&
    Array.isArray(index.attestations) &&
    typeof index.scopeVerdict === "string" &&
    typeof index.scopeDigest === "string" &&
    typeof index.requestedSelectionCount === "number" &&
    typeof index.observedOutsideScope === "number" &&
    isFacet(index.build) &&
    isFacet(index.tests) &&
    isLogFacet(index.log) &&
    typeof index.bundleDigestVerified === "string"
  )
}

function isFacet(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { completeness?: unknown }).completeness === "string"
}

function isLogFacet(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const log = value as Partial<LogFacetEvidence>
  return typeof log.availability === "string" && typeof log.retainedBytesExact === "boolean"
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
