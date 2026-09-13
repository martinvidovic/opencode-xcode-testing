/**
 * Normalizing the `get test-results tests` hierarchy into counted occurrences
 * and their attempts (#8).
 *
 * The distinctions this file exists to hold:
 *
 * - a **Test Case** under a distinct configuration/device context is one
 *   *occurrence*, and every occurrence is counted;
 * - **Test Case Run** and **Repetition** descendants are *attempts* beneath an
 *   occurrence, never separate count entries — otherwise a retried test would
 *   inflate the totals;
 * - a failed attempt always wins the aggregate, so a passing retry can never
 *   hide flakiness behind a green summary;
 * - diagnostic, attachment, activity and runtime-warning nodes are never tests.
 */

import type { TestStatus } from "../domain/evidence.ts"
import type { SafeLocation } from "../domain/inspection.ts"
import { canonicalTestIdentity, type TestIdentity } from "../domain/scope.ts"
import type { RawTestNode } from "./decode.ts"
import { safeLocationFromSourceURL } from "./locations.ts"

export const TEST_BUNDLE_NODE_TYPES = new Set(["Unit test bundle", "UI test bundle"])
export const ATTEMPT_NODE_TYPES = new Set(["Test Case Run", "Repetition"])
export const FAILURE_NODE_TYPE = "Failure Message"
export const SOURCE_REFERENCE_NODE_TYPE = "Source Code Reference"

/** One attempt at an occurrence, with its own original Xcode status preserved. */
export type NormalizedAttempt = {
  ordinal: number
  status: TestStatus
  sourceResult?: string
  durationMs?: number
}

/** A raw failure message attached to an occurrence, before it becomes a diagnostic. */
export type NormalizedFailure = {
  message: string
  location?: SafeLocation
  /** Stable position within the occurrence, used for deterministic IDs. */
  position: string
}

export type NormalizedOccurrence = {
  identity: TestIdentity
  /** Absent when identity components were missing or contradictory. */
  identityComplete: boolean
  status: TestStatus
  sourceResult?: string
  durationMs?: number
  attempts: NormalizedAttempt[]
  failures: NormalizedFailure[]
  /** The node path within the hierarchy: stable, and never display text alone. */
  position: string
  configurationId?: string
  deviceId?: string
}

export type NormalizationOutcome = {
  occurrences: NormalizedOccurrence[]
  /** Plan/launch infrastructure, retained privately and never counted. */
  pseudoTestCount: number
  /** A `Test Case` carrying a recognized shape but no usable status. */
  missingStatusCount: number
  /** A status literal the decoder does not recognize: an incompatible schema. */
  unrecognizedStatuses: string[]
}

/**
 * Walk the node hierarchy once, in source order, collecting occurrences.
 *
 * A `Test Case` with no test-bundle ancestor is plan or launch infrastructure —
 * user-authored tests always live inside a bundle — so it is confidently
 * classified as a pseudo-test, excluded from counts, and never treated as an
 * out-of-scope observation. Anything the decoder cannot confidently classify is
 * counted as a normal occurrence: miscounting beats silently dropping a test.
 */
export function normalizeTestNodes(
  nodes: RawTestNode[],
  options: { trustedRoot: string; configurationId?: string; deviceId?: string },
): NormalizationOutcome {
  const outcome: NormalizationOutcome = {
    occurrences: [],
    pseudoTestCount: 0,
    missingStatusCount: 0,
    unrecognizedStatuses: [],
  }

  const walk = (node: RawTestNode, ancestry: Ancestry, path: string) => {
    if (node.nodeType === "Test Case") {
      if (ancestry.bundle === undefined) {
        outcome.pseudoTestCount += 1
        return
      }
      collectOccurrence(node, ancestry, path, options, outcome)
      return
    }

    const nextAncestry = extendAncestry(node, ancestry)
    node.children.forEach((child, index) => {
      walk(child, nextAncestry, `${path}/${index}`)
    })
  }

  nodes.forEach((node, index) => {
    walk(node, {}, String(index))
  })

  return outcome
}

type Ancestry = { bundle?: string; suite?: string }

function extendAncestry(node: RawTestNode, ancestry: Ancestry): Ancestry {
  if (TEST_BUNDLE_NODE_TYPES.has(node.nodeType)) return { bundle: node.name }
  if (node.nodeType === "Test Suite") return { ...ancestry, suite: node.name }
  return ancestry
}

function collectOccurrence(
  node: RawTestNode,
  ancestry: Ancestry,
  path: string,
  options: { trustedRoot: string; configurationId?: string; deviceId?: string },
  outcome: NormalizationOutcome,
): void {
  const attempts: NormalizedAttempt[] = []
  const failures: NormalizedFailure[] = []

  collectDescendants(node, path, options.trustedRoot, attempts, failures, outcome)

  const own = mapStatus(node.result, outcome)
  if (own === "missing") outcome.missingStatusCount += 1

  const aggregated =
    attempts.length > 0
      ? aggregateAttempts(attempts.map((attempt) => attempt.status))
      : own === "missing"
        ? "unknown"
        : own

  const identity = deriveIdentity(node, ancestry)

  outcome.occurrences.push({
    identity: identity.identity,
    identityComplete: identity.complete,
    status: aggregated,
    ...(node.result === undefined ? {} : { sourceResult: node.result }),
    ...durationField(node.duration),
    attempts,
    failures,
    position: path,
    ...(options.configurationId === undefined ? {} : { configurationId: options.configurationId }),
    ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
  })
}

