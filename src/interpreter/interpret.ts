/**
 * Eager interpretation (#8): read the Result Bundle once, publish one immutable
 * normalized index, and classify from it.
 *
 * Three properties this orchestration exists to preserve:
 *
 * - **The Result Bundle is the sole classification authority.** Raw logs are
 *   never read here. Their text is version-dependent and repository-controlled,
 *   so a tool that classified on them could be talked into reporting success.
 * - **No early exit on a provable build failure.** Availability, build results,
 *   the test hierarchy and summary diagnostics are all retrieved within the
 *   remaining budget, because a caller inspecting a `buildFailed` run still
 *   wants whatever test evidence exists.
 * - **One monotonic deadline over everything.** Each call receives only the
 *   remaining budget; on expiry, already-completed facets publish as `partial`
 *   or `complete` and the in-progress ones are discarded.
 */

import type {
  BuildEvidence,
  ExecutionEvidence,
  TerminationEvidence,
  TestEvidence,
} from "../domain/evidence.ts"
import type { FacetAvailability, InspectionAvailability } from "../domain/inspection.ts"
import {
  SCOPE_ATTESTATION_CAP,
  SUMMARY_BUILD_ERROR_CAP,
  SUMMARY_OBSERVED_TEST_CAP,
  SUMMARY_TEST_FAILURE_CAP,
} from "../domain/limits.ts"
import type {
  DeadlineCrossedPhase,
  InfrastructureReason,
  InterruptionPhase,
  ProcessTerminationTrigger,
} from "../domain/outcome.ts"
import type { ResolvedTestRun } from "../domain/request.ts"
import type {
  CappedSection,
  ResultProvenance,
  SummaryDiagnostics,
  TestRunEnvelope,
  TestRunSummary,
  TestRunTiming,
} from "../domain/result.ts"
import { SCHEMA_VERSION } from "../domain/result.ts"
import { requestedScopeDigest, type RequestedScope } from "../domain/scope.ts"
import { normalizeRequestedScope } from "../domain/scope.ts"
import type { Anomaly } from "./anomalies.ts"
import { AnomalyLog } from "./anomalies.ts"
import { attestScope } from "./attestation.ts"
import { classify, type EvidenceDefect } from "./classify.ts"
import {
  decodeBuildResults,
  decodeContentAvailability,
  decodeTestResults,
  decodeTestSummary,
  type RawBuildIssue,
  type RawTestFailure,
} from "./decode.ts"
import { buildBuildErrors, buildTestFailures, type IndexedOccurrence } from "./diagnostics.ts"
import { deriveId } from "./ids.ts"
import { countOccurrences, INDEX_VERSION, type NormalizedIndex } from "./index-model.ts"
import { normalizeTestNodes, type NormalizedOccurrence } from "./occurrences.ts"
import type { CancellationSignal, ExecutionFacts, MonotonicClock, XcresultTool } from "./ports.ts"
import { toolchainIdentityMatches } from "./ports.ts"
import {
  DECODER_VERSION,
  EAGER_DEADLINE_MS,
  isSupportedXcodeVersion,
  REQUESTED_SCHEMA_VERSION,
} from "./schema.ts"

export type InterpretationRequest = {
  facts: ExecutionFacts
  requestedScope: RequestedScope
  resolved: ResolvedTestRun
  timing: Omit<TestRunTiming, "interpretationDurationMs" | "totalDurationMs"> & {
    /** Admission through process exit, so the interpreter can finish the total. */
    elapsedBeforeInterpretationMs: number
  }
  terminationTrigger: ProcessTerminationTrigger
  termination: TerminationEvidence
  execution: ExecutionEvidence
  interruptionPhase?: InterruptionPhase
  deadlineCrossedPhase?: DeadlineCrossedPhase
  tool: XcresultTool
  clock: MonotonicClock
  signal?: CancellationSignal
  deadlineMs?: number
}

export type InterpretedRun = {
  summary: TestRunSummary
  index: NormalizedIndex
  anomalies: readonly Anomaly[]
}

export async function interpretRun(request: InterpretationRequest): Promise<InterpretedRun> {
  const anomalies = new AnomalyLog()
  const startedAt = request.clock.now()
  const deadlineMs = request.deadlineMs ?? EAGER_DEADLINE_MS
  const remaining = () => deadlineMs - (request.clock.now() - startedAt)

  const gathered = await gather(request, anomalies, remaining)

  const interpretationDurationMs = request.clock.now() - startedAt
  return publish(request, gathered, anomalies, interpretationDurationMs)
}

