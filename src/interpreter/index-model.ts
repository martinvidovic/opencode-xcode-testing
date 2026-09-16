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
import {
  countsAreConsistent,
  EVIDENCE_COMPLETENESS,
  EVIDENCE_FACTS,
  TEST_STATUSES,
} from "../domain/evidence.ts"
import { staysInside } from "./locations.ts"
import { SCOPE_VERDICTS } from "../domain/scope.ts"
import type { ToolchainIdentity } from "../domain/toolchain.ts"
import type { ScopeAttestation, ScopeVerdict, TestSelection } from "../domain/scope.ts"
import {
  isArrayOf,
  isCount,
  isDuration,
  isIdentifier,
  isPosition,
  isRecord,
  oneOf,
} from "../domain/json.ts"
import type { IndexedOccurrence } from "./diagnostics.ts"
import type { NormalizedAttempt, NormalizedFailure } from "./occurrences.ts"

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
   * The same messages with their line structure kept, for the ones that had
   * any (issue #75).
   *
   * `fullMessages` is normalized — whitespace collapsed — because that is what
   * display and deduplication need: two tests that failed the same assertion
   * must dedup whatever the wrapping did to them. But a stack frame *is* a
   * line, so frames extracted from that text found nothing, ever, and every
   * multiline failure reported incomplete frame evidence.
   *
   * Private, and never displayed. What a caller sees is still built from the
   * normalized text, under the same caps; this exists so the trace can be read
   * from the shape it arrived in.
   *
   * Sparse: no entry for the single-line failures that are most of them.
   *
   * Optional only on the read side. Every index this decoder writes carries
   * the field, possibly empty; what the `?` is for is the indexes already on
   * disk, written before it existed. Bumping `indexVersion` for an additive
   * private field would have made every retained run unpageable, which is a
   * steep price for a field the reader can simply do without — and doing
   * without it, it recognizes no trace and says so, which for text that no
   * longer has lines is correct.
   */
  detailMessages?: Record<string, string>
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
    isIdentifier(index.runId) &&
    isCount(index.decoderVersion) &&
    typeof index.schemaVersion === "string" &&
    isArrayOf(index.occurrences, isIndexedOccurrence) &&
    isArrayOf(index.testFailures, isDiagnosticSummary) &&
    isArrayOf(index.buildErrors, isDiagnosticSummary) &&
    isArrayOf(index.attestations, isAttestation) &&
    oneOf(index.scopeVerdict, SCOPE_VERDICTS) &&
    isIdentifier(index.scopeDigest) &&
    isCount(index.requestedSelectionCount) &&
    isCount(index.observedOutsideScope) &&
    isCounts(index.counts) &&
    isBuildEvidence(index.build) &&
    isTestEvidence(index.tests) &&
    isFacet(index.diagnostics) &&
    isMessageMap(index.fullMessages) &&
    // Validated when present, so an index that predates it still pages.
    (index.detailMessages === undefined || isMessageMap(index.detailMessages)) &&
    isToolchainIdentity(index.toolchain) &&
    isLogFacet(index.log) &&
    oneOf(index.bundleDigestVerified, EVIDENCE_FACTS)
  )
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
  // Read by attestation to decide whether identities can be matched at all,
  // so a missing or non-boolean one silently changes what scope verdicts say.
  if (typeof value.identityComplete !== "boolean") return false

  return (
    isIdentifier(value.id) &&
    isTestIdentity(value.identity) &&
    oneOf(value.status, TEST_STATUSES) &&
    isIdentifier(value.position) &&
    isArrayOf(value.failures, isNormalizedFailure) &&
    isArrayOf(value.attempts, isAttempt) &&
    (value.durationMs === undefined || isDuration(value.durationMs))
  )
}

/**
 * The identity a scope attestation is decided against, and the one a focused
 * view shows.
 *
 * Every part of it is an identifier, so every part of it is checked for being
 * *usable* rather than merely being a string. A `suite` that is a number would
 * reach a model as one; a `suite` that is `""` would reach it as a name that
 * matches nothing and looks like it should.
 *
 * That includes the bundle and the canonical form, in **every** completeness
 * state. `identityComplete` says how much confidence to place in an identity —
 * whether its components were cross-checked and agreed — and that is a
 * different question from whether the identity is structurally usable at all.
 * Letting the flag relax the structural rule made an incomplete identity a
 * place where `""` could legitimately live, and `""` reaches a model as a name
 * that matches nothing and looks like it should. An occurrence with nothing to
 * call itself is not a less confident occurrence; it is not one.
 */
function isTestIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isIdentifier(value.bundle) || !isIdentifier(value.canonical)) return false

  return ["suite", "test", "sourceIdentifier"].every(
    // `sourceIdentifier` is the Result Bundle's own spelling of this test,
    // retained only when it differs from the canonical one. It is what a
    // reader uses to find the test in Xcode's own output, which makes it an
    // identifier like the rest and not a display string.
    (field) => value[field] === undefined || isIdentifier(value[field]),
  )
}

