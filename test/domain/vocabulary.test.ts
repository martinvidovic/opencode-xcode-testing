/**
 * The outcome and reason vocabularies are closed sets. These tests pin the
 * membership so that widening one is a visible, deliberate diff — the adapter's
 * renderer and the interpreter's classification both key off them.
 */

import { describe, expect, test } from "bun:test"

import { countsAreConsistent, EVIDENCE_FACTS, TEST_STATUSES } from "../../src/domain/evidence.ts"
import {
  INFRASTRUCTURE_REASONS,
  QUEUED_FAILURE_REASONS,
  RESOLUTION_FAILURE_REASONS,
  TEST_RUN_OUTCOMES,
  TEST_TOOL_OUTCOMES,
} from "../../src/domain/outcome.ts"
import { INSPECTION_FACETS } from "../../src/domain/inspection.ts"
import { SCOPE_VERDICTS } from "../../src/domain/scope.ts"

describe("the closed vocabularies", () => {
  test("name the six Test Run outcomes", () => {
    expect([...TEST_RUN_OUTCOMES]).toEqual([
      "passed",
      "testFailed",
      "buildFailed",
      "infrastructureFailed",
      "cancelled",
      "timedOut",
    ])
  })

  test("add `invalid` only at the Test Tool boundary, where no run exists", () => {
    expect(TEST_TOOL_OUTCOMES).toContain("invalid")
    expect(TEST_RUN_OUTCOMES).not.toContain("invalid" as never)
  })

  test("name the thirteen v1 infrastructure reasons", () => {
    expect([...INFRASTRUCTURE_REASONS]).toEqual([
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
      "adapterFailure",
    ])
  })

  test("keep resolution and queued failure reasons distinct from run reasons", () => {
    const runReasons = new Set<string>(INFRASTRUCTURE_REASONS)
    for (const reason of [...RESOLUTION_FAILURE_REASONS, ...QUEUED_FAILURE_REASONS]) {
      expect(runReasons.has(reason)).toBe(false)
    }
  })

  test("name the five inspection facets and the four scope verdicts", () => {
    expect([...INSPECTION_FACETS]).toEqual(["scope", "failures", "buildErrors", "tests", "log"])
    expect([...SCOPE_VERDICTS]).toEqual([
      "matched",
      "mismatched",
      "unverifiable",
      "notReached",
    ])
  })

  test("treat `unknown` as a fact rather than an absent `no`", () => {
    expect([...EVIDENCE_FACTS]).toEqual(["yes", "no", "unknown"])
    expect(TEST_STATUSES).toContain("unknown")
  })

  test("contain no duplicates", () => {
    for (const vocabulary of [
      TEST_RUN_OUTCOMES,
      TEST_TOOL_OUTCOMES,
      INFRASTRUCTURE_REASONS,
      RESOLUTION_FAILURE_REASONS,
      QUEUED_FAILURE_REASONS,
      INSPECTION_FACETS,
      SCOPE_VERDICTS,
      TEST_STATUSES,
    ]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length)
    }
  })
})

describe("test counts", () => {
  test("hold when every category sums to the total", () => {
    expect(
      countsAreConsistent({
        total: 6,
        passed: 3,
        failed: 1,
        skipped: 1,
        expectedFailure: 1,
        unknown: 0,
      }),
    ).toBe(true)
  })

  test("fail when a category is unaccounted for", () => {
    expect(
      countsAreConsistent({
        total: 6,
        passed: 3,
        failed: 1,
        skipped: 1,
        expectedFailure: 0,
        unknown: 0,
      }),
    ).toBe(false)
  })
})
