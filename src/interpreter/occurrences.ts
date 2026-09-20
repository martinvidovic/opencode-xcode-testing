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
import { isIdentifier } from "../domain/json.ts"
import { canonicalTestIdentity, type TestIdentity } from "../domain/scope.ts"
import type { RawTestNode } from "./decode.ts"
import { safeDisplayPath, safeLocationFromSourceURL } from "./locations.ts"

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
  /**
   * Test Cases dropped because nothing above them carried a usable bundle
   * name.
   *
   * Distinct from `pseudoTestCount`, and the distinction is the point. A plan
   * or launch node is not a test and was never going to be counted. This is a
   * real Test Case that cannot be named, so dropping it makes the reported
   * count *short* — and a count that is silently short is the failure this
   * whole tool exists to prevent. The caller degrades the facet instead.
   */
  unnameableCount: number
  /** A `Test Case` carrying a recognized shape but no usable status. */
  missingStatusCount: number
  /** A status literal the decoder does not recognize: an incompatible schema. */
  unrecognizedStatuses: string[]
}

/**
 * Walk the node hierarchy once, in source order, collecting occurrences.
 *
 * A `Test Case` with no test-bundle ancestor **at all** is plan or launch
 * infrastructure — user-authored tests always live inside a bundle — so it is
 * confidently classified as a pseudo-test, excluded from counts, and never
 * treated as an out-of-scope observation.
 *
 * A `Test Case` beneath a bundle node whose *name* is blank is a different
 * thing entirely: a real test that cannot be identified. It is not published,
 * because an identity of `""` reaches a model as a name that matches nothing
 * and looks like it should — but neither is it quietly discarded. It is
 * counted in `unnameableCount`, which degrades the tests facet to `partial`
 * and makes scope verdicts `unverifiable`, so the count is stated as the lower
 * bound it is and no selection is told it matched nothing.
 *
 * Everything else the decoder cannot confidently classify is counted as a
 * normal occurrence: miscounting beats silently dropping a test.
 */
export function normalizeTestNodes(
  nodes: RawTestNode[],
  options: { containmentRoot: string; configurationId?: string; deviceId?: string },
): NormalizationOutcome {
  const outcome: NormalizationOutcome = {
    occurrences: [],
    pseudoTestCount: 0,
    unnameableCount: 0,
    missingStatusCount: 0,
    unrecognizedStatuses: [],
  }

  const walk = (node: RawTestNode, ancestry: Ancestry, path: string) => {
    if (node.nodeType === "Test Case") {
      const { bundle } = ancestry
      if (bundle === undefined) {
        // No bundle above it at all: plan and launch infrastructure, which is
        // not a test and is not counted as one.
        if (!ancestry.sawBundleNode) {
          outcome.pseudoTestCount += 1
          return
        }
        // There *was* a bundle node and it had no usable name. This is a real
        // test that cannot be identified, and losing it quietly would make the
        // count short.
        outcome.unnameableCount += 1
        return
      }
      collectOccurrence(node, { ...ancestry, bundle }, path, options, outcome)
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

type Ancestry = {
  bundle?: string
  suite?: string
  /**
   * A bundle node was passed, whether or not it had a usable name.
   *
   * What separates a test whose bundle could not be named from a node that
   * was never a test: the first is evidence lost and has to be reported, the
   * second is plan and launch infrastructure and never counted.
   */
  sawBundleNode?: true
}

function extendAncestry(node: RawTestNode, ancestry: Ancestry): Ancestry {
  // A blank name is no name. Recording one would give every test beneath this
  // node an identity that calls itself nothing — which the decoder refuses,
  // taking the whole index with it, and which a model could not act on if it
  // did not. Left undefined, these are counted as the infrastructure nodes
  // they are indistinguishable from.
  if (TEST_BUNDLE_NODE_TYPES.has(node.nodeType)) {
    // `sawBundleNode` either way, so a test beneath an unnamed bundle is
    // distinguishable from one with no bundle node above it at all. The first
    // is evidence lost; the second was never a test.
    return isIdentifier(node.name) ? { bundle: node.name, sawBundleNode: true } : { sawBundleNode: true }
  }
  if (node.nodeType === "Test Suite") {
    return isIdentifier(node.name) ? { ...ancestry, suite: node.name } : ancestry
  }
  return ancestry
}

function collectOccurrence(
  node: RawTestNode,
  // Narrowed by the caller: a Test Case with no bundle above it never reaches
  // here, so every occurrence published can name the bundle it came from.
  ancestry: Ancestry & { bundle: string },
  path: string,
  options: { containmentRoot: string; configurationId?: string; deviceId?: string },
  outcome: NormalizationOutcome,
): void {
  const attempts: NormalizedAttempt[] = []
  const failures: NormalizedFailure[] = []

  collectDescendants(node, path, options.containmentRoot, attempts, failures, outcome)

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
    ...durationField(node),
    attempts,
    failures,
    position: path,
    // A node that names its own context is authoritative for that occurrence;
    // the declared single configuration is only a fallback.
    ...contextField("configurationId", node.configurationId ?? options.configurationId),
    ...contextField("deviceId", node.deviceId ?? options.deviceId),
  })
}

function collectDescendants(
  node: RawTestNode,
  path: string,
  containmentRoot: string,
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
        ...durationField(child),
      })
    }

    if (child.nodeType === FAILURE_NODE_TYPE) {
      failures.push({ ...decodeFailureMessage(child, containmentRoot), position: childPath })
    }

    collectDescendants(child, childPath, containmentRoot, attempts, failures, outcome)
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
 *
 * The *components* are taken from `nodeIdentifier`, because that is the
 * `-only-testing` spelling — observed as `CalculatorTests/testAdds()`. The
 * `nodeIdentifierURL` (`test://com.apple.xcode/App/AppTests/CalculatorTests/testAdds`)
 * is a stable global reference but drops the argument parentheses, so an
 * identity built from it could not be compared against a caller's selection,
 * and scope attestation would report a mismatch for a test that genuinely ran.
 * The URL is used to cross-check the ancestry and is retained as the source
 * identifier when it differs.
 */
