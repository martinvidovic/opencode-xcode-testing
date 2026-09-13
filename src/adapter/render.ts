/**
 * The renderer: a pure function from a typed domain object to text.
 *
 * No I/O, no clock, no host handles — which is what makes byte-exact golden
 * testing natural, and what makes a change to the model's entire view of a Test
 * Run visible in review as a diff rather than discovered in production.
 *
 * Two rules shape the output. It uses the outcome vocabulary verbatim, because
 * a model that reads `infrastructureFailed` as "failed" draws the wrong
 * conclusion and a paraphrase invites exactly that. And it never renders a fact
 * the domain did not establish: absent evidence is printed as `unknown` or
 * omitted, never as zero.
 */

import type {
  BuildEvidence,
  EvidenceFact,
  ExecutionEvidence,
  TestCounts,
  TestEvidence,
} from "../domain/evidence.ts"
import type { DiagnosticSummary, InspectionAvailability } from "../domain/inspection.ts"
import type { Destination, ResolvedTestRun, XcodeContainer } from "../domain/request.ts"
import type {
  CappedSection,
  RequestCancelled,
  RequestRejected,
  RequestResolutionFailed,
  ResultProvenance,
  TestRunSummary,
  TestRunTiming,
  TestToolResult,
} from "../domain/result.ts"
import { isTestRunSummary } from "../domain/result.ts"
import type { ScopeAttestation, ScopeEvidence, TestIdentity } from "../domain/scope.ts"
import { block, field, indent, PRIORITY, type Document } from "./document.ts"

/** Characters of the scope digest shown. It is a correlation aid, not a proof. */
const DIGEST_PREFIX = 16

export function renderResult(result: TestToolResult): Document {
  if (isTestRunSummary(result)) return renderTestRun(result)
  if (result.outcome === "invalid") return renderRejected(result)
  if (result.outcome === "cancelled") return renderRequestCancelled(result)
  return renderResolutionFailed(result)
}

// --- pre-execution results ------------------------------------------------

function renderRejected(result: RequestRejected): Document {
  const { total, shown, truncated } = result.errorSection

  return [
    block(
      PRIORITY.envelope,
      `Test Run invalid: ${count(total, "error")}`,
      "",
      "No Test Run was started and no Result Bundle exists.",
    ),
    block(
      PRIORITY.reason,
      section("errors", { total, shown, truncated }),
      ...result.errors.map((error) => indent(1, `${error.field}: ${error.message} [${error.code}]`)),
      ...result.errors.flatMap((error) =>
        error.candidates === undefined
          ? []
          : [
              indent(2, `candidates: ${error.candidates.join(", ")}`),
              ...(error.candidatesTruncated === true ? [indent(2, "(candidates truncated)")] : []),
            ],
      ),
    ),
  ]
}

function renderRequestCancelled(result: RequestCancelled): Document {
  return [
    block(
      PRIORITY.envelope,
      `Test Run cancelled while ${result.phase}`,
      "",
      "No Test Run was started, so there is no run to inspect.",
    ),
    block(
      PRIORITY.context,
      ...(result.queuedAt === undefined ? [] : [field("queued-at", result.queuedAt)]),
      ...(result.queueDurationMs === undefined
        ? []
        : [field("queue", `${result.queueDurationMs}ms`)]),
    ),
  ]
}

function renderResolutionFailed(result: RequestResolutionFailed): Document {
  return [
    block(
      PRIORITY.envelope,
      `Test Run infrastructureFailed while ${result.phase}: ${result.reason}`,
      "",
      result.message,
    ),
    block(
      PRIORITY.context,
      ...(result.queuedAt === undefined ? [] : [field("queued-at", result.queuedAt)]),
      ...(result.queueDurationMs === undefined
        ? []
        : [field("queue", `${result.queueDurationMs}ms`)]),
    ),
  ]
}

// --- Test Run summaries ---------------------------------------------------