function isNormalizedFailure(value: unknown): value is NormalizedFailure {
  if (!isRecord(value)) return false
  return (
    typeof value.message === "string" &&
    typeof value.position === "string" &&
    (value.location === undefined || isSafeLocation(value.location))
  )
}

function isAttempt(value: unknown): value is NormalizedAttempt {
  if (!isRecord(value)) return false
  return (
    // A count, because attempts are numbered from zero here — the first
    // attempt is the zeroth. Requiring one instead reads as the stricter
    // choice and is simply the wrong one: it rejects the ordinals the
    // interpreter writes, and with them the whole index of any run that
    // retried a test.
    isCount(value.ordinal) &&
    oneOf(value.status, TEST_STATUSES) &&
    (value.durationMs === undefined || isDuration(value.durationMs))
  )
}

function isDiagnosticSummary(value: unknown): value is DiagnosticSummary {
  if (!isRecord(value)) return false
  return (
    isIdentifier(value.id) &&
    (value.kind === "testFailure" || value.kind === "buildError") &&
    typeof value.message === "string" &&
    typeof value.inspectionAvailable === "boolean" &&
    (value.testId === undefined || isIdentifier(value.testId)) &&
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
  if (typeof value.path !== "string" || !staysInside(value.path)) return false
  return (
    (value.line === undefined || isPosition(value.line)) &&
    (value.column === undefined || isPosition(value.column))
  )
}

/**
 * A scope attestation, including the selection it is about.
 *
 * The selection is the part a caller acts on: it is what the attestation says
 * a verdict is *for*, and a reader comparing it against what they asked to run
 * is the whole mechanism by which a zero-match run is caught. A selection
 * checked only for being an object could name a bundle that is a number, or
 * carry no bundle at all, and the verdict beside it would still read as
 * authoritative.
 */
function isAttestation(value: unknown): value is ScopeAttestation {
  if (!isRecord(value)) return false
  return (
    oneOf(value.verdict, SCOPE_VERDICTS) &&
    isTestSelection(value.selection) &&
    (value.matchedTestCount === undefined || isCount(value.matchedTestCount))
  )
}

function isTestSelection(value: unknown): value is TestSelection {
  if (!isRecord(value)) return false
  return (
    isIdentifier(value.bundle) &&
    (value.suite === undefined || isIdentifier(value.suite)) &&
    (value.test === undefined || isIdentifier(value.test))
  )
}

function isFacet(value: unknown): boolean {
  return isRecord(value) && oneOf(value.completeness, EVIDENCE_COMPLETENESS)
}

/**
 * Build evidence, including the count a caller is shown.
 *
 * `errorCount` is optional by contract — absent unless the build was observed
 * — so its absence is fine and its presence has to be a count.
 */
function isBuildEvidence(value: unknown): boolean {
  if (!isFacet(value)) return false
  const build = value as Record<string, unknown>
  return build.errorCount === undefined || isCount(build.errorCount)
}

/**
 * Test evidence, including the counts classification reads.
 *
 * These are not display numbers. `counts.failed` decides whether a run is
 * reported as having failed tests, `counts.unknown` raises an anomaly, and
 * `counts.total` is what a zero-match check turns on — so a retained index
 * carrying `NaN` here does not merely render oddly, it changes what the tool
 * says happened. `NaN` in particular compares false against every threshold,
 * so it passes each check by failing it.
 *
 * Consistency is required, not merely the shape: the domain defines `total` as
 * the sum of the rest, and a set of counts that does not add up is one this
 * tool did not write.
 */
function isTestEvidence(value: unknown): boolean {
  if (!isFacet(value)) return false
  return isCounts((value as Record<string, unknown>).counts)
}

/** Absent, or a whole consistent set. Never a partly-shaped one. */
function isCounts(value: unknown): value is TestCounts | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false

  const { total, passed, failed, skipped, expectedFailure, unknown } = value
  // Field by field rather than `every` over an array of them: `every` proves
  // the array, and it is each of these that has to be a count before the set
  // can be rebuilt from them.
  if (
    !isCount(total) ||
    !isCount(passed) ||
    !isCount(failed) ||
    !isCount(skipped) ||
    !isCount(expectedFailure) ||
    !isCount(unknown)
  ) {
    return false
  }

  // Rebuilt rather than asserted: the checks above prove each field, and an
  // assertion would claim the whole shape on the strength of that.
  return countsAreConsistent({ total, passed, failed, skipped, expectedFailure, unknown })
}

function isLogFacet(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    oneOf(value.availability, FACET_AVAILABILITIES) &&
    typeof value.retainedBytesExact === "boolean" &&
    (value.retainedBytes === undefined || isCount(value.retainedBytes))
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