function deriveIdentity(
  node: RawTestNode,
  ancestry: Ancestry & { bundle: string },
): { identity: TestIdentity; complete: boolean } {
  const selectable = node.nodeIdentifier === undefined ? undefined : parseIdentifier(node.nodeIdentifier)
  const reference = node.nodeIdentifierURL === undefined ? undefined : parseIdentifier(node.nodeIdentifierURL)

  const suite = selectable?.suite ?? reference?.suite ?? ancestry.suite
  const test = selectable?.test ?? reference?.test ?? node.name

  const parsedSuite = selectable?.suite ?? reference?.suite

  // Two identifiers that disagree are not one identity. Attesting a scope on
  // evidence that contradicts itself is exactly the false match the
  // attestation exists to prevent.
  const identifiersAgree =
    selectable?.suite === undefined ||
    reference?.suite === undefined ||
    selectable.suite === reference.suite

  // The bundle is no longer part of this question: `normalizeTestNodes` will
  // not reach here without one, because an occurrence that cannot name itself
  // is not published at all. What is left is whether the components agree.
  const complete =
    (selectable !== undefined || reference !== undefined) &&
    identifiersAgree &&
    (ancestry.suite === undefined || parsedSuite === undefined || ancestry.suite === parsedSuite)

  // Empty is absent. A component that came through as `""` is one Xcode did
  // not give us, and writing it as a present-but-blank field would put a name
  // in front of a reader that matches nothing and looks like it should.
  const parts = {
    bundle: ancestry.bundle,
    ...(isIdentifier(suite) ? { suite } : {}),
    ...(isIdentifier(test) ? { test } : {}),
  }
  const identity: TestIdentity = { ...parts, canonical: canonicalTestIdentity(parts) }

  const source = node.nodeIdentifierURL ?? node.nodeIdentifier
  const canonicalSource = source === undefined ? undefined : stripIdentifierScheme(source)
  if (isIdentifier(canonicalSource) && canonicalSource !== identity.canonical) {
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
  const test = parts[parts.length - 1]
  if (test === undefined) return undefined
  if (parts.length === 1) return { test }

  // Present or absent, never present-and-undefined. The difference is not
  // cosmetic here: these land in a record that is written to disk and read
  // back, and a key holding `undefined` serializes to a key that is missing —
  // so a shape with one is a shape no round trip can produce.
  const suite = parts[parts.length - 2]
  return suite === undefined ? { test } : { suite, test }
}

/** Carry an occurrence's configuration or device only when one is known. */
function contextField<K extends "configurationId" | "deviceId">(
  key: K,
  value: string | undefined,
): { [P in K]?: string } | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string })
}

/**
 * Prefer `durationInSeconds`. The sibling `duration` string is formatted for
 * display in the user's locale — `"0,0019s"` on a comma-decimal machine — so
 * parsing it would silently produce zero for some people and not others.
 */
function durationField(node: { duration?: string; durationInSeconds?: number }): {
  durationMs?: number
} {
  const seconds =
    node.durationInSeconds ?? (node.duration === undefined ? undefined : parseDuration(node.duration))
  // A malformed duration degrades only this detail; it never touches a status.
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return {}
  return { durationMs: Math.round(seconds * 1000) }
}

function parseDuration(duration: string): number | undefined {
  const parsed = Number.parseFloat(duration.replace(",", "."))
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A leading `<file>:<line>: ` that XCTest prefixes onto a failure message.
 *
 * Observed at schema 0.1.0, a `Failure Message` node has **no**
 * `Source Code Reference` child — the location is in the message text, and
 * nowhere else. Leaving it there would mean every real failure rendered with no
 * location at all, and would also leave the prefix in the message, where it
 * defeats deduplication against the summary's copy (which carries no prefix).
 */
const MESSAGE_LOCATION = /^([^\s:]+):(\d+)(?::(\d+))?:\s+/

export function decodeFailureMessage(
  node: RawTestNode,
  containmentRoot: string,
): { message: string; location?: SafeLocation } {
  // An explicit reference node wins where one exists; the text is the fallback
  // that real payloads actually take.
  const explicit = locationField(node, containmentRoot)
  const match = MESSAGE_LOCATION.exec(node.name)

  if (match === null) return { message: node.name, ...explicit }

  const line = Number.parseInt(match[2] ?? "", 10)
  const column = match[3] === undefined ? undefined : Number.parseInt(match[3], 10)
  const message = node.name.slice(match[0].length)

  if (explicit.location !== undefined) return { message, location: explicit.location }

  return {
    message,
    location: {
      path: safeDisplayPath(match[1] ?? "", containmentRoot),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(column !== undefined && Number.isInteger(column) && column > 0 ? { column } : {}),
    },
  }
}

function locationField(node: RawTestNode, containmentRoot: string): { location?: SafeLocation } {
  const reference = node.children.find((child) => child.nodeType === SOURCE_REFERENCE_NODE_TYPE)
  const url = reference?.nodeIdentifierURL ?? reference?.nodeIdentifier ?? reference?.name
  const location = safeLocationFromSourceURL(url, containmentRoot)
  return location === undefined ? {} : { location }
}
