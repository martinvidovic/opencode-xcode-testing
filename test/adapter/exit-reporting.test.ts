/**
 * How a Run Record's exit is read back when a run is published (issue #114).
 *
 * There were two readings of the same three fields, one on the terminal path
 * and one on the recovered path, and they disagreed about the case that
 * matters: a record with no exit code and no signal. The recovered path said
 * `unknown`. The terminal path said the process did not exit successfully —
 * which a model is then told as `processFailedWithoutDiagnostics`, sending
 * somebody to look for a defect in tests that may well have passed.
 *
 * The same run described itself differently depending on which route
 * published it, and the difference was invented rather than observed.
 */

import { describe, expect, test } from "bun:test"

import { executionEvidenceFor } from "../../src/adapter/service.ts"

describe("a record with no exit code and no signal", () => {
  test("says the exit is unknown, not that it failed", () => {
    expect(executionEvidenceFor({ execObserved: "yes" })).toEqual({
      execObserved: "yes",
      successfulExit: "unknown",
    })
  })

  test("invents neither a code nor a signal to go with it", () => {
    const evidence = executionEvidenceFor({})

    expect(evidence.exitCode).toBeUndefined()
    expect(evidence.signal).toBeUndefined()
    expect(evidence.execObserved).toBe("unknown")
  })
})

describe("a record that does say how the process ended", () => {
  test("zero is a successful exit", () => {
    expect(executionEvidenceFor({ execObserved: "yes", exitCode: 0 })).toEqual({
      execObserved: "yes",
      exitCode: 0,
      successfulExit: "yes",
    })
  })

  test("any other code is not", () => {
    expect(executionEvidenceFor({ exitCode: 65 }).successfulExit).toBe("no")
  })

  test("a signal is not, whatever code came with it", () => {
    // A process killed by a signal did not succeed, and the exit code that
    // accompanies one says nothing about what it was doing.
    expect(executionEvidenceFor({ exitCode: 0, signal: "SIGKILL" }).successfulExit).toBe("no")
  })
})
