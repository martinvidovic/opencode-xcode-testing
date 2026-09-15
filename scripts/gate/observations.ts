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
import {
  isRegistered,
  preventedBy,
  standingOf,
  registryProblems,
  standingFor,
} from "./scenarios.ts"
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
  /** Set when a failed Layer 4 run's evidence was kept, or could not be. */
  evidence?: RunReport["evidence"]
  selected: Suite[]
  project?: boolean
  packages?: RunReport["packages"]
  toolchain?: RunReport["toolchain"]
  hostVersion?: string
  runtime?: RunReport["runtime"]
  destination?: RunReport["destination"]
  freshness?: unknown
  scenarios: ScenarioResult[]
  /**
   * Which selected suites were entered, and which of those got to the end.
   *
   * This is what makes an *unreached* scenario legible rather than merely
   * absent. A reader seeing four layer4 scenarios cannot tell whether layer4
   * ran four and stopped or ran four and that was all there was — and the
   * difference is the whole question a failed report is asked. A suite marked
   * `entered` with no `completed` beside it is a suite that was interrupted,
   * and everything it would have done after its last recorded scenario is
   * work nobody did.
   */
  suites: SuiteRun[]
}

/**
 * One suite's run, and the span of the report it accounts for.
 *
 * `from` is recorded before the suite can do anything and `to` only once it has
 * finished, so the scenarios between them are exactly the ones it produced.
 * Attributing them by name instead would mean consulting the registry to
 * decide which suite a scenario belonged to — and the registry is the thing
 * being checked, which would make the check agree with itself.
 */
export type SuiteRun = {
  suite: Suite
  entered: true
  completed: boolean
  /** Index into `scenarios` where this suite's results begin. */
  from: number
  /** Index one past its last result. Only meaningful once `completed`. */
  to: number
}

export function newObservations(startedAt: string): Observations {
  return { startedAt, selected: [], scenarios: [], suites: [] }
}

/**
 * Run `work` as a suite, recording that it was entered and whether it ended.
 *
 * The two facts are written at different times on purpose: entry before the
 * suite can throw, completion only once it has not.
 */
