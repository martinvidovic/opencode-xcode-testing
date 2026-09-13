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
