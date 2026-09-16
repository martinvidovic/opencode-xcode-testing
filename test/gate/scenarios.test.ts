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
  CONDITIONAL_NAMES,
  SCENARIO,
  registryProblems,
  standingFor,
  standingOf,
  type ScenarioName,
} from "../../scripts/gate/scenarios.ts"
import { SUITES } from "../../scripts/gate/options.ts"
import {
  asSuite,
  newObservations,
  registryDisagreements,
  reportFrom,
  scenarioSink,
} from "../../scripts/gate/observations.ts"

/**
 * A name the registry does not know.
 *
 * `ScenarioName` exists so that naming a scenario the registry has never heard
 * of is a mistake where it is written — which is precisely what these tests
 * have to simulate, because the *runtime* check is their subject and a
 * compiler that forbade the input outright would leave it untested. Cast in
 * one place, with the reason attached, rather than at each use (issue #74).
 */
function unregistered(name: string): ScenarioName {
  return name as ScenarioName
}

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
    for (const suite of SUITES) expect(standingOf(suite).length).toBeGreaterThan(0)
  })

  test("keeps standing and conditional apart", () => {
    // The distinction is what makes "not reached" meaningful. A conditional
    // scenario listed as standing would be named as unreached on every clean
    // run, because not running is its ordinary case.
    const standing = new Set(standingFor(SUITES))
    for (const name of CONDITIONAL_NAMES) expect(standing.has(name)).toBe(false)
  })

  test("addresses every name through `SCENARIO`, so an emitter cannot invent one", () => {
    for (const name of ALL_SCENARIOS) expect(SCENARIO[name as ScenarioName]).toBe(name as ScenarioName)
  })
})

describe("a scenario the registry has never heard of", () => {
  test("is surfaced in the report itself, on whatever path the run took", () => {
    // Including the paths that end early. The check used to run only after
    // every suite had finished, so a run that threw — or returned before the
    // suites ran at all — wrote the unregistered name into the report with
    // nothing to say so. Those are exactly the runs where it happens.
    const observed = newObservations(STARTED_AT)
    scenarioSink(observed)({
      name: unregistered("a check nobody registered"),
      kind: "gating",
      status: "passed",
      detail: "",
    })

    expect(reportFrom(observed, "failed", "it threw").registryProblems).toEqual([
      "`a check nobody registered` was reported but is not in the registry",
    ])
  })

  test("is surfaced rather than quietly reported alongside the rest", () => {
    // It would appear among the results and never among the expectations, so
    // a reader comparing the two is missing a row and cannot tell.
    const observed = newObservations(STARTED_AT)
    observed.selected = []
    scenarioSink(observed)({
      name: unregistered("a check nobody registered"),
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
      for (const name of standingOf("b1").slice(0, -1)) {
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
      for (const name of standingOf("b1")) {
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
      record({
        name: SCENARIO["b1 documented installation path"],
        kind: "gating",
        status: "passed",
        detail: "",
      })
    })

    const report = reportFrom(observed, "failed", "the host could not be driven")

    expect(report.scenarios.map((s) => s.name)).toEqual([
      "b1 host registration",
      "b1 documented installation path",
    ])
    expect(report.unreached).toEqual([...standingOf("b1").slice(0, -1)])
    expect(report.unreached).not.toContain("b1 host registration")

    // And those are not *also* reported as registry disagreements. The
    // registration gate caught its own failure and returned, so its five
    // checks were never runnable — saying twice what `unreached` already said
    // once would turn an honest bootstrap failure into a page of drift.
    expect(report.registryProblems).toBeUndefined()
  })

  test("that passed does not excuse a suite from its standing checks", async () => {
    // `supplied project run` is conditional and succeeds. Only a conditional
    // *failure* means a suite could not proceed; a conditional pass is just an
    // extra check, and the standing ones are still owed.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "passed",
        detail: "",
      })
    })

    expect(registryDisagreements(observed).length).toBe(standingOf("b1").length)
  })
})