// --- gathering ------------------------------------------------------------

type Gathered = {
  build: BuildEvidence
  tests: TestEvidence
  occurrences: NormalizedOccurrence[]
  buildIssues: RawBuildIssue[]
  supplementalFailures: RawTestFailure[]
  testingReached: boolean | "unknown"
  defect?: EvidenceDefect
  cancelledDuringInterpretation: boolean
  provenance?: ResultProvenance
}

/** Lower rank wins, so a stronger statement about the evidence is never lost. */
const DEFECT_RANK: Record<InfrastructureReason, number> = {
  interpretationTimedOut: 0,
  resultBundleMissing: 1,
  resultBundleUnreadable: 2,
  unsupportedResultSchema: 3,
  contradictoryEvidence: 4,
  resultBundleIncomplete: 5,
  scopeMismatch: 6,
  scopeUnverifiable: 6,
  unknownTestStatus: 6,
  processLaunchFailed: 6,
  processFailedWithoutDiagnostics: 6,
  runnerFailure: 6,
}

async function gather(
  request: InterpretationRequest,
  anomalies: AnomalyLog,
  remaining: () => number,
): Promise<Gathered> {
  const state: Gathered = {
    build: { completeness: "unavailable" },
    tests: { completeness: "unavailable" },
    occurrences: [],
    buildIssues: [],
    supplementalFailures: [],
    testingReached: "unknown",
    cancelledDuringInterpretation: false,
  }

  const setDefect = (reason: InfrastructureReason, message: string) => {
    if (state.defect === undefined || DEFECT_RANK[reason] < DEFECT_RANK[state.defect.reason]) {
      state.defect = { reason, message }
    }
  }

  const cancelled = () => {
    if (request.signal?.aborted !== true) return false
    state.cancelledDuringInterpretation = true
    return true
  }

  const expired = () => {
    if (remaining() > 0) return false
    setDefect("interpretationTimedOut", "interpretation exceeded its deadline")
    return true
  }

  if (cancelled()) return state

  // Identity first: reading a bundle with the wrong toolchain is not a read.
  const identity = request.tool.identity
  if (!toolchainIdentityMatches(request.facts.toolchain, identity)) {
    setDefect("unsupportedResultSchema", "the recorded toolchain no longer matches")
    return state
  }
  if (!isSupportedXcodeVersion(identity.xcodeVersion)) {
    setDefect("unsupportedResultSchema", "the Xcode major version is not supported")
    return state
  }
  if (identity.schemaVersion !== REQUESTED_SCHEMA_VERSION) {
    setDefect("unsupportedResultSchema", "the structured schema version is not supported")
    return state
  }

  state.provenance = {
    xcodeVersion: identity.xcodeVersion,
    xcodeBuild: identity.xcodeBuild,
    xcresulttoolVersion: identity.xcresulttoolVersion,
    requestedSchemaVersion: REQUESTED_SCHEMA_VERSION,
    interpreterDecoderVersion: DECODER_VERSION,
  }

  if (request.facts.bundleDigestVerified !== "yes") {
    // An internal stability anomaly, not a classification defect: the bundle is
    // still the evidence we have, and refusing to report it would be worse.
    anomalies.record({
      command: "metadata get",
      fieldPath: "result.xcresult",
      observedShape: `digest verification ${request.facts.bundleDigestVerified}`,
      normalizationApplied: "recorded; lazy bundle-backed detail degrades",
      lossy: true,
    })
  }

  if (!request.facts.resultBundlePresent) {
    setDefect("resultBundleMissing", "the expected Result Bundle does not exist")
    return state
  }

  // Preflight. Readability is established by the tool opening the bundle, never
  // by pattern-matching its stderr wording.
  if (expired()) return state
  const preflight = await request.tool.run("metadata get", remaining())
  if (!preflight.ok) {
    setDefect(...mapFailure(preflight.failure, preflight.message))
    return state
  }

  if (cancelled() || expired()) return state
  const availabilityResponse = await request.tool.run("get content-availability", remaining())
  if (!availabilityResponse.ok) {
    setDefect(...mapFailure(availabilityResponse.failure, availabilityResponse.message))
    return state
  }
  const availability = decodeContentAvailability(availabilityResponse.payload)
  if (!availability.ok) {
    setDefect(...mapDecode(availability.defect, availability.fieldPath, availability.message))
    return state
  }

  // Build results. Availability makes no claim about them — the observed
  // payload has no `hasBuildResults` field — so they are always retrieved, and
  // a failure to read the authoritative build facet is incompleteness rather
  // than silence.
  {
    if (cancelled() || expired()) return state
    const response = await request.tool.run("get build-results", remaining())
    if (!response.ok) {
      setDefect(...mapFailure(response.failure, response.message))
    } else {
      const decoded = decodeBuildResults(response.payload, anomalies)
      if (!decoded.ok) {
        setDefect(...mapDecode(decoded.defect, decoded.fieldPath, decoded.message))
      } else {
        state.buildIssues = decoded.value.errors
        const countAgrees =
          decoded.value.declaredErrorCount === undefined ||
          decoded.value.declaredErrorCount === decoded.value.errors.length
        const complete = decoded.value.malformedErrorCount === 0 && countAgrees
        if (!countAgrees) {
          anomalies.record({
            command: "get build-results",
            fieldPath: "errorCount",
            observedShape: `declared ${decoded.value.declaredErrorCount}`,
            normalizationApplied: "facet downgraded to partial",
            lossy: true,
          })
        }
        state.build = {
          completeness: complete ? "complete" : "partial",
          errorCount: decoded.value.errors.length,
        }
      }
    }
  }

  // Test hierarchy. Skipped only when availability authoritatively says there
  // are no test results — never as an optimization.
  if (availability.value.hasTestResults) {
    state.testingReached = true
    if (cancelled() || expired()) return state
    const response = await request.tool.run("get test-results tests", remaining())
    if (!response.ok) {
      setDefect("resultBundleIncomplete", "advertised test results could not be retrieved")
    } else {
      const decoded = decodeTestResults(response.payload)
      if (!decoded.ok) {
        setDefect(...mapDecode(decoded.defect, decoded.fieldPath, decoded.message))
      } else {
        const normalized = normalizeTestNodes(decoded.value.nodes, {
          trustedRoot: request.facts.trustedRoot,
          ...(decoded.value.configurations[0] === undefined
            ? {}
            : { configurationId: decoded.value.configurations[0] }),
          ...(decoded.value.devices[0] === undefined ? {} : { deviceId: decoded.value.devices[0] }),
        })
        state.occurrences = normalized.occurrences

        if (normalized.unrecognizedStatuses.length > 0) {
          // A new status literal is an incompatible critical shape, not a gap.
          setDefect("unsupportedResultSchema", "a test reported an unrecognized status")
          state.tests = { completeness: "partial", counts: countOf(normalized.occurrences) }
        } else if (normalized.missingStatusCount > 0) {
          setDefect("resultBundleIncomplete", "a recognized test carried no status")
          state.tests = { completeness: "partial", counts: countOf(normalized.occurrences) }
        } else {
          state.tests = { completeness: "complete", counts: countOf(normalized.occurrences) }
        }
      }
    }
  } else if (state.build.completeness === "complete" && (state.build.errorCount ?? 0) > 0) {
    // The only situation in which testing provably never began.
    state.testingReached = false
  }

  // Summary: diagnostics and cross-check only. A defect here degrades the
  // detail it carries and never overturns the authoritative facets.
  if (cancelled() || expired()) return state
  const summaryResponse = await request.tool.run("get test-results summary", remaining())
  if (summaryResponse.ok) {
    const decoded = decodeTestSummary(summaryResponse.payload, anomalies)
    if (!decoded.ok) {
      anomalies.record({
        command: "get test-results summary",
        fieldPath: decoded.fieldPath,
        observedShape: decoded.message,
        normalizationApplied: "summary discarded",
        lossy: true,
      })
    } else {
      state.supplementalFailures = decoded.value.testFailures
      const contradiction = reconcileSummary(decoded.value, state, availability.value)
      if (contradiction !== undefined) setDefect("contradictoryEvidence", contradiction)
    }
  }

  return state
}

