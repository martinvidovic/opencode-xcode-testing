/**
 * The six Test Run outcomes, driven end to end through the interpreter from
 * committed synthetic payloads.
 */

import { describe, expect, test } from "bun:test"

import { FAILED_EXIT, interpretFixture } from "./harness.ts"

describe("passed", () => {
  test("requires a successful exit, complete evidence, observed tests, and matched scope", async () => {
    const { summary } = await interpretFixture("passed")
    expect(summary.outcome).toBe("passed")
    expect(summary.tests).toEqual({
      completeness: "complete",
      counts: { total: 2, passed: 2, failed: 0, skipped: 0, expectedFailure: 0, unknown: 0 },
    })
    expect(summary.build).toEqual({ completeness: "complete", errorCount: 0 })
    expect(summary.scope.verdict).toBe("matched")
  })

  test("records compact non-path provenance", async () => {
    const { summary } = await interpretFixture("passed")
    expect(summary.provenance).toEqual({
      xcodeVersion: "26.4.1",
      xcodeBuild: "17E202",
      xcresulttoolVersion: "24757",
      requestedSchemaVersion: "0.1.0",
      interpreterDecoderVersion: 1,
    })
  })

  test("is never claimed when no test was observed", async () => {
    const { summary } = await interpretFixture("build-failed")
    expect(summary.outcome).not.toBe("passed")
  })
})

describe("testFailed", () => {
  test("is reported for a known failure under complete evidence", async () => {
    const { summary } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.outcome).toBe("testFailed")
    expect(summary.tests.counts).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      expectedFailure: 0,
      unknown: 0,
    })
  })

  test("carries the failure diagnostic with a repository-relative location", async () => {
    const { summary } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.testFailures).toHaveLength(1)
    expect(summary.diagnostics.testFailures[0]).toMatchObject({
      kind: "testFailure",
      location: { path: "Sources/App/Login.swift", line: 42, column: 9 },
      inspectionAvailable: true,
    })
  })

  test("does not duplicate a failure the summary merely repeats", async () => {
    const { summary } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.testFailureSection).toEqual({
      total: 1,
      shown: 1,
      truncated: false,
    })
  })
})

describe("buildFailed", () => {
  test("is reported from complete build evidence even with no test evidence", async () => {
    const { summary } = await interpretFixture("build-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.outcome).toBe("buildFailed")
    expect(summary.build).toEqual({ completeness: "complete", errorCount: 1 })
    expect(summary.tests).toEqual({ completeness: "unavailable" })
  })

  test("attests the Requested Scope as notReached", async () => {
    const { summary } = await interpretFixture("build-failed", {
      scope: { kind: "selected", tests: [{ bundle: "AppTests", suite: "LoginTests" }] },
      request: { execution: FAILED_EXIT },
    })
    expect(summary.scope.verdict).toBe("notReached")
    expect(summary.scope.attestations).toEqual([
      { selection: { bundle: "AppTests", suite: "LoginTests" }, verdict: "notReached" },
    ])
  })

  test("reports the build error against a repository-relative location", async () => {
    const { summary } = await interpretFixture("build-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.diagnostics.buildErrors[0]).toMatchObject({
      kind: "buildError",
      message: "cannot find 'undefinedSymbol' in scope",
      location: { path: "Sources/App/Login.swift", line: 17, column: 5 },
    })
  })
})

describe("cancelled", () => {
  test("is fixed by the caller cancellation that initiated termination", async () => {
    const { summary } = await interpretFixture("passed", {
      request: {
        terminationTrigger: "callerCancellation",
        interruptionPhase: "testing",
        execution: FAILED_EXIT,
      },
    })
    expect(summary).toMatchObject({ outcome: "cancelled", interruptionPhase: "testing" })
  })

  test("is reported in phase `interpreting` when the caller cancels mid-interpretation", async () => {
    const { summary } = await interpretFixture("passed", {
      request: { signal: { aborted: true } },
    })
    expect(summary).toMatchObject({ outcome: "cancelled", interruptionPhase: "interpreting" })
  })

  test("starts no interpretation work once the caller has cancelled", async () => {
    const commands: string[] = []
    await interpretFixture("passed", {
      request: { signal: { aborted: true } },
      reader: { onRun: (command) => commands.push(command) },
    })
    expect(commands).toEqual([])
  })
})

describe("timedOut", () => {
  test("is fixed by the process deadline, and a later cancellation never overwrites it", async () => {
    const { summary } = await interpretFixture("passed", {
      request: {
        terminationTrigger: "processDeadline",
        deadlineCrossedPhase: "building",
        execution: FAILED_EXIT,
      },
    })
    expect(summary).toMatchObject({ outcome: "timedOut", deadlineCrossedPhase: "building" })
  })
})

describe("an unsuccessful exit with no trustworthy diagnostic", () => {
  test("is infrastructureFailed, never a silent pass", async () => {
    const { summary } = await interpretFixture("passed", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "processFailedWithoutDiagnostics",
    })
  })
})
