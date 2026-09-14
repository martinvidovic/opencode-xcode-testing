/**
 * What a failed gate still knows (issue #45).
 *
 * The report answers one question — what has this machine actually verified —
 * and the exceptional path is where the answer used to be thrown away. A gate
 * that threw two minutes in had resolved a toolchain, discovered a simulator
 * and run a dozen scenarios, and then wrote a report saying it had observed
 * none of them. That report is not merely incomplete: it is indistinguishable
 * from the report of a run that never started, which is the one thing a
 * durable record must never be.
 *
 * The distinction under test throughout is *unobserved* versus *false*. A
 * report saying `Xcode unobserved` says nobody looked. A report saying
 * `Xcode 0.0` says somebody looked and found that, which is a claim about a
 * machine rather than about a run.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main } from "../../scripts/acceptance-gate.ts"
import {
  newObservations,
  reportFrom,
  UNOBSERVED_TOOLCHAIN,
  type Observations,
} from "../../scripts/gate/observations.ts"
import { reportDirectory, writeReport, type RunReport } from "../../scripts/gate/report.ts"

const STARTED_AT = "2026-09-14T01:00:00.000Z"

/** A run that got as far as a toolchain, a simulator and two scenarios. */
function partlyObserved(): Observations {
  const observed = newObservations(STARTED_AT)
  observed.selected = ["layer4", "b1"]
  observed.toolchain = {
    xcodeVersion: "26.4.1",
    xcodeBuild: "17E202",
    xcresulttoolVersion: "24757",
    schemaVersion: "0.1.0",
    developerDirectory: "/Applications/Xcode.app/Contents/Developer",
  }
  observed.hostVersion = "1.18.29"
  observed.runtime = { path: "/opt/homebrew/bin/bun", version: "1.4.0", source: "host" }
  observed.destination = { deviceName: "iPhone CI", runtime: "iOS-26-4", id: "ABC" }
  observed.scenarios.push(
    { name: "passing run", kind: "gating", status: "passed", detail: "passed", durationMs: 6535 },
    { name: "failing run", kind: "gating", status: "passed", detail: "testFailed" },
  )
  return observed
}

describe("a gate that throws after establishing something", () => {
  test("keeps every fact it had already observed", () => {
    // Each of these cost real time and a real machine to establish. Throwing
    // them away because of what happened afterwards discards the only part of
    // the invocation that worked.
    const report = reportFrom(partlyObserved(), "failed", "Error: boom")

    expect(report.toolchain.xcodeVersion).toBe("26.4.1")
    expect(report.hostVersion).toBe("1.18.29")
    expect(report.runtime).toMatchObject({ version: "1.4.0", source: "host" })
    expect(report.destination).toMatchObject({ deviceName: "iPhone CI" })
    expect(report.scenarios).toHaveLength(2)
    expect(report.scenarios[0]?.name).toBe("passing run")
  })

  test("marks only what it never reached as unobserved", () => {
    // Freshness runs last, so a throw before it leaves exactly that hole —
    // and the hole says "nobody looked" rather than being filled with a
    // plausible-sounding default.
    const report = reportFrom(partlyObserved(), "failed", "Error: boom")

    expect(report.freshness).toEqual({ status: "unobserved" })
    expect(report.toolchain).not.toEqual(UNOBSERVED_TOOLCHAIN)
  })

  test("records the selected suites and a diagnostic", () => {
    // Without the suites, `failed` means nothing: a full gate and a
    // single-suite run read identically. Without the diagnostic there is no
    // account at all of why this one ended.
    const report = reportFrom(partlyObserved(), "failed", "Error: boom")

    expect(report.selected).toEqual(["layer4", "b1"])
    expect(report.diagnostic).toBe("Error: boom")
    expect(report.outcome).toBe("failed")
  })

  test("sees scenarios that finished after the report shape was decided", () => {
    // The property that makes partial retention work at all: the accumulator
    // holds the scenario list by reference, so nothing has to remember to copy
    // results across before the throw that nobody planned for.
    const observed = newObservations(STARTED_AT)
    const report = () => reportFrom(observed, "failed", "Error: boom")

    expect(report().scenarios).toHaveLength(0)
    observed.scenarios.push({ name: "late", kind: "gating", status: "passed", detail: "" })
    expect(report().scenarios).toHaveLength(1)
  })
})

describe("a gate that establishes nothing", () => {
  test("states every fact as unobserved rather than as a value", () => {
    // `Xcode 0.0` would be a report lying about having looked, and a blank
    // would be one a reader has to guess about.
    const report = reportFrom(newObservations(STARTED_AT), "failed", "unknown option")

    expect(report.toolchain).toEqual(UNOBSERVED_TOOLCHAIN)
    expect(report.hostVersion).toBe("unobserved")
    expect(report.runtime.source).toBe("unobserved")
    expect(report.destination).toEqual({ unavailable: "unobserved" })
    expect(report.selected).toEqual([])
  })

  test("omits the diagnostic when there is nothing to say", () => {
    expect(reportFrom(newObservations(STARTED_AT), "passed").diagnostic).toBeUndefined()
  })
})

describe("the durable record", () => {
  test("round-trips a partial observation to disk", async () => {
    // The report is only worth anything if what it holds survives being
    // written; a reader comes back to the file, not to the object.
    const homeDir = mkdtempSync(join(tmpdir(), "xcode-test-reports-"))
    try {
      const report = reportFrom(partlyObserved(), "failed", "Error: boom")
      const path = writeReport(report, homeDir)

      expect(path.startsWith(reportDirectory(homeDir))).toBe(true)
      const persisted = JSON.parse(readFileSync(path, "utf8")) as RunReport
      expect(persisted).toEqual(report)
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

describe("the gate's own wiring", () => {
  test("writes what the accumulator holds, not a separately-assembled report", async () => {
    // A refused command line is the one path that can be driven without a
    // simulator, and it is enough to pin the wiring: `main` is handed the
    // accumulator and every exit reads from it, so there is nowhere else a
    // fact could come from — or fail to.
    //
    // It writes a real report, because writing one is the behaviour under
    // test and `os.homedir()` is fixed for the life of a process. The report
    // is named after `startedAt`, which is this test's own constant, so it
    // cannot collide with a real run's and is removed afterwards.
    const observed = newObservations(STARTED_AT)
    const written = join(
      reportDirectory(),
      `acceptance-${STARTED_AT.replace(/[:.]/g, "-")}.json`,
    )

    try {
      const code = await main(["--nonsense"], observed)

      expect(code).toBe(2)
      expect(observed.selected).toEqual([])
      expect(observed.toolchain).toBeUndefined()

      const persisted = JSON.parse(readFileSync(written, "utf8")) as RunReport
      expect(persisted.toolchain).toEqual(UNOBSERVED_TOOLCHAIN)
      expect(persisted.freshness).toEqual({ status: "unobserved" })
      expect(persisted.diagnostic).toContain("--nonsense")
    } finally {
      rmSync(written, { force: true })
    }
  })
})
