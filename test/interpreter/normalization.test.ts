/**
 * Occurrence normalization, attempt aggregation, identity derivation, and the
 * one allowlisted schema defect (#8).
 */

import { describe, expect, test } from "bun:test"

import { AnomalyLog } from "../../src/interpreter/anomalies.ts"
import { decodeTestSummary } from "../../src/interpreter/decode.ts"
import { aggregateAttempts, normalizeTestNodes } from "../../src/interpreter/occurrences.ts"
import { attestScope } from "../../src/interpreter/attestation.ts"
import { FAILED_EXIT, interpretFixture, loadFixture } from "./harness.ts"

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
        sourceIdentifier: "com.apple.xcode/App/AppTests/LoginTests/testSignsIn",
      },
      {
        bundle: "AppTests",
        suite: "LoginTests",
        test: "testSignsOut()",
        canonical: "AppTests/LoginTests/testSignsOut()",
        sourceIdentifier: "com.apple.xcode/App/AppTests/LoginTests/testSignsOut",
      },
    ])
  })

  test("keeps the selectable spelling, not the reference URL's", async () => {
    // `nodeIdentifierURL` drops the argument parentheses. An identity built
    // from it could never be compared against a caller's `-only-testing`
    // selection, so a test that genuinely ran would attest as a mismatch.
    const { summary } = await interpretFixture("passed", {
      scope: {
        kind: "selected",
        tests: [{ bundle: "AppTests", suite: "LoginTests", test: "testSignsIn()" }],
      },
    })
    expect(summary.scope.attestations[0]).toMatchObject({ verdict: "matched", matchedTestCount: 1 })
  })

  test("retains the reference URL as the source identifier", async () => {
    const { index } = await interpretFixture("passed")
    expect(index.occurrences[0]?.identity.sourceIdentifier).toContain("com.apple.xcode")
  })
})

describe("durations", () => {
  test("come from the numeric field, not the locale-formatted display string", async () => {
    // The sibling `duration` reads "0,12s" on a comma-decimal machine, which
    // would parse to zero for some people and not others.
    const { index } = await interpretFixture("passed")
    expect(index.occurrences[0]?.durationMs).toBe(120)
  })

  test("fall back to the display string, tolerating either decimal separator", async () => {
    const { index } = await interpretFixture("attempts", { request: { execution: FAILED_EXIT } })
    expect(index.occurrences[0]?.attempts.map((attempt) => attempt.durationMs)).toEqual([200, 100])
  })
})