describe("a standing scenario that ran and failed", () => {
  test("excuses nothing, because a result is not a gap", async () => {
    // `preventedBy` returns nothing for a standing name, so an ordinary
    // failure cannot excuse anything — but that is a property worth asserting
    // rather than reasoning about. A check that failed was reached; the one
    // beside it that never reported was not, and is still owed.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const name of standingOf("b1").slice(0, -1)) {
        record({ name, kind: "gating", status: "failed", detail: "it failed" })
      }
    })

    expect(registryDisagreements(observed)).toEqual([
      "`b1 documented installation path` is a standing b1 check and was not reported",
    ])
  })
})

describe("a gate that keeps going after reporting a bootstrap failure", () => {
  test("is excused for nothing it went on to run past", async () => {
    // The 'after' half of the rule. A failure recorded first, with the gate's
    // own checks reported afterwards, did not prevent them — so a check
    // dropped later in that same gate is drift, not fallout, and must not be
    // covered by a failure that demonstrably stopped nothing.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "failed",
        detail: "a transient hiccup",
      })
      // Everything the registration gate owns except the last one.
      for (const name of standingOf("b1").slice(0, 4)) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
      record({
        name: SCENARIO["b1 documented installation path"],
        kind: "gating",
        status: "passed",
        detail: "",
      })
    })

    expect(registryDisagreements(observed)).toEqual([
      "`b1 restricted agents` is a standing b1 check and was not reported",
    ])
  })
})

describe("a suite that ran everything and failed one of them", () => {
  test("is complete: nothing unreached, and no disagreement", async () => {
    // An ordinary failure. The suite did everything the registry says it
    // does, and one of the answers was bad news about the tool — which is a
    // result, not a gap. Suppressing the registry check whenever anything
    // failed was the previous mistake; treating an ordinary failure as a gap
    // would be the mirror image of it.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const [index, name] of standingOf("b1").entries()) {
        record({
          name,
          kind: "gating",
          status: index === 2 ? "failed" : "passed",
          detail: index === 2 ? "the schema drifted" : "",
        })
      }
    })

    const report = reportFrom(observed, "failed")

    expect(report.unreached).toBeUndefined()
    expect(report.registryProblems).toBeUndefined()
    expect(report.scenarios.filter((s) => s.status === "failed")).toHaveLength(1)
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
      for (const name of standingOf("b1")) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
    })

    const report = reportFrom(observed, "passed")

    expect(report.unreached).toBeUndefined()
    expect(registryDisagreements(observed)).toEqual([])
    expect(report.scenarios).toHaveLength(standingOf("b1").length)
  })
})

describe("a conditional failure after the standing checks have run", () => {
  test("does not hide a standing scenario that stopped being reported", async () => {
    // The hole this closes. `supplied project run` is conditional and runs
    // *after* layer4's standing scenarios, so treating every conditional
    // failure alike let a failed `--project` run suppress the whole check —
    // concealing exactly the drift it exists to catch, behind the flag that
    // was supposed to reduce noise.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["layer4"]
    const record = scenarioSink(observed)

    await asSuite(observed, "layer4", async () => {
      for (const name of standingOf("layer4").slice(0, -1)) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
      record({
        name: SCENARIO["supplied project run"],
        kind: "gating",
        status: "failed",
        detail: "the supplied project did not build",
      })
    })

    expect(registryDisagreements(observed)).toEqual([
      "`timeout escalation` is a standing layer4 check and was not reported",
    ])
  })

  test("does not hide a scenario nobody registered either", async () => {
    // The other direction of the same invariant. A failed project run says
    // nothing about whether the suite reported something the registry has
    // never heard of.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["layer4"]
    const record = scenarioSink(observed)

    await asSuite(observed, "layer4", async () => {
      for (const name of standingOf("layer4")) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
      record({ name: unregistered("an unregistered check"), kind: "gating", status: "passed", detail: "" })
      record({
        name: SCENARIO["supplied project run"],
        kind: "gating",
        status: "failed",
        detail: "the supplied project did not build",
      })
    })

    expect(registryDisagreements(observed)).toEqual([
      "`an unregistered check` was reported but is not in the registry",
    ])
  })
})