function renderTestRun(summary: TestRunSummary): Document {
  return [
    block(PRIORITY.envelope, headline(summary), "", field("run", summary.runId)),
    block(PRIORITY.reason, ...reasonLines(summary)),
    block(
      PRIORITY.facts,
      field("container", containerText(summary.resolved)),
      field("scheme", provenanced(summary.resolved.scheme.value, summary.resolved.scheme.provenance)),
      field("destination", destinationText(summary.resolved)),
      field("scope", scopeText(summary.scope)),
      field("tests", testsText(summary.tests)),
      field("build", buildText(summary.build)),
      field("process", processText(summary),
      ),
    ),
    block(PRIORITY.diagnostics, ...attestationLines(summary.scope)),
    block(PRIORITY.diagnostics, ...diagnosticLines("failures", summary.diagnostics.testFailures, summary.diagnostics.testFailureSection)),
    block(PRIORITY.diagnostics, ...diagnosticLines("build errors", summary.diagnostics.buildErrors, summary.diagnostics.buildErrorSection)),
    block(
      PRIORITY.context,
      field("timing", timingText(summary.timing)),
      ...(summary.provenance === undefined ? [] : [field("toolchain", provenanceText(summary.provenance))]),
      field("inspect", inspectionText(summary.inspection)),
    ),
    block(PRIORITY.sample, ...observedLines(summary.diagnostics.observedTests, summary.diagnostics.observedTestSection)),
  ]
}

function headline(summary: TestRunSummary): string {
  const counts = summary.tests.counts
  switch (summary.outcome) {
    case "passed":
      return `Test Run passed: ${count(counts?.total ?? 0, "test")}, 0 failed`
    case "testFailed":
      return `Test Run testFailed: ${count(counts?.failed ?? 0, "test")} failed of ${counts?.total ?? 0}`
    case "buildFailed":
      return `Test Run buildFailed: ${count(summary.build.errorCount ?? 0, "build error")}`
    case "infrastructureFailed":
      return `Test Run infrastructureFailed: ${summary.reason}`
    case "cancelled":
      return `Test Run cancelled while ${summary.interruptionPhase}`
    case "timedOut":
      return `Test Run timedOut while ${summary.deadlineCrossedPhase}`
  }
}

function reasonLines(summary: TestRunSummary): string[] {
  if (summary.outcome === "infrastructureFailed") {
    return [
      summary.message,
      "",
      "This is neither a pass nor a test failure: the Test Tool could not establish what happened.",
    ]
  }
  if (summary.outcome === "cancelled" || summary.outcome === "timedOut") {
    return ["Evidence below is whatever was established before the run ended."]
  }
  return []
}

// --- fact lines -----------------------------------------------------------

function containerText(resolved: ResolvedTestRun): string {
  const container: XcodeContainer = resolved.xcodeContainer.value
  return provenanced(`${container.kind} ${container.path}`, resolved.xcodeContainer.provenance)
}

function destinationText(resolved: ResolvedTestRun): string {
  const destination: Destination = resolved.destination.value
  const text =
    destination.kind === "id"
      ? `id ${destination.id}`
      : [destination.platform, destination.name, destination.os]
          .filter((part) => part !== undefined)
          .join(" / ")
  return provenanced(text, resolved.destination.provenance)
}

function provenanced(value: string, provenance: string): string {
  return `${value} (${provenance})`
}

function scopeText(scope: ScopeEvidence): string {
  const parts = [scope.kind, scope.verdict]
  if (scope.kind === "selected") parts.push(count(scope.requestedSelectionCount, "selection"))
  if (scope.observedOutsideScope !== undefined) {
    parts.push(`${scope.observedOutsideScope} observed outside scope`)
  }
  parts.push(`digest ${scope.digest.slice(0, DIGEST_PREFIX)}`)
  return parts.join(", ")
}

function testsText(tests: TestEvidence): string {
  // Absent evidence is never printed as zero, and never printed twice either.
  if (tests.completeness === "unavailable") return "unavailable"
  if (tests.counts === undefined) return `no counts (${tests.completeness})`
  return `${countsText(tests.counts)} (${tests.completeness})`
}

function countsText(counts: TestCounts): string {
  const categories: Array<[keyof TestCounts, string]> = [
    ["passed", "passed"],
    ["failed", "failed"],
    ["skipped", "skipped"],
    ["expectedFailure", "expected failures"],
    ["unknown", "unknown"],
  ]
  const parts = categories
    .filter(([key]) => counts[key] > 0)
    .map(([key, label]) => `${counts[key]} ${label}`)
  return [`${counts.total} total`, ...parts].join(", ")
}