describe("content availability", () => {
  test("is decoded from the shape xcresulttool actually emits", async () => {
    // Observed at schema 0.1.0: no `hasBuildResults`, and `logs` is an array of
    // log names rather than a boolean.
    const { summary } = await interpretFixture("passed")
    expect(summary.outcome).toBe("passed")
  })

  test("makes build results always attemptable, since it claims nothing about them", async () => {
    const commands: string[] = []
    await interpretFixture("passed", { reader: { onRun: (command) => commands.push(command) } })
    expect(commands).toContain("get build-results")
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

describe("a failure message from a real Result Bundle", () => {
  test("carries its location in the text, and the decoder extracts it", async () => {
    // Observed at schema 0.1.0: there is no `Source Code Reference` child, so a
    // decoder that only looked for one would render every real failure with no
    // location at all.
    const { summary } = await interpretFixture("observed-failure-shape", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.testFailures[0]?.location).toEqual({
      path: "FailingTests.swift",
      line: 8,
    })
  })

  test("has the location prefix stripped out of the message", async () => {
    const { summary } = await interpretFixture("observed-failure-shape", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.testFailures[0]?.message).toBe(
      'XCTAssertEqual failed: ("4") is not equal to ("5") - deliberate fixture failure',
    )
  })

  test("is not doubled by the summary's copy of the same failure", async () => {
    // The summary reports the same failure without the location prefix. Once
    // the prefix is extracted the two are identical, so dedup can see it — and
    // a caller is told one test failed once, not twice.
    const { summary } = await interpretFixture("observed-failure-shape", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.testFailureSection).toEqual({
      total: 1,
      shown: 1,
      truncated: false,
    })
  })

  test("still classifies the run as testFailed", async () => {
    const { summary } = await interpretFixture("observed-failure-shape", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.outcome).toBe("testFailed")
  })
})

describe("a bundle node Xcode gave no name", () => {
  test("produces no occurrence at all, rather than one that cannot name itself", () => {
    // The producer and the decoder have to agree, and this is where they can
    // stop agreeing: a blank bundle name yielded an identity naming nothing,
    // which the decoder refuses — taking the whole index, and so every facet
    // of a real run, down with it.
    //
    // Not published rather than published incomplete. A test whose bundle
    // cannot be named is indistinguishable from the plan and launch nodes
    // already counted as infrastructure, and an occurrence with nothing to
    // call itself is not a less confident occurrence; it is not one.
    const { occurrences } = normalizeTestNodes(
      [
        {
          nodeType: "Unit test bundle",
          name: "",
          children: [
            {
              nodeType: "Test Case",
              name: "testSignsIn()",
              nodeIdentifier: "LoginTests/testSignsIn()",
              result: "Passed",
              children: [],
            },
          ],
        },
      ],
      { containmentRoot: "/repo" },
    )

    expect(occurrences).toEqual([])
  })

  test("still produces a complete identity when the bundle is named", () => {
    const { occurrences } = normalizeTestNodes(
      [
        {
          nodeType: "Unit test bundle",
          name: "AppTests",
          children: [
            {
              nodeType: "Test Case",
              name: "testSignsIn()",
              nodeIdentifier: "LoginTests/testSignsIn()",
              result: "Passed",
              children: [],
            },
          ],
        },
      ],
      { containmentRoot: "/repo" },
    )

    expect(occurrences[0]?.identityComplete).toBe(true)
    expect(occurrences[0]?.identity.canonical).toBe("AppTests/LoginTests/testSignsIn()")
  })
})

describe("a test that ran and cannot be named", () => {
  function underBlankBundle() {
    return normalizeTestNodes(
      [
        {
          nodeType: "Unit test bundle",
          name: "",
          children: [
            {
              nodeType: "Test Case",
              name: "testSignsIn()",
              nodeIdentifier: "LoginTests/testSignsIn()",
              result: "Passed",
              children: [],
            },
          ],
        },
      ],
      { containmentRoot: "/repo" },
    )
  }

  test("is counted as a loss, not as infrastructure", () => {
    // The distinction that keeps the drop honest. A plan or launch node was
    // never a test and is not counted as one; this is a real test, so losing
    // it makes the reported count short — and a count that is silently short
    // is the failure this whole tool exists to prevent.
    const outcome = underBlankBundle()

    expect(outcome.occurrences).toEqual([])
    expect(outcome.unnameableCount).toBe(1)
    expect(outcome.pseudoTestCount).toBe(0)
  })

  test("is still infrastructure when there was no bundle node at all", () => {
    // The other side of the same distinction, unchanged: a Test Case with
    // nothing above it is the plan or launch node it has always been.
    const outcome = normalizeTestNodes(
      [{ nodeType: "Test Case", name: "launch", result: "Passed", children: [] }],
      { containmentRoot: "/repo" },
    )

    expect(outcome.pseudoTestCount).toBe(1)
    expect(outcome.unnameableCount).toBe(0)
  })
})

describe("a scope attested over an incomplete set of tests", () => {
  const SELECTED = {
    kind: "selected" as const,
    tests: [{ bundle: "AppTests", suite: "LoginTests" }],
  }
  const OCCURRENCE = {
    id: "occ-1",
    identity: {
      bundle: "AppTests",
      suite: "OtherTests",
      test: "testOther()",
      canonical: "AppTests/OtherTests/testOther()",
    },
    identityComplete: true,
    status: "passed" as const,
    position: "0",
    attempts: [],
    failures: [],
  }

  test("is unverifiable, not mismatched, when a test was dropped for having no name", () => {
    // The selection covered a test that ran. Dropping that test because it
    // could not be identified leaves nothing matching the selection, and
    // reporting `mismatched` would tell the caller they asked for something
    // that did not run — about a test that did.
    const attestation = attestScope(SELECTED, [OCCURRENCE], {
      testingReached: true,
      unidentifiable: 1,
    })

    expect(attestation.verdict).toBe("unverifiable")
    expect(attestation.attestations[0]?.verdict).toBe("unverifiable")
  })

  test("is mismatched when every test that ran could be identified", () => {
    // The other direction, so the case above cannot pass by never matching:
    // with nothing lost, a selection that really matched nothing says so.
    const attestation = attestScope(SELECTED, [OCCURRENCE], { testingReached: true })

    expect(attestation.attestations[0]?.verdict).toBe("mismatched")
  })
})

describe("a run whose evidence includes a test that cannot be named", () => {
  test("reports its count as a lower bound rather than as complete", async () => {
    // End to end, because this is the claim a caller reads. Two tests ran and
    // one of them cannot be identified, so the tool can report one — and the
    // only honest way to report one out of two is to say the number is
    // partial. Reporting it as complete would be reporting a count that is
    // short, in a response whose whole purpose is being trustworthy about
    // exactly that.
    const fixture = loadFixture("passed")
    const withUnnameable = {
      ...(fixture.payloads["get test-results tests"] as Record<string, unknown>),
      testNodes: [
        {
          nodeType: "Test Plan",
          name: "App",
          children: [
            {
              nodeType: "Unit test bundle",
              name: "AppTests",
              children: [
                {
                  nodeType: "Test Case",
                  name: "testNamed()",
                  nodeIdentifier: "LoginTests/testNamed()",
                  result: "Passed",
                  children: [],
                },
              ],
            },
            {
              nodeType: "Unit test bundle",
              name: "",
              children: [
                {
                  nodeType: "Test Case",
                  name: "testUnnameable()",
                  nodeIdentifier: "OtherTests/testUnnameable()",
                  result: "Passed",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    }

    const interpreted = await interpretFixture("passed", {
      reader: {
        payloads: { "get test-results tests": withUnnameable },
      },
    })

    expect(interpreted.summary.tests.completeness).toBe("partial")
    expect(interpreted.summary.tests.counts?.total).toBe(1)
  })
})