function countOf(occurrences: NormalizedOccurrence[]) {
  return countOccurrences(occurrences.map((occurrence, index) => ({ ...occurrence, id: String(index) })))
}

/**
 * Only facts known to share semantics are reconciled. Multiple configurations,
 * multiple devices, or repetitions make the summary's aggregation incomparable
 * to normalized occurrences — an internal limitation, not a failure.
 */
function reconcileSummary(
  summary: {
    totalTestCount?: number
    passedTests?: number
    failedTests?: number
    skippedTests?: number
    expectedFailures?: number
  },
  state: Gathered,
  availability: { hasTestResults: boolean },
): string | undefined {
  const parts = [
    summary.passedTests,
    summary.failedTests,
    summary.skippedTests,
    summary.expectedFailures,
  ]
  const bucketsKnown = parts.every((part) => part !== undefined)
  const bucketSum = parts.reduce<number>((total, part) => total + (part ?? 0), 0)

  // Xcode's summary has no bucket for an unknown status, so the buckets may sum
  // to less than the total. Exceeding it is the arithmetic error worth catching.
  if (summary.totalTestCount !== undefined && bucketsKnown && bucketSum > summary.totalTestCount) {
    return "the Result Bundle summary's own counts do not add up"
  }

  if (!availability.hasTestResults && (summary.totalTestCount ?? 0) > 0) {
    return "content availability reports no test results while the summary reports tests"
  }

  if (state.tests.completeness !== "complete") return undefined
  const counts = state.tests.counts
  if (counts === undefined) return undefined

  const comparable = state.occurrences.every((occurrence) => occurrence.attempts.length <= 1)
  if (!comparable) return undefined

  if (summary.totalTestCount !== undefined && summary.totalTestCount !== counts.total) {
    return "the Result Bundle summary and the test hierarchy report different test totals"
  }
  if (summary.failedTests !== undefined && summary.failedTests !== counts.failed) {
    return "the Result Bundle summary and the test hierarchy report different failure counts"
  }
  // Whatever the summary's total does not attribute to a bucket must be exactly
  // the tests the hierarchy could not attribute to a status.
  if (summary.totalTestCount !== undefined && bucketsKnown) {
    if (summary.totalTestCount - bucketSum !== counts.unknown) {
      return "the Result Bundle summary and the test hierarchy disagree on unknown statuses"
    }
  }
  return undefined
}

