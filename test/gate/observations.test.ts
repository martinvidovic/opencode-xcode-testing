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

import { main, recordUncaughtFailure } from "../../scripts/acceptance-gate.ts"
import {
  asSuite,
  newObservations,
  reportFrom,
  scenarioSink,
  UNOBSERVED_TOOLCHAIN,
  type Observations,
} from "../../scripts/gate/observations.ts"
import { compare, render, runFreshnessCheck } from "../../scripts/freshness-check.ts"
import { reportPathFor, writeReport, type RunReport } from "../../scripts/gate/report.ts"
import { standingOf } from "../../scripts/gate/scenarios.ts"

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
    observed.scenarios.push({ name: "b1 tool ids register", kind: "gating", status: "passed", detail: "" })
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

      expect(path).toBe(reportPathFor(STARTED_AT, homeDir))
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
    // simulator, and it pins the wiring: `main` is handed the accumulator and
    // every exit reads from it, so there is nowhere else a fact could come
    // from — or fail to.
    //
    // It writes a real report, because writing one is the behaviour under
    // test and `os.homedir()` is fixed for the life of a process. `startedAt`
    // is unique to this run, so two of these cannot collide.
    const observed = newObservations(new Date().toISOString())
    const written = reportPathFor(observed.startedAt)

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

