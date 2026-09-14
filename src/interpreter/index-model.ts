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
import {
  FACET_AVAILABILITIES,
  type DiagnosticSummary,
  type FacetAvailability,
} from "../domain/inspection.ts"
import { EVIDENCE_COMPLETENESS, EVIDENCE_FACTS, TEST_STATUSES } from "../domain/evidence.ts"
import { SCOPE_VERDICTS } from "../domain/scope.ts"
import type { ToolchainIdentity } from "../domain/toolchain.ts"
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
  /**
   * Every diagnostic's message at full length, keyed by diagnostic ID.
   *
   * A `DiagnosticSummary` carries a message capped for a summary, and seeing
   * past that cap is the whole point of focusing — so the full text is
   * retained here, when the evidence was fresh, rather than recovered later by
   * matching prefixes against occurrences. A build error has no occurrence to
   * recover it from at all, which is what makes this the only workable place.
   */
  fullMessages: Record<string, string>
  /**
   * The toolchain that produced this index, as #8 records it.
   *
   * Kept so a lazy read can verify the installation it is about to use is the
   * one that wrote the bundle. Comparing the current toolchain against itself
   * would verify nothing, and #8 is explicit that a path-and-version match
   * without the binary digest is insufficient.
   */
  toolchain: ToolchainIdentity
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
    oneOf(index.scopeVerdict, SCOPE_VERDICTS) &&
    typeof index.scopeDigest === "string" &&
    typeof index.requestedSelectionCount === "number" &&
    typeof index.observedOutsideScope === "number" &&
    isFacet(index.build) &&
    isFacet(index.tests) &&
    isFacet(index.diagnostics) &&
    isMessageMap(index.fullMessages) &&
    isToolchainIdentity(index.toolchain) &&
    isLogFacet(index.log) &&
    oneOf(index.bundleDigestVerified, EVIDENCE_FACTS)
  )
}

/**
 * A value from a closed set, not merely a string of the right type.
 *
 * The difference is what a caller does next. A facet page hands these
 * straight to a model, and a `scopeVerdict` of `"definitely fine"` reads as
 * authoritative while meaning nothing this tool ever produced — so the set is
 * the check, and anything outside it makes the whole index unreadable.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

/** Every recorded message must be text, because every one of them is shown. */
function isMessageMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
}

/**
 * The toolchain identity #8 requires, field by field.
 *
 * This is what a lazy read compares against before it reopens a Result Bundle.
 * A partly-shaped identity would compare unequal and quietly disable
 * bundle-backed detail forever; a forged one would let a different Xcode read
 * a bundle it did not write.
 */
function isToolchainIdentity(value: unknown): value is ToolchainIdentity {
  if (!isRecord(value)) return false
  return [
    "developerDirectory",
    "xcodeVersion",
    "xcodeBuild",
    "xcresulttoolPath",
    "xcresulttoolVersion",
    "xcresulttoolDigest",
    "schemaVersion",
  ].every((field) => typeof value[field] === "string")
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
    isTestIdentity(value.identity) &&
    oneOf(value.status, TEST_STATUSES) &&
    typeof value.position === "string" &&
    isArrayOf(value.failures, isNormalizedFailure) &&
    isArrayOf(value.attempts, isAttempt) &&
    (value.durationMs === undefined || typeof value.durationMs === "number")
  )
}

/**
 * The identity a scope attestation is decided against, and the one a focused
 * view shows. Its optional parts are still typed when present: a `suite` that
 * is a number would reach a model as one.
 */
function isTestIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.canonical !== "string") return false
  return ["bundle", "suite", "test"].every(
    (field) => value[field] === undefined || typeof value[field] === "string",
  )
}

function isNormalizedFailure(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.message === "string" &&
    typeof value.position === "string" &&
    (value.location === undefined || isSafeLocation(value.location))
  )
}

function isAttempt(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.ordinal === "number" &&
    oneOf(value.status, TEST_STATUSES) &&
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

/**
 * A location safe to put in front of a model — checked on the way *out* of
 * storage, not only on the way in.
 *
 * The interpreter makes these repository-relative when it writes them. This is
 * the read side, and the file it reads is one a crash, a full volume, or
 * anything else on the machine may have touched: a retained index claiming
 * `/Users/someone/…` would hand a model an absolute path that says where this
 * machine keeps things, and one claiming `../../` would describe a file
 * outside the repository as if it were inside it.
 */
function isSafeLocation(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.path !== "string" || !isContainedPath(value.path)) return false
  return (
    (value.line === undefined || typeof value.line === "number") &&
    (value.column === undefined || typeof value.column === "number")
  )
}

/** Relative, and never walking out of the repository it is relative to. */
function isContainedPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) return false

  let depth = 0
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part !== "..") {
      depth += 1
      continue
    }
    depth -= 1
    if (depth < 0) return false
  }
  return true
}

function isAttestation(value: unknown): value is ScopeAttestation {
  if (!isRecord(value)) return false
  return oneOf(value.verdict, SCOPE_VERDICTS) && isRecord(value.selection)
}

function isFacet(value: unknown): boolean {
  return isRecord(value) && oneOf(value.completeness, EVIDENCE_COMPLETENESS)
}

function isLogFacet(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    oneOf(value.availability, FACET_AVAILABILITIES) &&
    typeof value.retainedBytesExact === "boolean" &&
    (value.retainedBytes === undefined || typeof value.retainedBytes === "number")
  )
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
