/**
 * What a gate invocation has established so far (issue #45).
 *
 * The gate's report answers one question: what has this machine actually
 * verified? That makes the difference between *unobserved* and *false* the
 * whole point of the file. A report saying `Xcode unobserved` says nobody
 * looked; a report saying `Xcode 0.0` says somebody looked and found nothing,
 * which is a claim about a machine rather than about a run.
 *
 * The exceptional path is where that distinction used to be lost. A gate that
 * threw two minutes in — after resolving a toolchain, discovering a simulator
 * and running eleven scenarios — wrote a report stating every one of those as
 * unobserved, and the record of a genuinely useful partial run became
 * indistinguishable from a run that never started.
 *
 * So facts are recorded here **as they are established**, not assembled at the
 * end. Both exits read the same accumulator, which means the exceptional path
 * cannot report less than the normal one knew: there is only one place either
 * of them can read from.
 */

import type { Suite } from "./options.ts"
import type { RunReport, ScenarioResult } from "./report.ts"

/**
 * The one word for a fact nobody established.
 *
 * Spelled once because it is load-bearing: a reader scanning a report sorts
 * every line into "observed" or "not", and a second spelling — `unresolved`,
 * `unknown`, blank — reads as a third category that does not exist.
 */
export const UNOBSERVED = "unobserved"

/** Stated as unobserved rather than blank, so a report never implies a fact. */
export const UNOBSERVED_TOOLCHAIN = {
  xcodeVersion: UNOBSERVED,
  xcodeBuild: UNOBSERVED,
  xcresulttoolVersion: UNOBSERVED,
  schemaVersion: UNOBSERVED,
  developerDirectory: UNOBSERVED,
} as const

/**
 * A run's observations, mutated as it makes them.
 *
 * Deliberately mutable, and deliberately holding `scenarios` by reference: the
 * gate pushes into that array as suites finish, so a throw three suites in
 * still finds the first two recorded here without anything having had to
 * remember to copy them over.
 */
export type Observations = {
  startedAt: string
  selected: Suite[]
  project?: boolean
  toolchain?: RunReport["toolchain"]
  hostVersion?: string
  runtime?: RunReport["runtime"]
  destination?: RunReport["destination"]
  freshness?: unknown
  scenarios: ScenarioResult[]
}

export function newObservations(startedAt: string): Observations {
  return { startedAt, selected: [], scenarios: [] }
}

/**
 * How a suite reports a scenario the moment it finishes.
 *
 * A suite that collected its results and returned them at the end lost every
 * one of them when it threw part-way — and a suite is exactly where a throw is
 * likely, because a suite is the part that talks to a simulator, a host
 * process and a compiler. Eleven scenarios that passed are eleven facts about
 * this machine, and they do not stop being true because the twelfth blew up.
 *
 * A function rather than the array itself, so a suite cannot reorder, re-read
 * or remove what another suite recorded: the only thing it can do with the
 * report is add to it.
 */
export type ScenarioSink = (scenario: ScenarioResult) => void

export function scenarioSink(observed: Observations): ScenarioSink {
  return (scenario) => {
    observed.scenarios.push(scenario)
  }
}

/**
 * The report these observations support, and no more than that.
 *
 * Every fact absent from the accumulator is written as unobserved. That is the
 * one rule here, and it runs in both directions: a fact that was established
 * survives whatever happened afterwards, and a fact that was not is never
 * filled in with a plausible default.
 */
export function reportFrom(
  observed: Observations,
  outcome: "passed" | "failed",
  diagnostic?: string,
): RunReport {
  return {
    schemaVersion: 1,
    startedAt: observed.startedAt,
    finishedAt: new Date().toISOString(),
    selected: observed.selected,
    ...(observed.project === true ? { project: true } : {}),
    // Copied, never aliased. A shared object handed to every report is one
    // any reader could edit for all of them.
    toolchain: observed.toolchain ?? { ...UNOBSERVED_TOOLCHAIN },
    hostVersion: observed.hostVersion ?? UNOBSERVED,
    runtime: observed.runtime ?? { path: "", source: UNOBSERVED },
    // A destination is the one fact with two kinds of absence: never reached,
    // and reached and found wanting. Only the first is unobserved; the second
    // is a diagnostic the gate already recorded.
    destination: observed.destination ?? { unavailable: UNOBSERVED },
    // Deliberately not the freshness checker's own "unavailable" shape. That
    // one is a *result* — it looked and could not check — and this is the
    // absence of a result, which is a different thing to tell a reader.
    freshness: observed.freshness ?? { status: UNOBSERVED },
    scenarios: observed.scenarios,
    outcome,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  }
}
