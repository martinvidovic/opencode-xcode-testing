/**
 * The infrastructure reason taxonomy (#8).
 *
 * Each reason below is reached through the path that is supposed to produce it,
 * because a taxonomy nobody can reach is documentation, not behavior.
 */

import { describe, expect, test } from "bun:test"

import { INFRASTRUCTURE_REASONS } from "../../src/domain/outcome.ts"
import { FAILED_EXIT, identityFor, interpretFixture, loadFixture } from "./harness.ts"

async function reasonOf(name: string, overrides = {}): Promise<string> {
  const { summary } = await interpretFixture(name, overrides)
  expect(summary.outcome).toBe("infrastructureFailed")
  return (summary as { reason: string }).reason
}

describe("the infrastructure reasons", () => {
  test("resultBundleMissing — the expected bundle does not exist", async () => {
    expect(await reasonOf("passed", { facts: { resultBundlePresent: false } })).toBe(
      "resultBundleMissing",
    )
  })

  test("resultBundleUnreadable — the bundle exists but cannot be opened", async () => {
    expect(
      await reasonOf("passed", { reader: { failures: { "metadata get": "bundleUnreadable" } } }),
    ).toBe("resultBundleUnreadable")
  })

  test("unsupportedResultSchema — the recorded toolchain no longer matches", async () => {
    const fixture = loadFixture("passed")
    const replaced = { ...identityFor(fixture), xcresulttoolDigest: "b".repeat(64) }
    expect(await reasonOf("passed", { reader: { identity: replaced } })).toBe(
      "unsupportedResultSchema",
    )
  })

  test("unsupportedResultSchema — a status literal the decoder does not recognize", async () => {
    expect(await reasonOf("unsupported-status", { request: { execution: FAILED_EXIT } })).toBe(
      "unsupportedResultSchema",
    )
  })

  test("resultBundleIncomplete — a recognized Test Case carries no status", async () => {
    expect(await reasonOf("missing-status", { request: { execution: FAILED_EXIT } })).toBe(
      "resultBundleIncomplete",
    )
  })

  test("resultBundleIncomplete — advertised test results cannot be retrieved", async () => {
    expect(
      await reasonOf("passed", {
        request: { execution: FAILED_EXIT },
        reader: { failures: { "get test-results tests": "commandFailed" } },
      }),
    ).toBe("resultBundleIncomplete")
  })

  test("contradictoryEvidence — the summary and the hierarchy disagree", async () => {
    expect(
      await reasonOf("contradictory-evidence", { request: { execution: FAILED_EXIT } }),
    ).toBe("contradictoryEvidence")
  })

  test("contradictoryEvidence — availability denies tests the summary reports", async () => {
    expect(await reasonOf("availability-contradiction")).toBe("contradictoryEvidence")
  })

  test("contradictoryEvidence — a successful exit alongside reported failures", async () => {
    // The process says it worked; the Result Bundle says a test failed. Neither
    // is silently preferred, because preferring the wrong one is a false pass.
    expect(await reasonOf("test-failed")).toBe("contradictoryEvidence")
  })

  test("scopeMismatch — the Requested Scope matched nothing that ran", async () => {
    expect(
      await reasonOf("zero-match", {
        scope: { kind: "selected", tests: [{ bundle: "AppTests", suite: "MissingTests" }] },
      }),
    ).toBe("scopeMismatch")
  })

  test("scopeUnverifiable — identity components are missing", async () => {
    // A Test Case with no Xcode identifier is retained for diagnostics, but a
    // scope that cannot be verified is never inferred to have matched.
    expect(await reasonOf("unverifiable-identity")).toBe("scopeUnverifiable")
  })

  test("unknownTestStatus — a test reported the literal status `unknown`", async () => {
    expect(await reasonOf("unknown-status")).toBe("unknownTestStatus")
  })

  test("interpretationTimedOut — the eager deadline expired", async () => {
    expect(
      await reasonOf("passed", {
        request: { execution: FAILED_EXIT, deadlineMs: 1, clock: advancingClock(50) },
      }),
    ).toBe("interpretationTimedOut")
  })

  test("never invents a reason outside the closed taxonomy", async () => {
    const reason = await reasonOf("unknown-status")
    expect(INFRASTRUCTURE_REASONS).toContain(reason as never)
  })
})

describe("the reasons the interpreter never produces", () => {
  test("are the ones the runner owns", () => {
    // Recorded so that moving one of these is a deliberate act: the interpreter
    // never observes a launch, so it can never diagnose one.
    const runnerOwned = ["processLaunchFailed", "runnerFailure"]
    for (const reason of runnerOwned) expect(INFRASTRUCTURE_REASONS).toContain(reason as never)
  })
})

function advancingClock(stepMs: number) {
  let now = 0
  return {
    now() {
      const value = now
      now += stepMs
      return value
    },
  }
}
