/**
 * Evidence shapes shared by every Test Run result (#7).
 *
 * The governing rule: partial or unavailable evidence is never represented by
 * zero, and an unknown fact is never represented by `false`.
 */

/** A tri-state fact. `unknown` is a first-class answer, not a missing `no`. */
export type EvidenceFact = "yes" | "no" | "unknown"

export const EVIDENCE_FACTS = ["yes", "no", "unknown"] as const

/**
 * How much of a class of evidence the interpreter could actually establish.
 * Only `complete` evidence may participate in a trustworthy pass.
 */
export type EvidenceCompleteness = "complete" | "partial" | "unavailable"

export const EVIDENCE_COMPLETENESS = ["complete", "partial", "unavailable"] as const

/** Facts about how a supervised `xcodebuild` process was brought down. */
export type TerminationEvidence = {
  requested: EvidenceFact
  gracefulTerminationObserved: EvidenceFact
  forceEscalationRequired: EvidenceFact
  terminationGraceExceeded: EvidenceFact
  descendantsConfirmedExited: EvidenceFact
}

/** What initiated process termination. The first such event fixes the outcome. */
export type ProcessTerminationTrigger =
  | "none"
  | "callerCancellation"
  | "processDeadline"
  | "toolFailure"
  | "unknown"

export const PROCESS_TERMINATION_TRIGGERS = [
  "none",
  "callerCancellation",
  "processDeadline",
  "toolFailure",
  "unknown",
] as const

/**
 * Whether the supervisor observed the gated launch actually `exec` the binary.
 * Launch authorization alone does not prove it.
 */
export type ExecutionEvidence = {
  execObserved: EvidenceFact
  exitCode?: number
  signal?: string
  successfulExit: EvidenceFact
}

/** Build results. Warning counts are deliberately outside the compact contract. */
export type BuildEvidence = {
  completeness: EvidenceCompleteness
  /** Absent unless completeness is `complete` or `partial`; partial is a lower bound. */
  errorCount?: number
}

/** Per-status test totals. `total` equals the sum of every other category. */
export type TestCounts = {
  total: number
  passed: number
  failed: number
  skipped: number
  expectedFailure: number
  unknown: number
}

/** Test results. Partial counts are lower bounds, never a claim of completeness. */
export type TestEvidence = {
  completeness: EvidenceCompleteness
  /** Absent when completeness is `unavailable`; counts are never faked as zero. */
  counts?: TestCounts
}

/** Statuses a single observed test may hold. */
export type TestStatus = "passed" | "failed" | "skipped" | "expectedFailure" | "unknown"

export const TEST_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "expectedFailure",
  "unknown",
] as const

/** True when the per-status counts add up to the reported total. */
export function countsAreConsistent(counts: TestCounts): boolean {
  return (
    counts.total ===
    counts.passed + counts.failed + counts.skipped + counts.expectedFailure + counts.unknown
  )
}
