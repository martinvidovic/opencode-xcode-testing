/**
 * The gate's durable report (issue #27).
 *
 * A gate invocation that left no trace is one nobody can check afterwards, and
 * "it failed to start" is exactly the outcome most worth having a record of.
 * The other property is where the record lands: a report can contain private
 * project facts, so it is written into tool-managed storage by construction
 * rather than by a convention that a `git add -A` eventually breaks.
 */

import { describe, expect, test } from "bun:test"
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { renderReport, reportDirectory, writeReport, type RunReport } from "../../scripts/gate/report.ts"

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    schemaVersion: 1,
    startedAt: "2026-09-14T01:00:00.000Z",
    finishedAt: "2026-09-14T01:05:00.000Z",
    selected: ["layer4", "b1", "b2"],
    toolchain: {
      xcodeVersion: "26.4.1",
      xcodeBuild: "17E202",
      xcresulttoolVersion: "24757",
      schemaVersion: "0.1.0",
      developerDirectory: "/Applications/Xcode.app/Contents/Developer",
    },
    hostVersion: "1.18.29",
    runtime: { path: "/opt/homebrew/bin/bun", version: "1.4.0", source: "host" },
    destination: { deviceName: "iPhone CI", runtime: "iOS-26-4", id: "ABC" },
    freshness: { status: "fresh" },
    scenarios: [],
    outcome: "passed",
    ...overrides,
  }
}

function sandbox<T>(work: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "xcode-test-report-"))
  try {
    return work(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe("where a report is written", () => {
  test("is inside tool-managed storage, never anywhere a repository tracks", () => {
    sandbox((home) => {
      const path = writeReport(report(), home)
      expect(path.startsWith(reportDirectory(home))).toBe(true)
      expect(path.includes("opencode-xcode-test")).toBe(true)
    })
  })

  test("is owner-only, because it can name someone's project", () => {
    sandbox((home) => {
      const path = writeReport(report({ project: true }), home)
      expect(lstatSync(path).mode & 0o077).toBe(0)
      expect(lstatSync(reportDirectory(home)).mode & 0o077).toBe(0)
    })
  })

  test("does not overwrite an earlier run's report", () => {
    sandbox((home) => {
      const first = writeReport(report({ startedAt: "2026-09-14T01:00:00.000Z" }), home)
      const second = writeReport(report({ startedAt: "2026-09-14T02:00:00.000Z" }), home)
      expect(first).not.toBe(second)
    })
  })

  test("round-trips as JSON somebody else can read", () => {
    sandbox((home) => {
      const written = report({ outcome: "failed" })
      const parsed = JSON.parse(readFileSync(writeReport(written, home), "utf8"))
      expect(parsed).toEqual(written as never)
    })
  })
})

describe("what a report says", () => {
  test("names the suites selected, not merely the scenarios that ran", () => {
    // Otherwise a full gate and a single-suite run are indistinguishable, and
    // the difference is the whole claim.
    const rendered = renderReport(report({ selected: ["b1"], scenarios: [] }), "/somewhere")
    expect(rendered).toContain("selected       b1")
  })

  test("says plainly when nothing ran at all", () => {
    const rendered = renderReport(report({ outcome: "failed", scenarios: [] }), "/somewhere")
    expect(rendered).toContain("(none ran)")
  })

  test("says a project was supplied without naming it", () => {
    // The path is a private fact about someone's machine, and this file is
    // durable. That the standing gate was not what ran is the part that matters.
    const rendered = renderReport(
      report({ project: true, selected: ["layer4"] }),
      "/somewhere",
    )
    expect(rendered).toContain("supplied project")
  })

  test("marks report-only scenarios so a reader knows what gated", () => {
    const rendered = renderReport(
      report({
        scenarios: [
          { name: "passing run", kind: "gating", status: "passed", detail: "passed" },
          { name: "real cancellation", kind: "report-only", status: "failed", detail: "observed timedOut" },
        ],
      }),
      "/somewhere",
    )

    expect(rendered).toContain("[report-only]")
    // A failed report-only scenario must not read as a failed gate.
    expect(rendered.startsWith("acceptance gate: passed")).toBe(true)
  })

  test("names the report's own path, so the run can be found again", () => {
    expect(renderReport(report(), "/tmp/acceptance-1.json")).toContain("/tmp/acceptance-1.json")
  })
})