describe("the handler that runs when everything else has gone wrong", () => {
  test("writes a report holding everything the run reached before it threw", () => {
    // The exceptional path itself, not a stand-in for it. A throw returns
    // nothing, so the handler's only source is what the run wrote down as it
    // went — and this is the assertion that it actually reads it.
    const homeDir = mkdtempSync(join(tmpdir(), "xcode-test-uncaught-"))
    try {
      const observed = partlyObserved()
      recordUncaughtFailure(observed, new Error("boom in /Users/someone/checkout"), homeDir)

      const persisted = JSON.parse(
        readFileSync(reportPathFor(STARTED_AT, homeDir), "utf8"),
      ) as RunReport

      expect(persisted.toolchain.xcodeVersion).toBe("26.4.1")
      expect(persisted.destination).toMatchObject({ deviceName: "iPhone CI" })
      expect(persisted.scenarios).toHaveLength(2)
      expect(persisted.selected).toEqual(["layer4", "b1"])
      expect(persisted.outcome).toBe("failed")

      // Only what it never reached.
      expect(persisted.freshness).toEqual({ status: "unobserved" })
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test("says where the failure was without saying where this machine keeps things", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "xcode-test-uncaught-"))
    try {
      recordUncaughtFailure(
        partlyObserved(),
        new Error("boom in /Users/someone/checkout"),
        homeDir,
      )

      const persisted = JSON.parse(
        readFileSync(reportPathFor(STARTED_AT, homeDir), "utf8"),
      ) as RunReport

      // Reports get pasted into issues. The kind of failure is what a reader
      // elsewhere can act on; the path is not, and it belongs to whoever ran it.
      expect(persisted.diagnostic).toContain("Error")
      expect(persisted.diagnostic).toContain("<path>")
      expect(persisted.diagnostic).not.toContain("/Users/someone")
    } finally {
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test("still reports the original failure when no report can be written", () => {
    // The last line of defence. A handler that threw here would replace the
    // account of what went wrong with an account of the handler.
    const missing = join(tmpdir(), "xcode-test-not-a-home", "\u0000")
    expect(() =>
      recordUncaughtFailure(partlyObserved(), new Error("boom"), missing),
    ).not.toThrow()
  })
})

describe("a suite that throws part-way through", () => {
  test("keeps the scenarios it finished before the throw", () => {
    // The shape every suite now has: results reach the report one at a time,
    // through a sink, rather than being collected and returned at the end. A
    // suite is where the gate talks to a simulator, a host process and a
    // compiler, so it is the likeliest place for something to throw — and
    // returning the collected list at the end means the throw takes all of it.
    const observed = newObservations(STARTED_AT)
    const record = scenarioSink(observed)

    const suite = () => {
      record({ name: "passing run", kind: "gating", status: "passed", detail: "passed" })
      record({ name: "failing run", kind: "gating", status: "passed", detail: "testFailed" })
      throw new Error("the simulator went away")
    }

    expect(suite).toThrow()

    const report = reportFrom(observed, "failed", "Error: the simulator went away")
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual([
      "passing run",
      "failing run",
    ])
  })

  test("distinguishes what passed, what failed, and what was never reached", async () => {
    // Three states. The first two are statuses; the third is absence — and
    // absence is only legible because the report says which suites were
    // entered and which of those finished. Four layer4 scenarios from a suite
    // that completed is all there was; four from one that did not is four and
    // then a stop.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["layer4", "b2"]
    const record = scenarioSink(observed)

    await expect(
      asSuite(observed, "layer4", async () => {
        record({ name: "passing run", kind: "gating", status: "passed", detail: "passed" })
        record({ name: "buildFailed", kind: "gating", status: "failed", detail: "2 errors" })
        throw new Error("the simulator went away")
      }),
    ).rejects.toThrow()

    const report = reportFrom(observed, "failed", "Error: boom")

    expect(report.scenarios.filter((s) => s.status === "passed")).toHaveLength(1)
    expect(report.scenarios.filter((s) => s.status === "failed")).toHaveLength(1)

    // layer4 was entered and did not finish: everything after `buildFailed`
    // is work nobody did.
    expect(report.suites).toMatchObject([{ suite: "layer4", entered: true, completed: false }])

    // b2 was selected and never entered at all, which is a different fact
    // from a b2 that ran and found nothing.
    expect(report.selected).toContain("b2")
    expect(report.suites?.some((entry) => entry.suite === "b2")).toBe(false)
    expect(report.diagnostic).toBe("Error: boom")
  })

  test("marks a suite that got all the way through as completed", async () => {
    const observed = newObservations(STARTED_AT)
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      record({ name: "b1 tool ids register", kind: "gating", status: "passed", detail: "" })
    })

    expect(reportFrom(observed, "passed").suites).toMatchObject([
      { suite: "b1", entered: true, completed: true },
    ])
  })

  test("cannot have its record reordered or removed by the suite writing to it", () => {
    // The sink is a function, not the array. A suite can add to the report and
    // can do nothing else to it — including nothing to what another suite
    // recorded before it.
    const observed = newObservations(STARTED_AT)
    const record = scenarioSink(observed)

    record({ name: "b1 tool ids register", kind: "gating", status: "passed", detail: "" })
    expect(observed.scenarios.map((s) => s.name)).toEqual(["b1 tool ids register"])
  })
})

describe("a freshness check that begins and cannot finish", () => {
  test("reports what it established rather than reporting that nobody looked", () => {
    // The version comparison is cheap and already true; examining a bundle can
    // build an Xcode project and take minutes. A run that ends during the
    // second half used to report the whole check as unobserved.
    const observed = newObservations(STARTED_AT)

    const attempt = () => {
      runFreshnessCheck({
        bundle: { status: "examined", commands: [], missingKeys: [] },
        record: (partial) => {
          observed.freshness = partial
          throw new Error("the build went away")
        },
      })
    }

    expect(attempt).toThrow()

    const report = reportFrom(observed, "failed", "Error: the build went away")
    expect(report.freshness).not.toEqual({ status: "unobserved" })
    expect((report.freshness as { observed: unknown }).observed).toBeDefined()

    // And it says it is only half a check. `status` is a verdict, and a
    // verdict from an unfinished check reads exactly like one from a finished
    // check — so the stage is what stops a reader trusting it as the whole.
    expect((report.freshness as { stage: string }).stage).toBe("comparison")
  })

  test("says so in the text a person reads, not only in the JSON", () => {
    const comparison = compare(
      { xcodeVersion: "26.4.1", xcodeBuild: "17E202", xcresulttoolVersion: "24757", schemaVersion: "0.1.0" },
      {},
    )

    expect(render(comparison)).toContain("the bundle was not examined")
    expect(render({ ...comparison, stage: "complete" })).not.toContain("not examined")
  })
})

describe("scenarios a failed gate never reached", () => {
  test("are named, not left to be inferred from a short list", () => {
    // Four results from a suite that runs eight and four from a suite that
    // runs four look identical in a list of four, and a reader of a failed
    // report is asking precisely which of those happened.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    record({ name: "b1 tool ids register", kind: "gating", status: "passed", detail: "" })
    record({ name: "b1 tool descriptions", kind: "gating", status: "failed", detail: "drifted" })

    const report = reportFrom(observed, "failed", "Error: boom")

    expect(report.unreached).toEqual([
      "b1 parameter schemas",
      "b1 enablement marker gates registration",
      "b1 restricted agents",
      "b1 documented installation path",
    ])
  })

  test("cover a suite that was selected and never entered at all", () => {
    // Both ways of not arriving are the same fact from the report's point of
    // view: this was going to be checked, and it was not.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1", "b2"]

    expect(reportFrom(observed, "failed", "boom").unreached).toEqual([
      ...standingOf("b1"),
      ...standingOf("b2"),
    ])
  })

  test("are absent from a run that reached everything", () => {
    // The other direction: a report that always carried this field would be a
    // report where the field meant nothing.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)
    for (const name of standingOf("b1")) {
      record({ name, kind: "gating", status: "passed", detail: "" })
    }

    expect(reportFrom(observed, "passed").unreached).toBeUndefined()
  })

  test("distinguish completed, failed and unreached together", () => {
    // All three states in one report, which is what the criterion asks for:
    // a reader should not have to reconstruct any of them.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    record({ name: "b1 tool ids register", kind: "gating", status: "passed", detail: "" })
    record({ name: "b1 tool descriptions", kind: "gating", status: "failed", detail: "drifted" })

    const report = reportFrom(observed, "failed", "Error: boom")

    expect(report.scenarios.filter((s) => s.status === "passed").map((s) => s.name)).toEqual([
      "b1 tool ids register",
    ])
    expect(report.scenarios.filter((s) => s.status === "failed").map((s) => s.name)).toEqual([
      "b1 tool descriptions",
    ])
    expect(report.unreached).toContain("b1 restricted agents")
  })
})

describe("a registration suite interrupted between its checks", () => {
  test("keeps the check that had already been decided", async () => {
    // `tool.list` is a second round trip to a host that is still booting, and
    // it sits between the first check and the last two. Collecting all three
    // and returning them meant that if it did not answer, the first — already
    // decided, already true — went with it.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await expect(
      asSuite(observed, "b1", async () => {
        record({
          name: "b1 tool ids register",
          kind: "gating",
          status: "passed",
          detail: "all present",
        })
        throw new Error("the host stopped answering")
      }),
    ).rejects.toThrow()

    const report = reportFrom(observed, "failed", "Error: the host stopped answering")

    // Kept.
    expect(report.scenarios.map((s) => s.name)).toEqual(["b1 tool ids register"])
    expect(report.scenarios[0]?.status).toBe("passed")

    // And everything it never got to is named rather than merely missing.
    expect(report.unreached).toEqual([
      "b1 tool descriptions",
      "b1 parameter schemas",
      "b1 enablement marker gates registration",
      "b1 restricted agents",
      "b1 documented installation path",
    ])

    // The suite is marked entered and unfinished, so the two facts agree.
    expect(report.suites).toMatchObject([{ suite: "b1", entered: true, completed: false }])
  })
})
