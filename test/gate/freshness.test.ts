/**
 * Examining a real Result Bundle (issue #27).
 *
 * Comparing version strings says the toolchain moved; it does not say that
 * anything the decoders rely on did. This is the direct evidence — the same
 * commands interpretation uses, run against a bundle Xcode just produced, and
 * the keys the payloads actually came back with.
 *
 * Non-fatal throughout, like the rest of the freshness check. Drift here means
 * the committed fixtures are stale, which is a thing to know and not a reason
 * to fail a build: a check that broke on a routine Xcode update would be
 * disabled within a week, and then it would tell nobody anything.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { examineBundle, produceAndExamineBundle, runFreshnessCheck } from "../../scripts/freshness-check.ts"

/** A fake `xcresulttool` that answers each command from a table. */
function reader(payloads: Record<string, unknown>) {
  return (_command: string, args: string[]) => {
    // The command is the words between the binary name and `--path`.
    const path = args.indexOf("--path")
    const command = args.slice(1, path).join(" ")
    const payload = payloads[command]

    return payload === undefined
      ? { status: 1, stdout: `Error: File or directory doesn't exist\n` }
      : { status: 0, stdout: JSON.stringify(payload) }
  }
}

/** Everything the decoders read, as a real bundle provides it. */
const COMPLETE = {
  "get content-availability": { hasTestResults: true, logs: [] },
  "get build-results": { errorCount: 0, warningCount: 0, issues: [] },
  "get test-results tests": { testNodes: [], devices: [] },
  "get test-results summary": { result: "Passed", totalTestCount: 2 },
}

describe("examining a bundle", () => {
  test("reports the keys a real payload carried", () => {
    const examination = examineBundle("/somewhere/result.xcresult", reader(COMPLETE))

    expect(examination.status).toBe("examined")
    expect(examination.missingKeys).toEqual([])
    expect(examination.commands).toHaveLength(4)
    expect(examination.commands.every((entry) => entry.status === "decoded")).toBe(true)

    const tests = examination.commands.find((entry) => entry.command === "get test-results tests")
    expect(tests?.keys).toEqual(["devices", "testNodes"])
  })

  test("names the key a payload stopped carrying", () => {
    // The drift that actually breaks things, and the kind no version
    // comparison would have caught.
    const { "get test-results tests": _dropped, ...without } = COMPLETE
    const examination = examineBundle("/somewhere/result.xcresult", reader({
      ...without,
      "get test-results tests": { devices: [] },
    }))

    expect(examination.missingKeys).toEqual(["get test-results tests.testNodes"])
  })

  test("treats a command that stopped answering as every key it would have carried", () => {
    const examination = examineBundle("/somewhere/result.xcresult", reader({}))

    expect(examination.commands.every((entry) => entry.status === "failed")).toBe(true)
    expect(examination.missingKeys.length).toBeGreaterThan(0)
    // The diagnostic is kept, because "it failed" alone is not actionable.
    expect(examination.commands[0]?.message).toContain("Error")
  })

  test("treats a payload that is not JSON as unreadable rather than empty", () => {
    const examination = examineBundle("/somewhere/result.xcresult", () => ({
      status: 0,
      stdout: "<html>not json</html>",
    }))

    expect(examination.commands.every((entry) => entry.status === "failed")).toBe(true)
  })

  test("says so when there was no bundle to examine", () => {
    const examination = examineBundle(undefined)

    // Not a failure: a run that produced no bundle is a normal thing for this
    // check to encounter, and inventing drift from it would be a lie.
    expect(examination.status).toBe("unavailable")
    expect(examination.missingKeys).toEqual([])
  })
})

describe("producing a bundle", () => {
  test("reports an unavailable examination when its workspace cannot be allocated", () => {
    let cleaned = false

    const examination = produceAndExamineBundle({
      workspace: {
        allocate: () => {
          throw new Error("EACCES: cannot create /Users/someone/Library/Caches/xcode-test-freshness")
        },
        cleanup: () => {
          cleaned = true
        },
      },
    })

    expect(examination).toMatchObject({
      status: "unavailable",
      commands: [],
      missingKeys: [],
    })
    expect(examination.reason).toContain("Error")
    expect(examination.reason).not.toContain("/Users/someone")
    expect(examination.reason).toContain("<path>")
    expect((examination.reason ?? "").length).toBeLessThanOrEqual(300)
    expect(cleaned).toBe(false)
  })

  test("cleans up an allocated workspace when fixture generation later fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-freshness-"))
    const workspace = join(directory, "not-a-directory")
    writeFileSync(workspace, "not a workspace")
    const cleaned: string[] = []

    try {
      const examination = produceAndExamineBundle({
        workspace: {
          allocate: () => workspace,
          cleanup: (path) => {
            cleaned.push(path)
          },
        },
      })

      expect(examination.status).toBe("unavailable")
      expect(cleaned).toEqual([workspace])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("the freshness report", () => {
  test("is drifted when a real payload lost a key, whatever the versions say", () => {
    const report = runFreshnessCheck({
      bundle: {
        status: "examined",
        commands: [],
        missingKeys: ["get test-results tests.testNodes"],
      },
    })

    expect(report.status).toBe("drifted")
  })

  test("does not invent drift from a bundle nobody could examine", () => {
    const report = runFreshnessCheck({
      bundle: { status: "unavailable", commands: [], missingKeys: [] },
    })

    // Whatever this machine's toolchain says, an absent bundle adds nothing.
    expect(report.bundle?.status).toBe("unavailable")
    expect(report.status).not.toBe("drifted")
  })
})
