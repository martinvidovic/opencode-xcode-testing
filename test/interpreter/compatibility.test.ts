/** Xcode defaults may evolve without changing the explicitly pinned payloads (#159). */
import { describe, expect, test } from "bun:test"

import { isSupportedXcodeVersion } from "../../src/interpreter/schema.ts"
import { argumentsFor } from "../../src/interpreter/xcresulttool.ts"
import { FAILED_EXIT, identityFor, interpretFixture, loadFixture } from "./harness.ts"

const XCODE_27 = {
  ...identityFor(loadFixture("passed")),
  xcodeVersion: "27.0",
  xcodeBuild: "27A266a",
  xcresulttoolVersion: "25115",
  schemaVersion: "0.4.0",
}

describe("validated Xcode majors", () => {
  test("accepts updates within 26 and 27, including three-component versions", () => {
    for (const version of ["26", "26.4.1", "27.0", "27.0.0", "27.1", "27.99.99"]) {
      expect(isSupportedXcodeVersion(version)).toBe(true)
    }
  })

  test("rejects unvalidated majors and malformed versions", () => {
    for (const version of ["25.4", "28.0", "", "27garbage", "27.", "27.0beta", "27.0.0.1"]) {
      expect(isSupportedXcodeVersion(version)).toBe(false)
    }
  })
})

describe("a newer default schema with valid pinned payloads", () => {
  test("pins focused detail reads too, rather than accepting the newer default", () => {
    expect(
      argumentsFor("get test-results test-details", "/run/result.xcresult", "AppTests/testPass"),
    ).toEqual([
      "get", "test-results", "test-details", "--path", "/run/result.xcresult",
      "--test-id=AppTests/testPass", "--format", "json", "--schema-version", "0.1.0",
    ])
  })

  test("passes with requested-schema provenance, preserving the actual tool identity", async () => {
    const { summary, index } = await interpretFixture("passed", {
      facts: { toolchain: XCODE_27 },
      reader: { identity: XCODE_27 },
    })
    expect(summary.outcome).toBe("passed")
    expect(summary.provenance).toMatchObject({
      xcodeVersion: "27.0",
      requestedSchemaVersion: "0.1.0",
    })
    expect(index.toolchain).toEqual(XCODE_27)
    expect(index.schemaVersion).toBe("0.1.0")
  })

  test("still reports test failures", async () => {
    const { summary } = await interpretFixture("test-failed", {
      facts: { toolchain: XCODE_27 },
      reader: { identity: XCODE_27 },
      request: { execution: FAILED_EXIT },
    })
    expect(summary.outcome).toBe("testFailed")
  })

  test("fails closed when the tool cannot serve a pinned read", async () => {
    const { summary } = await interpretFixture("passed", {
      facts: { toolchain: XCODE_27 },
      reader: {
        identity: XCODE_27,
        failures: { "get content-availability": "commandFailed" },
      },
    })
    expect(summary.outcome).toBe("infrastructureFailed")
  })

  test("still rejects incompatible critical payloads", async () => {
    const { summary } = await interpretFixture("unsupported-status", {
      facts: { toolchain: XCODE_27 },
      reader: { identity: XCODE_27 },
    })
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "unsupportedResultSchema",
    })
  })

  test("rejects a future major before reading any payload", async () => {
    const identity = { ...XCODE_27, xcodeVersion: "28.0" }
    const calls: string[] = []
    const { summary } = await interpretFixture("passed", {
      facts: { toolchain: identity },
      reader: { identity, onRun: (command) => calls.push(command) },
    })
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "unsupportedResultSchema",
    })
    expect(calls).toEqual([])
  })

  test("still requires the recorded default schema to match the reader identity", async () => {
    const { summary } = await interpretFixture("passed", {
      facts: { toolchain: XCODE_27 },
      reader: { identity: { ...XCODE_27, schemaVersion: "0.3.0" } },
    })
    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "unsupportedResultSchema",
    })
  })
})