function buildText(build: BuildEvidence): string {
  if (build.completeness === "unavailable") return "unavailable"
  if (build.errorCount === undefined) return `no count (${build.completeness})`
  return `${count(build.errorCount, "error")} (${build.completeness})`
}

function processText(summary: TestRunSummary): string {
  const execution: ExecutionEvidence = summary.execution
  const exit =
    execution.signal !== undefined
      ? `signal ${execution.signal}`
      : execution.exitCode === undefined
        ? "exit unknown"
        : `exit ${execution.exitCode}`

  return [
    exit,
    `exec ${execution.execObserved}`,
    `terminated by ${summary.terminationTrigger}`,
    `descendants exited ${fact(summary.termination.descendantsConfirmedExited)}`,
  ].join(", ")
}

function fact(value: EvidenceFact): EvidenceFact {
  return value
}

function timingText(timing: TestRunTiming): string {
  const parts = [`queued ${timing.queueDurationMs}ms`]
  if (timing.startupDurationMs !== undefined) parts.push(`startup ${timing.startupDurationMs}ms`)
  if (timing.processDurationMs !== undefined) parts.push(`process ${timing.processDurationMs}ms`)
  if (timing.interpretationDurationMs !== undefined) {
    parts.push(`interpretation ${timing.interpretationDurationMs}ms`)
  }
  parts.push(`total ${timing.totalDurationMs}ms`)
  return parts.join(", ")
}

function provenanceText(provenance: ResultProvenance): string {
  return [
    `Xcode ${provenance.xcodeVersion} (${provenance.xcodeBuild})`,
    `xcresulttool ${provenance.xcresulttoolVersion}`,
    `schema ${provenance.requestedSchemaVersion}`,
    `decoder ${provenance.interpreterDecoderVersion}`,
  ].join(", ")
}

function inspectionText(availability: InspectionAvailability): string {
  return (["scope", "failures", "buildErrors", "tests", "log"] as const)
    .map((facet) => `${facet}=${availability[facet]}`)
    .join(" ")
}

// --- sections -------------------------------------------------------------

function attestationLines(scope: ScopeEvidence): string[] {
  if (scope.attestations.length === 0) return []

  return [
    section("scope attestations", {
      total: scope.requestedSelectionCount,
      shown: scope.shown,
      truncated: scope.truncated,
    }),
    ...scope.attestations.map((attestation) => indent(1, attestationText(attestation))),
  ]
}

function attestationText(attestation: ScopeAttestation): string {
  const { bundle, suite, test } = attestation.selection
  const selection = [bundle, suite, test].filter((part) => part !== undefined).join("/")
  const matched =
    attestation.matchedTestCount === undefined
      ? ""
      : ` (${count(attestation.matchedTestCount, "test")})`
  return `${selection}: ${attestation.verdict}${matched}`
}

function diagnosticLines(
  label: string,
  diagnostics: DiagnosticSummary[],
  capped: CappedSection,
): string[] {
  if (diagnostics.length === 0) return []

  const lines = [section(label, capped)]
  for (const diagnostic of diagnostics) {
    lines.push(indent(1, diagnostic.location === undefined ? "(no location)" : locationText(diagnostic)))
    lines.push(indent(2, diagnostic.message))
    lines.push(
      indent(
        2,
        diagnostic.inspectionAvailable
          ? `inspect ${diagnostic.id}`
          : `id ${diagnostic.id} (no further detail retained)`,
      ),
    )
  }
  return lines
}

function locationText(diagnostic: DiagnosticSummary): string {
  const location = diagnostic.location
  if (location === undefined) return "(no location)"
  return [location.path, location.line, location.column]
    .filter((part) => part !== undefined)
    .join(":")
}

function observedLines(observed: TestIdentity[], capped: CappedSection): string[] {
  if (observed.length === 0) return []
  return [
    section("observed tests", capped),
    ...observed.map((identity) => indent(1, identity.canonical)),
  ]
}

/**
 * Aggregate counts are never capped, so a truncated section still tells the
 * caller how many there really are — the number matters more than the list.
 */
function section(label: string, capped: CappedSection): string {
  return capped.truncated
    ? `${label} (showing ${capped.shown} of ${capped.total}):`
    : `${label} (${capped.total}):`
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}