export async function asSuite<T>(
  observed: Observations,
  suite: Suite,
  work: () => Promise<T>,
): Promise<T> {
  const entry: SuiteRun = {
    suite,
    entered: true,
    completed: false,
    from: observed.scenarios.length,
    to: observed.scenarios.length,
  }
  observed.suites.push(entry)

  const result = await work()

  entry.completed = true
  entry.to = observed.scenarios.length
  return result
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
  const unreached = unreachedScenarios(observed)
  const problems = [...registryProblems(), ...registryDisagreements(observed)]

  return {
    schemaVersion: 1,
    startedAt: observed.startedAt,
    finishedAt: new Date().toISOString(),
    ...(observed.evidence === undefined ? {} : { evidence: observed.evidence }),
    ...(observed.packages === undefined ? {} : { packages: observed.packages }),
    selected: observed.selected,
    // Only what a reader needs. `from` and `to` are how this file attributes
    // scenarios to suites, and a durable record is not the place for the
    // bookkeeping that produced it — an index into an array is meaningless to
    // anyone reading the file a week later, and invites being trusted.
    suites: observed.suites.map((entry) => ({
      suite: entry.suite,
      entered: entry.entered,
      completed: entry.completed,
    })),
    ...(unreached.length === 0 ? {} : { unreached }),
    ...(problems.length === 0 ? {} : { registryProblems: problems }),
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

/**
 * Scenarios the selected suites set out to run and did not.
 *
 * Named rather than left absent, which is the whole of it: four results from a
 * suite that ran eight scenarios and four from a suite that ran four look the
 * same in a list of four, and a reader of a failed report is asking precisely
 * which of those happened.
 *
 * A scenario is unreached when the registry lists it as standing for a
 * selected suite and nothing recorded it.
 * That covers both ways of not arriving — a suite that threw part-way, and one
 * that was never entered at all — because from the report's point of view they
 * are the same fact: this was going to be checked, and it was not.
 */
export function unreachedScenarios(observed: Observations): string[] {
  const recorded = new Set(observed.scenarios.map((scenario) => scenario.name))
  return standingFor(observed.selected).filter((name) => !recorded.has(name))
}

/**
 * Ways the registry and the run disagree.
 *
 * Bidirectional, and each direction catches what the other cannot.
 *
 * A scenario **emitted but not registered** is one no report can account for:
 * it appears among the results and never among the expectations, so a reader
 * comparing the two is quietly missing a row. Emitters take their names from
 * the registry, so reaching this means someone bypassed it.
 *
 * A standing scenario **registered but not emitted by a suite that ran
 * normally** is the other half: the suite got to the end and did not do what
 * the registry says it does. Either the registry is stale or a check silently
 * stopped running, and both matter.
 *
 * "Ran normally" is doing real work in that sentence. Two suites catch their
 * own failures and report them as a conditional scenario — a host that will
 * not start, an SDK that is not installed — and then return, so they
 * *complete* having run almost nothing. Asking them what they missed would
 * name every standing check they have, on every machine without a host, and
 * say the same thing `unreached` already says, twice and as noise. A suite
 * that reported a conditional failure has explained its own incompleteness
 * and is not asked again.
 *
 * Nothing else is suppressed. Unlike the one-directional check this replaces,
 * an *ordinary* scenario failure does not silence anything: a failing run is
 * exactly when a stale registry does its damage, because it is the run whose
 * report gets read.
 */
export function registryDisagreements(observed: Observations): string[] {
  const problems: string[] = []

  for (const scenario of observed.scenarios) {
    if (!isRegistered(scenario.name)) {
      problems.push(`\`${scenario.name}\` was reported but is not in the registry`)
    }
  }

  for (const entry of observed.suites) {
    if (!entry.completed) continue

    const results = observed.scenarios.slice(entry.from, entry.to)
    const excused = excusedBy(entry.suite, results)

    const produced = new Set(results.map((scenario) => scenario.name))
    for (const name of standingOf(entry.suite)) {
      if (!produced.has(name) && !excused.has(name)) {
        problems.push(`\`${name}\` is a standing ${entry.suite} check and was not reported`)
      }
    }
  }

  return problems
}

/**
 * Standing checks a suite is excused for, given what it reported.
 *
 * A failed conditional says what it prevented — a host that will not start
 * prevents the registration checks and nothing else — and what it prevented is
 * `unreached`'s to report, not this. Naming the same scenarios here would say
 * it twice, and call a crash registry drift while doing so.
 *
 * Two things bound the excuse, and each closes a hole the other leaves open.
 *
 * **What came before.** A prevented check missing from before the failure was
 * not prevented by it: the suite got past that point and simply did not report
 * it, which is exactly the drift this exists to catch.
 *
 * **What came after.** If the suite went on to report prevented checks anyway,
 * the failure did not stop that gate, and nothing it names is excused. Without
 * this, a failure recorded first would cover a check dropped much later, while
 * everything around it ran perfectly well.
 *
 * Only *prevented* checks count towards either. `b1` is a registration gate
 * and an installation gate back to back, and the installation check running
 * afterwards is not the suite carrying on past a host failure — it is a
 * different gate, which never depended on the host at all.
 */
function excusedBy(suite: Suite, results: readonly ScenarioResult[]): Set<string> {
  const excused = new Set<string>()

  results.forEach((result, index) => {
    if (result.status !== "failed") return

    const prevents = preventedBy(suite, result.name)
    if (prevents.length === 0) return

    const positionOf = (name: string): number => prevents.indexOf(name)
    const before = results.slice(0, index)
    const after = results.slice(index + 1)

    // The gate kept going, so the failure did not stop it.
    if (after.some((later) => positionOf(later.name) !== -1)) return

    // How far into the prevented checks the suite demonstrably got. A result
    // that is not one of them leaves this untouched, which is why an
    // independent gate's check cannot raise it.
    const reached = before.reduce(
      (furthest, earlier) => Math.max(furthest, positionOf(earlier.name)),
      -1,
    )

    prevents.forEach((name, position) => {
      if (position > reached) excused.add(name)
    })
  })

  return excused
}
