/**
 * Classification (#7, #8).
 *
 * The order below is the contract's order, and the order matters more than any
 * individual rule: a termination event that already fixed the outcome is never
 * overwritten by evidence discovered afterwards, and evidence defects are
 * considered before any success or failure is claimed.
 *
 * Evidence defects apply only when they affect the evidence the *candidate*
 * outcome requires. Complete, trustworthy build errors still yield
 * `buildFailed` when test evidence is unavailable — the build genuinely failed,
 * and withholding that because the test facet is missing helps nobody.
 */

import type {
  BuildEvidence,
  ExecutionEvidence,
  TestCounts,
  TestEvidence,
} from "../domain/evidence.ts"
import type {
  DeadlineCrossedPhase,
  InfrastructureReason,
  InterruptionPhase,
  ProcessTerminationTrigger,
  TestRunOutcome,
} from "../domain/outcome.ts"
import type { ScopeVerdict } from "../domain/scope.ts"

/** A defect found while reading the Result Bundle, before classification runs. */
export type EvidenceDefect = { reason: InfrastructureReason; message: string }

export type ClassificationInput = {
  terminationTrigger: ProcessTerminationTrigger
  execution: ExecutionEvidence
  build: BuildEvidence
  tests: TestEvidence
  counts?: TestCounts
  scopeVerdict: ScopeVerdict
  /** `false` only when trustworthy evidence proves testing never began. */
  testingReached: boolean | "unknown"
  /** The highest-priority defect found while gathering evidence, if any. */
  defect?: EvidenceDefect
  /** Set when the caller cancelled while interpretation was already running. */
  cancelledDuringInterpretation?: boolean
  interruptionPhase?: InterruptionPhase
  deadlineCrossedPhase?: DeadlineCrossedPhase
}

export type Classification =
  | { outcome: "passed" | "testFailed" | "buildFailed" }
  | { outcome: "infrastructureFailed"; reason: InfrastructureReason; message: string }
  | { outcome: "cancelled"; interruptionPhase: InterruptionPhase }
  | { outcome: "timedOut"; deadlineCrossedPhase: DeadlineCrossedPhase }

export function classify(input: ClassificationInput): Classification {
  // 1 & 2 — the event that initiated termination already fixed the outcome.
  if (input.terminationTrigger === "callerCancellation") {
    return { outcome: "cancelled", interruptionPhase: input.interruptionPhase ?? "unknown" }
  }
  if (input.terminationTrigger === "processDeadline") {
    return { outcome: "timedOut", deadlineCrossedPhase: input.deadlineCrossedPhase ?? "unknown" }
  }
  if (input.cancelledDuringInterpretation === true) {
    // The process deadline is no longer active, so this is a cancellation.
    return { outcome: "cancelled", interruptionPhase: "interpreting" }
  }

  const buildErrors = trustworthyBuildErrors(input.build)
  const failedTests = input.tests.completeness === "complete" ? (input.counts?.failed ?? 0) : 0

  // 3 — contradictory, unsupported, missing, or insufficient evidence.
  if (input.execution.successfulExit === "yes" && (buildErrors > 0 || failedTests > 0)) {
    return infrastructure(
      "contradictoryEvidence",
      "the process exited successfully while the Result Bundle reports failures",
    )
  }
  if (input.defect !== undefined && outranksBuildFailure(input.defect.reason)) {
    return infrastructure(input.defect.reason, input.defect.message)
  }

  // 4 — trustworthy build errors. Test evidence may be partial or unavailable:
  // an evidence defect applies only where it affects the evidence the candidate
  // outcome needs, and a build that failed is a fact about the build.
  if (buildErrors > 0) return { outcome: "buildFailed" }

  if (input.defect !== undefined) {
    return infrastructure(input.defect.reason, input.defect.message)
  }

  // 5 — testing was reached, but the Requested Scope cannot be shown to match.
  if (input.testingReached === true) {
    if (input.scopeVerdict === "mismatched") {
      return infrastructure(
        "scopeMismatch",
        "the Requested Scope did not match the tests that were observed",
      )
    }
    if (input.scopeVerdict === "unverifiable") {
      return infrastructure(
        "scopeUnverifiable",
        "the Requested Scope could not be verified against the observed tests",
      )
    }
  }

  // 6 — an unknown status is a complete observation that cannot be trusted.
  if ((input.counts?.unknown ?? 0) > 0) {
    return infrastructure("unknownTestStatus", "one or more tests reported an unknown status")
  }

  const buildComplete = input.build.completeness === "complete"
  const testsComplete = input.tests.completeness === "complete"

  // 7 — known failed tests, with the complete evidence the contract demands.
  if (failedTests > 0) {
    if (buildComplete && testsComplete && input.scopeVerdict === "matched") {
      return { outcome: "testFailed" }
    }
    return infrastructure(
      "resultBundleIncomplete",
      "failed tests were observed without the complete evidence required to report them",
    )
  }

  // 8 — every pass condition. Observing zero tests may never pass.
  if (
    input.execution.successfulExit === "yes" &&
    buildComplete &&
    (input.build.errorCount ?? 0) === 0 &&
    testsComplete &&
    (input.counts?.total ?? 0) > 0 &&
    input.scopeVerdict === "matched"
  ) {
    return { outcome: "passed" }
  }

  if (input.execution.successfulExit === "no") {
    if (buildComplete && testsComplete) {
      return infrastructure(
        "processFailedWithoutDiagnostics",
        "the process failed but the Result Bundle reports no build or test failure",
      )
    }
    return infrastructure(
      "resultBundleIncomplete",
      "the process failed and the Result Bundle lacks the evidence to explain it",
    )
  }

  return infrastructure(
    "resultBundleIncomplete",
    "the Result Bundle lacks the evidence required to classify this Test Run",
  )
}

/**
 * Defects that make the whole Result Bundle untrustworthy, and so outrank even
 * a complete build failure.
 *
 * A missing, unreadable or unsupported bundle says nothing can be believed. A
 * contradiction says two trustworthy records disagree. Everything else — a test
 * that carried no status, say — is a defect in evidence the build outcome does
 * not depend on, and suppressing `buildFailed` for it would hide the thing the
 * caller actually has to fix.
 */
export function outranksBuildFailure(reason: InfrastructureReason): boolean {
  return (
    reason === "resultBundleMissing" ||
    reason === "resultBundleUnreadable" ||
    reason === "unsupportedResultSchema" ||
    reason === "contradictoryEvidence" ||
    reason === "interpretationTimedOut" ||
    reason === "runnerFailure" ||
    reason === "processLaunchFailed"
  )
}

/** Only complete build evidence makes an error count trustworthy. */
export function trustworthyBuildErrors(build: BuildEvidence): number {
  return build.completeness === "complete" ? (build.errorCount ?? 0) : 0
}

function infrastructure(reason: InfrastructureReason, message: string): Classification {
  return { outcome: "infrastructureFailed", reason, message }
}

/** The outcomes that never depend on evidence, only on what stopped the run. */
export function isTerminationFixed(outcome: TestRunOutcome): boolean {
  return outcome === "cancelled" || outcome === "timedOut"
}