function mapFailure(failure: string, message: string): [InfrastructureReason, string] {
  switch (failure) {
    case "bundleMissing":
      return ["resultBundleMissing", message]
    case "unsupported":
      return ["unsupportedResultSchema", message]
    case "timedOut":
      return ["interpretationTimedOut", message]
    default:
      return ["resultBundleUnreadable", message]
  }
}

function mapDecode(
  defect: "unsupportedSchema" | "incomplete",
  fieldPath: string,
  message: string,
): [InfrastructureReason, string] {
  const where = fieldPath === "" ? message : `${fieldPath}: ${message}`
  return defect === "unsupportedSchema"
    ? ["unsupportedResultSchema", where]
    : ["resultBundleIncomplete", where]
}

// --- publication ----------------------------------------------------------

function publish(
  request: InterpretationRequest,
  gathered: Gathered,
  anomalies: AnomalyLog,
  interpretationDurationMs: number,
): InterpretedRun {
  const runId = request.facts.runId

  const occurrences: IndexedOccurrence[] = gathered.occurrences.map((occurrence, ordinal) => ({
    ...occurrence,
    id: deriveId({
      runId,
      kind: "occurrence",
      source: occurrence.identity.canonical,
      context: `${occurrence.configurationId ?? ""}|${occurrence.deviceId ?? ""}`,
      position: occurrence.position,
      ordinal,
    }),
  }))

  const counts = gathered.tests.completeness === "unavailable" ? undefined : countOccurrences(occurrences)

  const attestation = attestScope(request.requestedScope, gathered.occurrences, {
    testingReached: gathered.testingReached,
  })

  const { diagnostics: testFailures } = buildTestFailures(
    occurrences,
    gathered.supplementalFailures,
    { runId },
  )
  const buildErrors = buildBuildErrors(gathered.buildIssues, {
    runId,
    trustedRoot: request.facts.trustedRoot,
  })

  const normalizedScope = normalizeRequestedScope(request.requestedScope)

  const index: NormalizedIndex = {
    indexVersion: INDEX_VERSION,
    runId,
    decoderVersion: DECODER_VERSION,
    schemaVersion: REQUESTED_SCHEMA_VERSION,
    occurrences,
    testFailures,
    buildErrors,
    attestations: attestation.attestations,
    scopeVerdict: attestation.verdict,
    scopeDigest: requestedScopeDigest(request.requestedScope),
    requestedSelectionCount: normalizedScope.kind === "selected" ? normalizedScope.tests.length : 0,
    observedOutsideScope: attestation.observedOutsideScope,
    ...(counts === undefined ? {} : { counts }),
    build: gathered.build,
    tests: gathered.tests,
    log: {
      availability: request.facts.log.retainedBytes === undefined ? "unavailable" : "available",
      ...(request.facts.log.retainedBytes === undefined
        ? {}
        : { retainedBytes: request.facts.log.retainedBytes }),
      retainedBytesExact: request.facts.log.retainedBytesExact,
    },
    bundleDigestVerified: request.facts.bundleDigestVerified,
  }

  const classification = classify({
    terminationTrigger: request.terminationTrigger,
    execution: request.execution,
    build: gathered.build,
    tests: gathered.tests,
    ...(counts === undefined ? {} : { counts }),
    scopeVerdict: attestation.verdict,
    testingReached: gathered.testingReached,
    ...(gathered.defect === undefined ? {} : { defect: gathered.defect }),
    cancelledDuringInterpretation: gathered.cancelledDuringInterpretation,
    ...(request.interruptionPhase === undefined
      ? {}
      : { interruptionPhase: request.interruptionPhase }),
    ...(request.deadlineCrossedPhase === undefined
      ? {}
      : { deadlineCrossedPhase: request.deadlineCrossedPhase }),
  })

  const envelope: TestRunEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    resolved: request.resolved,
    scope: {
      kind: request.requestedScope.kind,
      digest: index.scopeDigest,
      requestedSelectionCount: index.requestedSelectionCount,
      verdict: attestation.verdict,
      attestations: attestation.attestations.slice(0, SCOPE_ATTESTATION_CAP),
      shown: Math.min(attestation.attestations.length, SCOPE_ATTESTATION_CAP),
      truncated: attestation.attestations.length > SCOPE_ATTESTATION_CAP,
      ...(attestation.observedOutsideScope === 0
        ? {}
        : { observedOutsideScope: attestation.observedOutsideScope }),
    },
    timing: {
      admittedAt: request.timing.admittedAt,
      queueDurationMs: request.timing.queueDurationMs,
      ...(request.timing.startedAt === undefined ? {} : { startedAt: request.timing.startedAt }),
      ...(request.timing.startupDurationMs === undefined
        ? {}
        : { startupDurationMs: request.timing.startupDurationMs }),
      ...(request.timing.processDurationMs === undefined
        ? {}
        : { processDurationMs: request.timing.processDurationMs }),
      interpretationDurationMs,
      totalDurationMs: request.timing.elapsedBeforeInterpretationMs + interpretationDurationMs,
    },
    terminationTrigger: request.terminationTrigger,
    termination: request.termination,
    execution: request.execution,
    build: gathered.build,
    tests: gathered.tests,
    inspection: availabilityOf(index),
    ...(gathered.provenance === undefined ? {} : { provenance: gathered.provenance }),
  }

  const diagnostics = summaryDiagnostics(index)

  const summary: TestRunSummary =
    classification.outcome === "infrastructureFailed"
      ? {
          ...envelope,
          outcome: "infrastructureFailed",
          reason: classification.reason,
          message: classification.message,
          diagnostics,
        }
      : classification.outcome === "cancelled"
        ? {
            ...envelope,
            outcome: "cancelled",
            interruptionPhase: classification.interruptionPhase,
            diagnostics,
          }
        : classification.outcome === "timedOut"
          ? {
              ...envelope,
              outcome: "timedOut",
              deadlineCrossedPhase: classification.deadlineCrossedPhase,
              diagnostics,
            }
          : { ...envelope, outcome: classification.outcome, diagnostics }

  return { summary, index, anomalies: anomalies.records }
}