describe("a suite that never started", () => {
  test("is excused for the checks that failure prevented, and no others", async () => {
    // No host, no SDK: the registration gate reported why and returned. Its
    // five checks were never runnable, and naming them would say twice what
    // `unreached` already said once.
    //
    // The installation gate is a different gate and runs anyway — b1 is two
    // gates back to back — so its check is not excused by a registration
    // failure, and here it is reported as it would be in production.
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
      record({
        name: SCENARIO["b1 documented installation path"],
        kind: "gating",
        status: "passed",
        detail: "",
      })
    })

    expect(registryDisagreements(observed)).toEqual([])
  })

  test("is not excused for an independent check that also went missing", async () => {
    // The installation gate has nothing to do with whether a host started. If
    // its check is absent too, that is a second thing wrong and it is said.
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

    expect(registryDisagreements(observed)).toEqual([
      "`b1 documented installation path` is a standing b1 check and was not reported",
    ])
  })

  test("is excused for what it could not reach after failing part-way through", async () => {
    // A host that dies after the third registration check genuinely prevented
    // the other two. The registration gate records its failure beside
    // whatever already ran, so this is the ordinary shape of a crash — and
    // naming the rest here would repeat what `unreached` already says while
    // calling a crash registry drift.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const name of standingOf("b1").slice(0, 3)) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "failed",
        detail: "the host went away mid-suite",
      })
      record({
        name: SCENARIO["b1 documented installation path"],
        kind: "gating",
        status: "passed",
        detail: "",
      })
    })

    expect(registryDisagreements(observed)).toEqual([])
  })

  test("is still asked about a check it skipped before the failure", async () => {
    // The position half of the rule. A check missing from *before* the
    // failure was not prevented by it — the suite got past that point and
    // simply did not report it, which is exactly the drift this exists to
    // catch, and exactly what a crash must not be allowed to cover.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      // The second standing check never reports; the third does.
      record({ name: standingOf("b1")[0] as ScenarioName, kind: "gating", status: "passed", detail: "" })
      record({ name: standingOf("b1")[2] as ScenarioName, kind: "gating", status: "passed", detail: "" })
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "failed",
        detail: "the host went away",
      })
      record({
        name: SCENARIO["b1 documented installation path"],
        kind: "gating",
        status: "passed",
        detail: "",
      })
    })

    expect(registryDisagreements(observed)).toEqual([
      "`b1 tool descriptions` is a standing b1 check and was not reported",
    ])
  })

  test("is not excused by another suite's bootstrap failure", async () => {
    // A name belongs to one suite. `b1 host registration` recorded inside b2
    // is not b2 saying it could not start, and must not excuse b2 from
    // anything — otherwise one suite's crash quietly covers another's drift.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b2"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b2", async () => {
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "failed",
        detail: "recorded in the wrong suite",
      })
    })

    expect(registryDisagreements(observed).length).toBe(standingOf("b2").length)
  })

  test("is not excused for a check it went on to skip afterwards", async () => {
    // What makes the excuse terminal rather than blanket. A standing check
    // recorded *after* the failure means the suite carried on, so the failure
    // did not stop it and whatever is still missing is missing for some other
    // reason.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      record({
        name: SCENARIO["b1 host registration"],
        kind: "gating",
        status: "failed",
        detail: "a transient host hiccup",
      })
      for (const name of standingOf("b1").slice(0, -1)) {
        record({ name, kind: "gating", status: "passed", detail: "" })
      }
    })

    expect(registryDisagreements(observed)).toEqual([
      "`b1 documented installation path` is a standing b1 check and was not reported",
    ])
  })
})

describe("an ordinary standing-scenario failure", () => {
  test("excuses nothing at all", async () => {
    // A standing check that ran and failed is a result, not a reason to stop
    // asking. Only a failure that prevented the suite from reaching its
    // checks does that.
    const observed = newObservations(STARTED_AT)
    observed.selected = ["b1"]
    const record = scenarioSink(observed)

    await asSuite(observed, "b1", async () => {
      for (const name of standingOf("b1").slice(0, -1)) {
        record({ name, kind: "gating", status: "failed", detail: "it failed" })
      }
    })

    expect(registryDisagreements(observed)).toEqual([
      "`b1 documented installation path` is a standing b1 check and was not reported",
    ])
  })
})
