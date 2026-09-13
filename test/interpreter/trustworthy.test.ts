/**
 * Evidence-authority and scale properties of interpretation (#8, issue #23).
 *
 * These cover the ways classification can go wrong without anything looking
 * broken: a genuine build failure reported as an infrastructure problem, a
 * deadline that expires unnoticed after the last read, a large bundle silently
 * truncated, and occurrences whose configuration context has been flattened
 * away so scope attestation cannot tell two contexts apart.
 */

import { describe, expect, test } from "bun:test"

import { argumentsFor } from "../../src/interpreter/xcresulttool.ts"
import { FAILED_EXIT, identityFor, interpretFixture, loadFixture } from "./harness.ts"

describe("a trustworthy build failure", () => {
  test("stays buildFailed when unrelated test evidence is only partial", async () => {
    // #8: complete trustworthy build errors still yield `buildFailed` when test
    // evidence is unavailable, incomplete, or unsupported. Reporting an
    // infrastructure problem instead hides a build the caller has to fix.
    const { summary } = await interpretFixture("build-failed-partial-tests", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.outcome).toBe("buildFailed")
    expect(summary.build).toEqual({ completeness: "complete", errorCount: 1 })
    expect(summary.tests.completeness).toBe("partial")
  })

  test("still reports the build errors themselves", async () => {
    const { summary } = await interpretFixture("build-failed-partial-tests", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.buildErrors).toHaveLength(1)
  })
})

describe("an evidence defect that is relevant", () => {
  test("still wins when there is no trustworthy build failure to report", async () => {
    const { summary } = await interpretFixture("missing-status", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "resultBundleIncomplete",
    })
  })

  test("and a genuine contradiction outranks a build failure", async () => {
    // A successful exit alongside reported failures is contradictory evidence,
    // whatever else the bundle says.
    const { summary } = await interpretFixture("build-failed-partial-tests")
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "contradictoryEvidence",
    })
  })
})

describe("the eager deadline", () => {
  test("expires after the last structured read, not only before it", async () => {
    // A deadline checked only before each call lets the final read overrun and
    // still be classified as a pass.
    const clock = advancingOnDemand()
    const { summary } = await interpretFixture("passed", {
      request: { clock, deadlineMs: 400 },
      reader: {
        onRun: (command) => {
          // Everything is inside budget until the very last read.
          clock.advance(command === "get test-results summary" ? 500 : 50)
        },
      },
    })

    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "interpretationTimedOut",
    })
  })

  test("never turns an overrun into a pass", async () => {
    const clock = advancingOnDemand()
    const { summary } = await interpretFixture("passed", {
      request: { clock, deadlineMs: 400 },
      reader: { onRun: () => clock.advance(120) },
    })
    expect(summary.outcome).not.toBe("passed")
  })
})

describe("the pinned schema version", () => {
  test("is requested on every classification-critical command", () => {
    // A command that accepts the tool default is a command whose shape can
    // change under us between Xcode releases.
    for (const command of [
      "get content-availability",
      "get build-results",
      "get test-results tests",
      "get test-results summary",
    ] as const) {
      expect(argumentsFor(command, "/run/result.xcresult")).toContain("--schema-version")
      expect(argumentsFor(command, "/run/result.xcresult")).toContain("0.1.0")
    }
  })

  test("is not requested of the readability preflight, which decodes nothing", () => {
    expect(argumentsFor("metadata get", "/run/result.xcresult")).not.toContain("--schema-version")
  })
})

describe("occurrence context", () => {
  test("is retained per occurrence, not flattened to the first configuration", async () => {
    // Two configurations running the same test are two occurrences. Collapsing
    // them onto one context loses the only thing that tells them apart.
    const { index } = await interpretFixture("multi-context", {
      request: { execution: FAILED_EXIT },
    })

    expect(index.occurrences).toHaveLength(2)
    const contexts = index.occurrences.map((occurrence) => occurrence.configurationId).sort()
    expect(contexts).toEqual(["C1", "C2"])
  })

  test("gives each context its own occurrence id", async () => {
    const { index } = await interpretFixture("multi-context", {
      request: { execution: FAILED_EXIT },
    })
    const ids = new Set(index.occurrences.map((occurrence) => occurrence.id))
    expect(ids.size).toBe(2)
  })

  test("counts both occurrences of one canonical identity", async () => {
    const { summary } = await interpretFixture("multi-context", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.tests.counts?.total).toBe(2)
    const identities = new Set(
      summary.diagnostics.observedTests.map((identity) => identity.canonical),
    )
    expect(identities.size).toBe(1)
  })
})

function advancingOnDemand() {
  let now = 0
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

describe("a build failure alongside unsupported test evidence", () => {
  test("is still buildFailed", async () => {
    // #8 names all three: test evidence that is unavailable, incomplete, *or
    // unsupported* does not suppress a build the caller has to fix.
    const { summary } = await interpretFixture("build-failed-unsupported-tests", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.outcome).toBe("buildFailed")
  })

  test("but an unsupported *bundle* still outranks it", async () => {
    // The same reason, about different evidence: a toolchain that no longer
    // matches means nothing in the bundle can be believed.
    const fixture = loadFixture("build-failed-partial-tests")
    const replaced = { ...identityFor(fixture), xcresulttoolDigest: "b".repeat(64) }

    const { summary } = await interpretFixture("build-failed-partial-tests", {
      request: { execution: FAILED_EXIT },
      reader: { identity: replaced },
    })
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "unsupportedResultSchema",
    })
  })
})

describe("contradictory identifiers", () => {
  test("cannot attest a scope as matched", async () => {
    // Two identifiers that disagree are not one identity, and a scope attested
    // on self-contradicting evidence is the false match attestation exists to
    // prevent.
    const { summary } = await interpretFixture("conflicting-identity", {
      scope: {
        kind: "selected",
        tests: [{ bundle: "AppTests", suite: "LoginTests", test: "testSignsIn()" }],
      },
    })
    expect(summary.scope.verdict).not.toBe("matched")
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "scopeUnverifiable",
    })
  })
})