function summaryDiagnostics(index: NormalizedIndex): SummaryDiagnostics {
  const observedTests = index.occurrences.map((occurrence) => occurrence.identity)
  return {
    testFailures: index.testFailures.slice(0, SUMMARY_TEST_FAILURE_CAP),
    testFailureSection: section(index.testFailures.length, SUMMARY_TEST_FAILURE_CAP),
    buildErrors: index.buildErrors.slice(0, SUMMARY_BUILD_ERROR_CAP),
    buildErrorSection: section(index.buildErrors.length, SUMMARY_BUILD_ERROR_CAP),
    observedTests: observedTests.slice(0, SUMMARY_OBSERVED_TEST_CAP),
    observedTestSection: section(observedTests.length, SUMMARY_OBSERVED_TEST_CAP),
  }
}

function section(total: number, cap: number): CappedSection {
  return { total, shown: Math.min(total, cap), truncated: total > cap }
}

function availabilityOf(index: NormalizedIndex): InspectionAvailability {
  const tests = facetAvailability(index.tests.completeness)
  return {
    scope: tests,
    failures: tests,
    tests,
    buildErrors: facetAvailability(index.build.completeness),
    log: index.log.availability,
  }
}

function facetAvailability(
  completeness: "complete" | "partial" | "unavailable",
): FacetAvailability {
  switch (completeness) {
    case "complete":
      return "available"
    case "partial":
      return "incomplete"
    case "unavailable":
      return "unavailable"
  }
}
