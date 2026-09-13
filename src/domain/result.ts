/**
 * The public result boundary (#7): the discriminated union every Test Tool call
 * resolves to, and the Test Run envelope beneath it.
 *
 * Nothing here exposes a command, an environment, an absolute path, a
 * DerivedData path, or a Result Bundle path. The `runId` is the only handle.
 */

import type {
  BuildEvidence,
  ExecutionEvidence,
  ProcessTerminationTrigger,
  TerminationEvidence,
  TestEvidence,
} from "./evidence.ts"
import type { DiagnosticSummary, InspectionAvailability } from "./inspection.ts"
import type {
  DeadlineCrossedPhase,
  InfrastructureReason,
  InterruptionPhase,
  QueuedFailureReason,
  ResolutionFailureReason,
  ResolutionPhase,
} from "./outcome.ts"
import type { ResolvedTestRun } from "./request.ts"
import type { ScopeEvidence, TestIdentity } from "./scope.ts"

/** The version of the typed domain contract. Meaning changes bump it; additions do not. */
export const SCHEMA_VERSION = 1
export type SchemaVersion = typeof SCHEMA_VERSION

/** One validation or ambiguity error against a request. */
export type RequestError = {
  /** Dotted path into the request, e.g. `destination.platform`. */
  field: string
  code: string
  message: string
  /** Present for ambiguity: the candidates discovery found. */
  candidates?: string[]
  candidatesTruncated?: boolean
}

/** A capped collection reports what it holds against what exists. */
export type CappedSection = {
  total: number
  shown: number
  truncated: boolean
}

/** The request never became a Test Run because it was not valid. */
export type RequestRejected = {
  schemaVersion: SchemaVersion
  outcome: "invalid"
  errors: RequestError[]
  errorSection: CappedSection
}

/**
 * The caller cancelled before a Test Run existed. Queue cancellation carries no
 * `runId` and no Result Bundle — there is nothing yet to inspect.
 */
export type RequestCancelled = {
  schemaVersion: SchemaVersion
  outcome: "cancelled"
  phase: ResolutionPhase
  queuedAt?: string
  queueDurationMs?: number
}

/** Resolution, discovery, or admission failed operationally. */
export type RequestResolutionFailed = {
  schemaVersion: SchemaVersion
  outcome: "infrastructureFailed"
  phase: ResolutionPhase
  reason: ResolutionFailureReason | QueuedFailureReason
  message: string
  queuedAt?: string
  queueDurationMs?: number
}

/**
 * Timing for an admitted Test Run. `totalDurationMs` measures admission through
 * classification and excludes queueing; `startedAt` is the durable
 * `launchAuthorized` point and may legitimately be absent.
 */
export type TestRunTiming = {
  admittedAt: string
  queueDurationMs: number
  startedAt?: string
  startupDurationMs?: number
  processDurationMs?: number
  interpretationDurationMs?: number
  totalDurationMs: number
}

/** Facts every admitted Test Run reports, whatever its outcome. */
export type TestRunEnvelope = {
  schemaVersion: SchemaVersion
  runId: string
  resolved: ResolvedTestRun
  scope: ScopeEvidence
  timing: TestRunTiming
  terminationTrigger: ProcessTerminationTrigger
  termination: TerminationEvidence
  execution: ExecutionEvidence
  build: BuildEvidence
  tests: TestEvidence
  inspection: InspectionAvailability
}

/** Diagnostics carried in the compact summary, each a capped section. */
export type SummaryDiagnostics = {
  testFailures: DiagnosticSummary[]
  testFailureSection: CappedSection
  buildErrors: DiagnosticSummary[]
  buildErrorSection: CappedSection
  observedTests: TestIdentity[]
  observedTestSection: CappedSection
}

/**
 * A trustworthy pass: successful exit, complete build evidence with zero
 * errors, complete counts, at least one observed test, and matched scope.
 */
export type TestRunPassed = TestRunEnvelope & {
  outcome: "passed"
  diagnostics: SummaryDiagnostics
}

/** Known failed tests, no build errors, matched scope, no unknown statuses. */
export type TestRunTestFailed = TestRunEnvelope & {
  outcome: "testFailed"
  diagnostics: SummaryDiagnostics
}

/** Complete build evidence with at least one error. Test evidence may be partial. */
export type TestRunBuildFailed = TestRunEnvelope & {
  outcome: "buildFailed"
  diagnostics: SummaryDiagnostics
}

/** The Test Tool could not trustworthily classify the run. Reason is required. */
export type TestRunInfrastructureFailed = TestRunEnvelope & {
  outcome: "infrastructureFailed"
  reason: InfrastructureReason
  message: string
  diagnostics: SummaryDiagnostics
}

/** The caller cancelled an admitted run. The phase says where it was interrupted. */
export type TestRunCancelled = TestRunEnvelope & {
  outcome: "cancelled"
  interruptionPhase: InterruptionPhase
  diagnostics: SummaryDiagnostics
}

/** The process deadline was crossed. A later cancellation never overwrites this. */
export type TestRunTimedOut = TestRunEnvelope & {
  outcome: "timedOut"
  deadlineCrossedPhase: DeadlineCrossedPhase
  diagnostics: SummaryDiagnostics
}

/** Every terminal account of an admitted Test Run. */
export type TestRunSummary =
  | TestRunPassed
  | TestRunTestFailed
  | TestRunBuildFailed
  | TestRunInfrastructureFailed
  | TestRunCancelled
  | TestRunTimedOut

/** Everything a Test Tool call can resolve to. */
export type TestToolResult =
  | RequestRejected
  | RequestCancelled
  | RequestResolutionFailed
  | TestRunSummary

/** True when the result describes an admitted Test Run and carries a `runId`. */
export function isTestRunSummary(result: TestToolResult): result is TestRunSummary {
  return "runId" in result
}
