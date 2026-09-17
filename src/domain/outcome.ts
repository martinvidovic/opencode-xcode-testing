/**
 * The closed outcome vocabulary (#7) and the infrastructure reason taxonomy
 * (#8). Every list here is closed: adding a member is a schema change.
 */

/** The six terminal outcomes of a Test Run. */
export type TestRunOutcome =
  | "passed"
  | "testFailed"
  | "buildFailed"
  | "infrastructureFailed"
  | "cancelled"
  | "timedOut"

export const TEST_RUN_OUTCOMES = [
  "passed",
  "testFailed",
  "buildFailed",
  "infrastructureFailed",
  "cancelled",
  "timedOut",
] as const

/** Outcomes a result may carry before a Test Run exists, plus the six above. */
export type TestToolOutcome = TestRunOutcome | "invalid"

export const TEST_TOOL_OUTCOMES = [...TEST_RUN_OUTCOMES, "invalid"] as const

/** The closed v1 Test Run infrastructure reasons. */
export type InfrastructureReason =
  | "processLaunchFailed"
  | "processFailedWithoutDiagnostics"
  | "resultBundleMissing"
  | "resultBundleUnreadable"
  | "resultBundleIncomplete"
  | "unsupportedResultSchema"
  | "contradictoryEvidence"
  | "scopeMismatch"
  | "scopeUnverifiable"
  | "unknownTestStatus"
  | "interpretationTimedOut"
  | "runnerFailure"
  | "adapterFailure"

export const INFRASTRUCTURE_REASONS = [
  "processLaunchFailed",
  "processFailedWithoutDiagnostics",
  "resultBundleMissing",
  "resultBundleUnreadable",
  "resultBundleIncomplete",
  "unsupportedResultSchema",
  "contradictoryEvidence",
  "scopeMismatch",
  "scopeUnverifiable",
  "unknownTestStatus",
  "interpretationTimedOut",
  "runnerFailure",
  /**
   * The Test Tool itself failed, after a run had been admitted (issue #97).
   *
   * Distinct from `runnerFailure` on purpose, and the distinction is the whole
   * reason it exists. `runnerFailure` says the machinery that runs
   * `xcodebuild` went wrong; this says the adapter did — a decoder that threw
   * on a payload it did not expect, a renderer that could not render. Told the
   * first when the second happened, a caller goes to look at their toolchain.
   */
  "adapterFailure",
] as const

/** Operational failures that can occur before a Test Run exists. */
export type ResolutionFailureReason =
  | "discoveryTimedOut"
  | "discoveryFailed"
  | "configurationReadFailed"
  | "projectInspectionFailed"
  | "unexpectedResolutionFailure"

export const RESOLUTION_FAILURE_REASONS = [
  "discoveryTimedOut",
  "discoveryFailed",
  "configurationReadFailed",
  "projectInspectionFailed",
  "unexpectedResolutionFailure",
] as const

/** Failures reached while waiting for an execution slot (#3). */
export type QueuedFailureReason =
  | "concurrencyWaitTimedOut"
  | "executionSlotQuarantined"
  | "recoveryTimedOut"
  | "recoveryFailed"
  | "insufficientStorage"

export const QUEUED_FAILURE_REASONS = [
  "concurrencyWaitTimedOut",
  "executionSlotQuarantined",
  "recoveryTimedOut",
  "recoveryFailed",
  "insufficientStorage",
] as const

/** Where a caller cancellation or resolution failure was observed. */
export type ResolutionPhase = "resolving" | "discovering" | "queued"

export const RESOLUTION_PHASES = ["resolving", "discovering", "queued"] as const

/** Where a cancellation interrupted an admitted Test Run. */
export type InterruptionPhase =
  | "launching"
  | "building"
  | "testing"
  | "terminating"
  | "interpreting"
  | "unknown"

export const INTERRUPTION_PHASES = [
  "launching",
  "building",
  "testing",
  "terminating",
  "interpreting",
  "unknown",
] as const

/**
 * Where the original process deadline was crossed. Narrower than
 * `InterruptionPhase` on purpose: termination escalation never overwrites it.
 */
export type DeadlineCrossedPhase = "launching" | "building" | "testing" | "unknown"

export const DEADLINE_CROSSED_PHASES = ["launching", "building", "testing", "unknown"] as const
