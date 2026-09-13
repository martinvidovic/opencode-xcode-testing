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
import type { EvidenceFact } from "./evidence.ts"
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

/**
 * Resolution, discovery, or admission failed operationally.
 *
 * `runnerFailure` appears here as well as on an admitted run: a runtime that
 * cannot execute the supervisor is a runner failure discovered before any Test
 * Run exists, and ADR 0002 mandates that exact diagnostic for it.
 */
export type RequestResolutionFailed = {
  schemaVersion: SchemaVersion
  outcome: "infrastructureFailed"
  phase: ResolutionPhase
  reason: ResolutionFailureReason | QueuedFailureReason | "runnerFailure"
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

/**
 * Compact, non-path provenance for the evidence behind a result (#8).
 * Developer-directory paths, executable paths and binary digests stay private.
 */
export type ResultProvenance = {
  xcodeVersion: string
  xcodeBuild: string
  xcresulttoolVersion: string
  /** The structured schema version explicitly requested, not the tool default. */
  requestedSchemaVersion: string
  interpreterDecoderVersion: number
  /**
   * The runtime that executed the supervisor, by version only. The resolved
   * path is machine-local and stays in durable run metadata, never here.
   */
  runtimeVersion?: string
  /** The OpenCode version observed at startup, or `unknown`. */
  hostVersion?: string
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
  /** Absent when interpretation never reached a toolchain it could record. */
  provenance?: ResultProvenance
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

/** No diagnostics were retained, and the sections say so rather than lying by omission. */
export const NO_DIAGNOSTICS: SummaryDiagnostics = {
  testFailures: [],
  testFailureSection: { total: 0, shown: 0, truncated: false },
  buildErrors: [],
  buildErrorSection: { total: 0, shown: 0, truncated: false },
  observedTests: [],
  observedTestSection: { total: 0, shown: 0, truncated: false },
}

/**
 * The envelope for a Test Run whose facts were never observed.
 *
 * Every evidence field is `unknown` or `unavailable`, never a plausible zero.
 * It lives beside the types rather than in a caller because the alternative is
 * each layer spelling out its own idea of "nothing is known", and a new field
 * on the envelope then has to be patched in several unrelated places.
 */
export function unobservedEnvelope(input: {
  runId: string
  resolved: ResolvedTestRun
  scope: ScopeEvidence
  timing: TestRunTiming
  terminationTrigger: ProcessTerminationTrigger
  /** `no` only where the protocol proves nothing ran; otherwise unobserved. */
  execObserved: EvidenceFact
}): TestRunEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    resolved: input.resolved,
    scope: input.scope,
    timing: input.timing,
    terminationTrigger: input.terminationTrigger,
    termination: {
      requested: "no",
      gracefulTerminationObserved: "unknown",
      forceEscalationRequired: "unknown",
      terminationGraceExceeded: "unknown",
      descendantsConfirmedExited: "unknown",
    },
    execution: { execObserved: input.execObserved, successfulExit: "unknown" },
    build: { completeness: "unavailable" },
    tests: { completeness: "unavailable" },
    inspection: {
      scope: "unavailable",
      failures: "unavailable",
      buildErrors: "unavailable",
      tests: "unavailable",
      log: "unavailable",
    },
  }
}

/** True when the result describes an admitted Test Run and carries a `runId`. */
export function isTestRunSummary(result: TestToolResult): result is TestRunSummary {
  return "runId" in result
}
