/**
 * The Requested Scope, its normalization, its digest, and the attestation that
 * proves a Test Run actually executed what the caller selected (#6, #7).
 *
 * Scope attestation is what makes a `passed` outcome trustworthy: without it, a
 * run that matched nothing would be indistinguishable from a run that passed.
 */

import { createHash } from "node:crypto"

/** A single exact selection. Patterns and exclusions are unsupported. */
export type TestSelection = {
  bundle: string
  suite?: string
  test?: string
}

/** What the caller intends a Test Run to execute. Selections union together. */
export type RequestedScope = { kind: "all" } | { kind: "selected"; tests: TestSelection[] }

/** The verdict for one selection, or for the scope as a whole. */
export type ScopeVerdict = "matched" | "mismatched" | "unverifiable" | "notReached"

export const SCOPE_VERDICTS = [
  "matched",
  "mismatched",
  "unverifiable",
  "notReached",
] as const

/** What a single selection turned out to match. */
export type ScopeAttestation = {
  selection: TestSelection
  verdict: ScopeVerdict
  /** Observed tests attributed to this selection; a lower bound when unverifiable. */
  matchedTestCount?: number
}

/**
 * The compact scope evidence carried by a Test Run summary. The complete set of
 * attestations is reachable through the `scope` inspection facet.
 */
export type ScopeEvidence = {
  kind: RequestedScope["kind"]
  /** Deterministic digest of the normalized scope; a correlation aid, not a proof. */
  digest: string
  /** Selections requested. Zero for `all`. */
  requestedSelectionCount: number
  /** Computed over every selection, not only the ones shown. */
  verdict: ScopeVerdict
  attestations: ScopeAttestation[]
  shown: number
  truncated: boolean
  /** Observed tests outside the selected scope force a `mismatched` verdict. */
  observedOutsideScope?: number
}

/**
 * Deduplicate and order selections so that two scopes meaning the same thing
 * serialize identically. Absent fields stay absent — they are not filled in.
 */
export function normalizeRequestedScope(scope: RequestedScope): RequestedScope {
  if (scope.kind === "all") return { kind: "all" }

  const seen = new Map<string, TestSelection>()
  for (const selection of scope.tests) {
    const key = selectionKey(selection)
    if (!seen.has(key)) seen.set(key, selection)
  }

  const tests = [...seen.values()].sort((a, b) => compareSelections(a, b))
  return { kind: "selected", tests }
}

/** Lexicographic by bundle, then suite, then test; absent sorts before present. */
export function compareSelections(a: TestSelection, b: TestSelection): number {
  return (
    compareOptional(a.bundle, b.bundle) ||
    compareOptional(a.suite, b.suite) ||
    compareOptional(a.test, b.test)
  )
}

function compareOptional(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  return a < b ? -1 : 1
}

function selectionKey(selection: TestSelection): string {
  return JSON.stringify([selection.bundle, selection.suite ?? null, selection.test ?? null])
}

/**
 * Lowercase hexadecimal SHA-256 over the canonical JSON form of the normalized
 * scope, covering `kind`. Every scope has one, including `{ kind: "all" }`.
 */
export function requestedScopeDigest(scope: RequestedScope): string {
  const canonical = canonicalScopeJson(normalizeRequestedScope(scope))
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/**
 * Fixed key order and fixed whitespace, so the digest depends on the scope and
 * nothing else. Absent optional fields are omitted rather than serialized null.
 */
export function canonicalScopeJson(scope: RequestedScope): string {
  if (scope.kind === "all") return '{"kind":"all"}'

  const tests = scope.tests.map((selection) => {
    const parts = [`"bundle":${JSON.stringify(selection.bundle)}`]
    if (selection.suite !== undefined) parts.push(`"suite":${JSON.stringify(selection.suite)}`)
    if (selection.test !== undefined) parts.push(`"test":${JSON.stringify(selection.test)}`)
    return `{${parts.join(",")}}`
  })

  return `{"kind":"selected","tests":[${tests.join(",")}]}`
}

/** The `Bundle/Suite/test` identity a normalized observed test is reported under. */
export type TestIdentity = {
  bundle: string
  suite?: string
  test?: string
  /** The serialized `Bundle/Suite/test` form. */
  canonical: string
  /** Retained only when the Result Bundle's own identifier differs. */
  sourceIdentifier?: string
}

/** Serialize identity components into the canonical `Bundle/Suite/test` form. */
export function canonicalTestIdentity(parts: {
  bundle: string
  suite?: string
  test?: string
}): string {
  return [parts.bundle, parts.suite, parts.test].filter((part) => part !== undefined).join("/")
}
