/**
 * The scenario registry, and the run it is supposed to describe (issue #62).
 *
 * The registry is what lets a report say a check was *not reached* rather than
 * leaving it merely absent. That only works while the registry and the suites
 * agree, and the ways they can stop agreeing are quiet by nature: a registry
 * is consulted when something has already gone wrong, so a stale one is read
 * exactly once — on the report nobody can now trust.
 *
 * Every test here is about one of those ways.
 */

import { describe, expect, test } from "bun:test"

import {
  ALL_SCENARIOS,
  CONDITIONAL,
  registryProblems,
  SCENARIO,
  STANDING,
  standingFor,
} from "../../scripts/gate/scenarios.ts"
import { SUITES } from "../../scripts/gate/options.ts"
import {
  asSuite,
  newObservations,
  registryDisagreements,
  reportFrom,
  scenarioSink,
} from "../../scripts/gate/observations.ts"

const STARTED_AT = "2026-09-14T01:00:00.000Z"

describe("the registry itself", () => {
  test("names each scenario once", () => {
    // A duplicate would make one scenario's result silently answer for
    // another's, and "not reached" ambiguous about which suite failed to
    // reach it.
    expect(registryProblems()).toEqual([])
    expect(new Set(ALL_SCENARIOS).size).toBe(ALL_SCENARIOS.length)
  })

  test("covers every suite", () => {
    for (const suite of SUITES) expect(STANDING[suite].length).toBeGreaterThan(0)
  })

  test("keeps standing and conditional apart", () => {
    // The distinction is what makes "not reached" meaningful. A conditional
    // scenario listed as standing would be named as unreached on every clean
    // run, because not running is its ordinary case.
    const standing = new Set(standingFor(SUITES))
    for (const name of CONDITIONAL) expect(standing.has(name)).toBe(false)
  })

  test("addresses every name through `SCENARIO`, so an emitter cannot invent one", () => {
    for (const name of ALL_SCENARIOS) expect(SCENARIO[name]).toBe(name)
  })
})

describe("a scenario the registry has never heard of", () => {
  test("is surfaced rather than quietly reported alongside the rest", () => {
    // It would appear among the results and never among the expectations, so
    // a reader comparing the two is missing a row and cannot tell.
    const observed = newObservations(STARTED_AT)
    observed.selected = []
    scenarioSink(observed)({
      name: "a check nobody registered",
      kind: "gating",
      status: "passed",
      detail: "",
    })

    expect(registryDisagreements(observed)).toEqual([
      "`a check nobody registered` was reported but is not in the registry",
    ])
  })
})

describe("a suite that finished without running one of its standing checks", () => {
  test("is reported, whether or not something else failed", async () => {
    // The direction the previous check suppressed. A failing run is exactly
    // when a stale registry does its damage, because it is the run whose
    // report gets read.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const name of STANDING.b1.slice(0, -1)) {
        record({ name, kind: "gating", status: "failed", detail: "it failed" })
      }
    })

    expect(registryDisagreements(observed)).toEqual([
      "`b1 documented installation path` is a standing b1 check and was not reported",
    ])
  })

  test("is not reported when the suite was interrupted", async () => {
    // An interrupted suite is missing scenarios by definition. Calling that a
    // disagreement would raise a false alarm on exactly the runs the registry
    // exists to describe.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]

    await expect(
      asSuite(observed, "b1", async () => {
        throw new Error("the host went away")
      }),
    ).rejects.toThrow()

    expect(registryDisagreements(observed)).toEqual([])
  })

  test("is silent on a suite that ran everything", async () => {
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const name of STANDING.b1) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
    })

    expect(registryDisagreements(observed)).toEqual([])
  })
})

describe("a conditional scenario", () => {
  test("is reportable without ever being named as unreached", async () => {
    // `b1 host registration` exists only when a host could not be driven at
    // all. Expecting it would mean naming it as missing on every run where
    // the host worked.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "failed",
        detail: "no host",
      })
    })

    const report = reportFrom(observed, "failed", "the host could not be driven")

    expect(report.scenarios.map((s) => s.name)).toEqual(["b1 host registration"])
    expect(report.unreached).toEqual([...STANDING.b1])
    expect(report.unreached).not.toContain("b1 host registration")
  })
})

describe("the durable record of a suite", () => {
  test("carries the public fields and nothing else", () => {
    // `from` and `to` are how scenarios are attributed to suites. An index
    // into an array means nothing to someone reading the file a week later,
    // and a number in a durable record invites being trusted.
    const observed = newObservations(STARTED_AT)
    observed.suites.push({ suite: "b1", entered: true, completed: true, from: 0, to: 0 })

    const suites = reportFrom(observed, "passed").suites ?? []

    expect(suites).toEqual([{ suite: "b1", entered: true, completed: true }])
    expect(Object.keys(suites[0] ?? {}).sort()).toEqual(["completed", "entered", "suite"])
  })
})

describe("a clean run", () => {
  test("reports every standing scenario and nothing unreached", async () => {
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const name of STANDING.b1) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
    })

    const report = reportFrom(observed, "passed")

    expect(report.unreached).toBeUndefined()
    expect(registryDisagreements(observed)).toEqual([])
    expect(report.scenarios).toHaveLength(STANDING.b1.length)
  })
})
