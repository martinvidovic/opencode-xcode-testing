/**
 * Requested Scope attestation (#7).
 *
 * This is the check that makes a green result mean something. Without it, a
 * Test Run whose `-only-testing` filter matched nothing exits successfully and
 * looks exactly like a run where everything passed — which is the single most
 * expensive false signal this tool could give a model.
 */

import type { ScopeAttestation, ScopeVerdict, TestSelection } from "../domain/scope.ts"
import { normalizeRequestedScope, type RequestedScope } from "../domain/scope.ts"
import type { NormalizedOccurrence } from "./occurrences.ts"

export type Attestation = {
  attestations: ScopeAttestation[]
  verdict: ScopeVerdict
  observedOutsideScope: number
}

/**
 * Attest a normalized scope against the observed occurrences.
 *
 * `notReached` is reserved for the case where trustworthy evidence establishes
 * that testing never began. Everything else that produced no tests is
 * `unverifiable` — an absent observation is not proof of anything.
 */
export function attestScope(
  scope: RequestedScope,
  occurrences: NormalizedOccurrence[],
  evidence: { testingReached: boolean | "unknown" },
): Attestation {
  const normalized = normalizeRequestedScope(scope)
  const selections = normalized.kind === "selected" ? normalized.tests : []

  if (evidence.testingReached === false) {
    return {
      attestations: selections.map((selection) => ({ selection, verdict: "notReached" })),
      verdict: "notReached",
      observedOutsideScope: 0,
    }
  }

  const identityUsable = occurrences.every((occurrence) => occurrence.identityComplete)

  if (normalized.kind === "all") {
    const verdict: ScopeVerdict = !identityUsable
      ? "unverifiable"
      : occurrences.length > 0
        ? "matched"
        : "unverifiable"
    return { attestations: [], verdict, observedOutsideScope: 0 }
  }

  const attestations: ScopeAttestation[] = selections.map((selection) => {
    const matchedTestCount = occurrences.filter((occurrence) =>
      selectionMatches(selection, occurrence),
    ).length
    const verdict: ScopeVerdict = !identityUsable
      ? "unverifiable"
      : matchedTestCount > 0
        ? "matched"
        : "mismatched"
    return { selection, verdict, matchedTestCount }
  })

  const observedOutsideScope = occurrences.filter(
    (occurrence) => !selections.some((selection) => selectionMatches(selection, occurrence)),
  ).length

  const verdict: ScopeVerdict = !identityUsable
    ? "unverifiable"
    : attestations.some((attestation) => attestation.verdict === "mismatched") ||
        observedOutsideScope > 0
      ? "mismatched"
      : attestations.length === 0 || occurrences.length === 0
        ? "unverifiable"
        : "matched"

  return { attestations, verdict, observedOutsideScope }
}

/**
 * A bundle selection matches any observed test in that exact bundle; a suite
 * selection additionally requires the suite; a test selection requires all
 * three. Matching is exact — these are selections, not patterns.
 */
export function selectionMatches(
  selection: TestSelection,
  occurrence: NormalizedOccurrence,
): boolean {
  const identity = occurrence.identity
  if (identity.bundle !== selection.bundle) return false
  if (selection.suite !== undefined && identity.suite !== selection.suite) return false
  if (selection.test !== undefined && identity.test !== selection.test) return false
  return true
}
