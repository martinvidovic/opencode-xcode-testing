/**
 * Describing a failure without describing the machine (issue #27).
 *
 * Scenario details land in a durable report and get pasted into issues. A
 * thrown error's message routinely carries a temp directory, a home
 * directory, or a full path to somebody's checkout — none of which a reader
 * elsewhere can act on, and all of which say where this machine keeps things.
 */

import { describe, expect, test } from "bun:test"
import { safeFailure } from "../../src/adapter/sanitize.ts"


describe("a safe diagnostic", () => {
  test("keeps the error's kind and what it said", () => {
    expect(safeFailure(new TypeError("the host answered nothing"))).toBe(
      "TypeError: the host answered nothing",
    )
  })

  test("removes every absolute path it finds", () => {
    const described = safeFailure(
      new Error("ENOENT: no such file, open '/Users/someone/Library/x/result.xcresult'"),
    )

    expect(described).not.toContain("/Users/someone")
    expect(described).toContain("<path>")
    // What actually went wrong survives: a reader can still tell this from a
    // permission error or a timeout.
    expect(described).toContain("ENOENT")
  })

  test("removes a temp directory as readily as a home directory", () => {
    const described = safeFailure(new Error("failed under /var/folders/g8/T/xcode-test-gate-ab"))
    expect(described).not.toContain("/var/folders")
  })

  test("keeps a version number, which is not a path", () => {
    // Over-redacting would leave a diagnostic nobody can act on either.
    expect(safeFailure(new Error("opencode 1.18.29 refused the request"))).toContain("1.18.29")
  })

  test("keeps only the first line of a stack-shaped message", () => {
    const described = safeFailure(
      new Error("the host did not start\n    at boot (/repo/scripts/gate/installation.ts:42)"),
    )
    expect(described).toBe("Error: the host did not start")
  })

  test("is bounded, because a report is read by people", () => {
    expect(safeFailure(new Error("x".repeat(5_000))).length).toBeLessThan(260)
  })

  test("says something even for a thrown value that is not an error", () => {
    expect(safeFailure("a bare string")).toBe("an unrecognized failure")
    expect(safeFailure(undefined)).toBe("an unrecognized failure")
  })

  test("falls back to the kind when the message was only a path", () => {
    expect(safeFailure(new Error("/Users/someone/thing"))).toContain("Error")
  })
})
