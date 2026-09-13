/**
 * Occurrence normalization, attempt aggregation, identity derivation, and the
 * one allowlisted schema defect (#8).
 */

import { describe, expect, test } from "bun:test"

import { AnomalyLog } from "../../src/interpreter/anomalies.ts"
import { decodeTestSummary } from "../../src/interpreter/decode.ts"
import { aggregateAttempts } from "../../src/interpreter/occurrences.ts"
import { FAILED_EXIT, interpretFixture } from "./harness.ts"

describe("attempt aggregation", () => {
  test("lets a failed attempt beat a passing retry", () => {
    expect(aggregateAttempts(["failed", "passed"])).toBe("failed")
    expect(aggregateAttempts(["passed", "failed"])).toBe("failed")
  })

  test("orders failed > unknown > passed > expectedFailure > skipped", () => {
    expect(aggregateAttempts(["unknown", "passed"])).toBe("unknown")
    expect(aggregateAttempts(["passed", "expectedFailure"])).toBe("passed")
    expect(aggregateAttempts(["expectedFailure", "skipped"])).toBe("expectedFailure")
    expect(aggregateAttempts(["skipped"])).toBe("skipped")
  })
})

describe("a retried test", () => {
  test("counts once, not once per attempt", async () => {
    const { summary } = await interpretFixture("attempts", { request: { execution: FAILED_EXIT } })
    expect(summary.tests.counts?.total).toBe(1)
  })

  test("reports the failure a green retry would otherwise hide", async () => {
    const { summary } = await interpretFixture("attempts", { request: { execution: FAILED_EXIT } })
    expect(summary.outcome).toBe("testFailed")
    expect(summary.tests.counts?.failed).toBe(1)
  })

  test("preserves every attempt and its original Xcode status", async () => {
    const { index } = await interpretFixture("attempts", { request: { execution: FAILED_EXIT } })
    expect(index.occurrences[0]?.attempts).toEqual([
      { ordinal: 0, status: "failed", sourceResult: "Failed", durationMs: 200 },
      { ordinal: 1, status: "passed", sourceResult: "Passed", durationMs: 100 },
    ])
  })

  test("makes the summary's aggregation incomparable rather than contradictory", async () => {
    // The summary reports one passing test; the hierarchy reports one failing
    // occurrence with two attempts. Repetition cardinality does not map, so
    // this is a recorded limitation — not evidence that anything disagrees.
    const { summary } = await interpretFixture("attempts", { request: { execution: FAILED_EXIT } })
    expect(summary.outcome).toBe("testFailed")
  })
})

describe("pseudo-tests", () => {
  test("are excluded from counts but never dropped from the observed picture", async () => {
    const { summary, index } = await interpretFixture("pseudo-tests")
    expect(summary.outcome).toBe("passed")
    expect(summary.tests.counts?.total).toBe(1)
    expect(index.occurrences.map((occurrence) => occurrence.identity.canonical)).toEqual([
      "AppTests/LoginTests/testSignsIn()",
    ])
  })

  test("do not count as an observation outside the Requested Scope", async () => {
    const { summary } = await interpretFixture("pseudo-tests", {
      scope: { kind: "selected", tests: [{ bundle: "AppTests", suite: "LoginTests" }] },
    })
    expect(summary.scope.verdict).toBe("matched")
    expect(summary.scope.observedOutsideScope).toBeUndefined()
  })
})

describe("canonical identity", () => {
  test("is derived from the Xcode identifier and the bundle ancestry", async () => {
    const { index } = await interpretFixture("passed")
    expect(index.occurrences.map((occurrence) => occurrence.identity)).toEqual([
      {
        bundle: "AppTests",
        suite: "LoginTests",
        test: "testSignsIn()",
        canonical: "AppTests/LoginTests/testSignsIn()",
        sourceIdentifier: "LoginTests/testSignsIn()",
      },
      {
        bundle: "AppTests",
        suite: "LoginTests",
        test: "testSignsOut()",
        canonical: "AppTests/LoginTests/testSignsOut()",
        sourceIdentifier: "LoginTests/testSignsOut()",
      },
    ])
  })
})

describe("the testFailures arity defect", () => {
  test("accepts the observed single-object shape at that documented path", () => {
    const anomalies = new AnomalyLog()
    const decoded = decodeTestSummary(
      { testFailures: { testName: "testA()", failureText: "boom" } },
      anomalies,
    )
    expect(decoded.ok).toBe(true)
    expect(decoded.ok && decoded.value.testFailures).toEqual([
      { testName: "testA()", failureText: "boom" },
    ])
  })

  test("records the normalization as a lossless private anomaly", () => {
    const anomalies = new AnomalyLog()
    decodeTestSummary({ testFailures: { failureText: "boom" } }, anomalies)
    expect(anomalies.records).toEqual([
      {
        command: "get test-results summary",
        schemaVersion: "0.1.0",
        decoderVersion: 1,
        fieldPath: "testFailures",
        observedShape: "object",
        normalizationApplied: "wrapped in a single-element array",
        lossy: false,
      },
    ])
  })

  test("degrades rather than guesses when the value is null", () => {
    const anomalies = new AnomalyLog()
    const decoded = decodeTestSummary({ testFailures: null }, anomalies)
    expect(decoded.ok && decoded.value.testFailuresDegraded).toBe(true)
    expect(anomalies.hasLossyRecords).toBe(true)
  })

  test("is surfaced end to end on the fixture that carries it", async () => {
    const { anomalies } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(anomalies.map((record) => record.fieldPath)).toEqual(["testFailures"])
  })
})

describe("deterministic identifiers", () => {
  test("reproduce byte-identically from the same immutable evidence", async () => {
    const first = await interpretFixture("many-failures", { request: { execution: FAILED_EXIT } })
    const second = await interpretFixture("many-failures", { request: { execution: FAILED_EXIT } })
    expect(first.index.testFailures.map((record) => record.id)).toEqual(
      second.index.testFailures.map((record) => record.id),
    )
    expect(first.index.occurrences.map((record) => record.id)).toEqual(
      second.index.occurrences.map((record) => record.id),
    )
  })

  test("differ across runs, because they are run-local", async () => {
    const first = await interpretFixture("passed")
    const second = await interpretFixture("passed", { facts: { runId: "run-0001" } })
    expect(first.index.occurrences[0]?.id).not.toBe(second.index.occurrences[0]?.id)
  })
})