function collectDescendants(
  node: RawTestNode,
  path: string,
  trustedRoot: string,
  attempts: NormalizedAttempt[],
  failures: NormalizedFailure[],
  outcome: NormalizationOutcome,
): void {
  node.children.forEach((child, index) => {
    const childPath = `${path}/${index}`

    if (ATTEMPT_NODE_TYPES.has(child.nodeType)) {
      const status = mapStatus(child.result, outcome)
      attempts.push({
        ordinal: attempts.length,
        status: status === "missing" ? "unknown" : status,
        ...(child.result === undefined ? {} : { sourceResult: child.result }),
        ...durationField(child.duration),
      })
    }

    if (child.nodeType === FAILURE_NODE_TYPE) {
      failures.push({
        message: child.name,
        ...locationField(child, trustedRoot),
        position: childPath,
      })
    }

    collectDescendants(child, childPath, trustedRoot, attempts, failures, outcome)
  })
}

/** `failed > unknown > passed > expectedFailure > skipped`. */
const AGGREGATION_PRECEDENCE: TestStatus[] = [
  "failed",
  "unknown",
  "passed",
  "expectedFailure",
  "skipped",
]

export function aggregateAttempts(statuses: TestStatus[]): TestStatus {
  for (const candidate of AGGREGATION_PRECEDENCE) {
    if (statuses.includes(candidate)) return candidate
  }
  return "unknown"
}

/**
 * `missing` is distinct from `unknown`: a literal Xcode `"unknown"` is a
 * complete observation that forces `unknownTestStatus`, while an absent status
 * is incomplete evidence. An unrecognized literal is an unsupported schema.
 */
function mapStatus(result: string | undefined, outcome: NormalizationOutcome): TestStatus | "missing" {
  if (result === undefined) return "missing"
  switch (result) {
    case "Passed":
      return "passed"
    case "Failed":
      return "failed"
    case "Skipped":
      return "skipped"
    case "Expected Failure":
      return "expectedFailure"
    case "unknown":
      return "unknown"
    default:
      if (!outcome.unrecognizedStatuses.includes(result)) outcome.unrecognizedStatuses.push(result)
      return "unknown"
  }
}

/**
 * Identity comes from validated Xcode identifiers, cross-checked against
 * bundle/suite ancestry. Display names are never trusted on their own.
 */
function deriveIdentity(
  node: RawTestNode,
  ancestry: Ancestry,
): { identity: TestIdentity; complete: boolean } {
  const source = node.nodeIdentifierURL ?? node.nodeIdentifier
  const bundle = ancestry.bundle
  const parsed = source === undefined ? undefined : parseIdentifier(source)

  const suite = parsed?.suite ?? ancestry.suite
  const test = parsed?.test ?? node.name

  const complete =
    bundle !== undefined &&
    parsed !== undefined &&
    (ancestry.suite === undefined || parsed.suite === undefined || ancestry.suite === parsed.suite)

  const identity: TestIdentity = {
    bundle: bundle ?? "",
    ...(suite === undefined ? {} : { suite }),
    test,
    canonical: canonicalTestIdentity({
      bundle: bundle ?? "",
      ...(suite === undefined ? {} : { suite }),
      test,
    }),
  }

  const canonicalSource = source === undefined ? undefined : stripIdentifierScheme(source)
  if (canonicalSource !== undefined && canonicalSource !== identity.canonical) {
    identity.sourceIdentifier = canonicalSource
  }

  return { identity, complete }
}

function stripIdentifierScheme(identifier: string): string {
  const at = identifier.indexOf("://")
  return at === -1 ? identifier : identifier.slice(at + 3)
}

function parseIdentifier(identifier: string): { suite?: string; test?: string } | undefined {
  const parts = stripIdentifierScheme(identifier)
    .split("/")
    .filter((part) => part.length > 0)
  if (parts.length === 0) return undefined
  if (parts.length === 1) return { test: parts[0] }
  return { suite: parts[parts.length - 2], test: parts[parts.length - 1] }
}

function durationField(duration: string | undefined): { durationMs?: number } {
  if (duration === undefined) return {}
  const seconds = Number.parseFloat(duration)
  // A malformed duration degrades only this detail; it never touches a status.
  if (!Number.isFinite(seconds) || seconds < 0) return {}
  return { durationMs: Math.round(seconds * 1000) }
}

function locationField(node: RawTestNode, trustedRoot: string): { location?: SafeLocation } {
  const reference = node.children.find((child) => child.nodeType === SOURCE_REFERENCE_NODE_TYPE)
  const url = reference?.nodeIdentifierURL ?? reference?.nodeIdentifier ?? reference?.name
  const location = safeLocationFromSourceURL(url, trustedRoot)
  return location === undefined ? {} : { location }
}
