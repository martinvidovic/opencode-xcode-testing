/**
 * The acceptance gate's scenario registry (issue #62).
 *
 * Every scenario the gate can report is named here once, and the suites take
 * their names from this file rather than spelling them again. That is the
 * whole design, and it exists because the alternative was tried: #58 wrote the
 * names down a second time so that a report could say what it had *not*
 * reached, and a second copy of a set of names is a second copy that drifts.
 *
 * Drift here is quiet in an unusual way. A renamed scenario would leave the
 * registry naming a check that no longer exists as unreached — on every failed
 * report, for ever — while the check that replaced it went unaccounted for.
 * Nothing would notice, because a registry is consulted only once something
 * has already gone wrong. One definition removes the possibility rather than
 * watching for it.
 *
 * **Standing versus conditional** is the other distinction this file carries,
 * and it is what makes "not reached" meaningful. A standing scenario is one
 * the gate runs every time its suite runs, so its absence from a report is a
 * fact about the run. A conditional one appears only when something specific
 * happens — a host that will not start, a project supplied on the command
 * line — so its absence is the ordinary case and says nothing at all. Naming
 * conditional scenarios as unreached would fill every clean report with checks
 * that were never going to run.
 */

import type { Suite } from "./options.ts"

/**
 * The scenarios each suite runs every time. Order is the order they run in,
 * which is the order a reader expects to see them accounted for.
 */
export const STANDING = {
  layer4: [
    "passing run",
    "failing run",
    "zero-match detection",
    "buildFailed",
    "inspection without rerun",
    "capped and cursor inspection",
    "real cancellation",
    "timeout escalation",
  ],
  b1: [
    "b1 tool ids register",
    "b1 tool descriptions",
    "b1 parameter schemas",
    "b1 enablement marker gates registration",
    "b1 restricted agents",
    "b1 documented installation path",
  ],
  b2: [
    "b2 passing",
    "b2 driven by a model turn",
    "b2 testFailed",
    "b2 rendered diagnostics",
    "b2 budget invariant",
    "b2 zero-match",
    "b2 buildFailed",
    "b2 inspection without rerun",
    "b2 log facet",
  ],
} as const satisfies Record<Suite, readonly string[]>

/**
 * Scenarios reported when they happen, and not expected otherwise.
 *
 * Each carries what a *failure* of it prevents, rather than a flag saying
 * whether it stops something. A suite is not always one thing: `b1` is a
 * registration gate and an installation gate run back to back, and they fail
 * independently. A host that will not start prevents the five registration
 * checks and has nothing to do with whether a documented symlink registers the
 * tool family — so "this failure stops this suite" was too coarse a claim, and
 * it made an honest bootstrap failure look like registry drift the moment the
 * installation check ran afterwards.
 *
 * Naming what is prevented also says where the boundary is, which a boolean
 * cannot. The list lives beside the scenario because that is where the fact
 * belongs, and because a second list of names is a second list that drifts —
 * the mistake this whole file exists to remove.
 *
 * - `b1 host registration` is the registration gate failing to start or be
 *   driven: no host, no SDK, no resolvable plugin. It prevents that gate's
 *   checks and only those.
 * - `b2 execution` is the same for the execution gate, which is the whole of
 *   b2, so it prevents all of them.
 * - `supplied project run` is what `--project` adds, and it runs *after* the
 *   standing scenarios. It prevents nothing: failing says nothing about
 *   whether they ran, which is why it must never excuse them.
 */
export const CONDITIONAL = {
  "b1 host registration": {
    suite: "b1",
    prevents: [
      "b1 tool ids register",
      "b1 tool descriptions",
      "b1 parameter schemas",
      "b1 enablement marker gates registration",
      "b1 restricted agents",
    ],
  },
  "b2 execution": {
    suite: "b2",
    prevents: [
      "b2 passing",
      "b2 driven by a model turn",
      "b2 testFailed",
      "b2 rendered diagnostics",
      "b2 budget invariant",
      "b2 zero-match",
      "b2 buildFailed",
      "b2 inspection without rerun",
      "b2 log facet",
    ],
  },
  "supplied project run": { suite: "layer4", prevents: [] },
} as const satisfies Record<string, { suite: Suite; prevents: readonly string[] }>

export const CONDITIONAL_NAMES = Object.keys(CONDITIONAL) as Array<keyof typeof CONDITIONAL>

/**
 * What a failure of this name, in this suite, prevented from running.
 *
 * Empty for anything that prevents nothing, and for a name recorded in a suite
 * it does not belong to: `b1 host registration` inside b2 is not b2 saying it
 * could not start, and should excuse b2 from nothing.
 */
export function preventedBy(suite: Suite, name: string): readonly string[] {
  const entry = CONDITIONAL[name as keyof typeof CONDITIONAL]
  return entry !== undefined && entry.suite === suite ? entry.prevents : []
}

/**
 * Every name the gate may report.
 *
 * A union rather than `string`, so an emitter naming something the registry
 * does not know is a mistake at the point it is written. There is no `tsc` in
 * this repository, so that is a guarantee for a reader and an editor rather
 * than for CI — which is why `isRegistered` checks the same thing at runtime.
 */
export type ScenarioName = (typeof STANDING)[Suite][number] | keyof typeof CONDITIONAL

const STANDING_NAMES: readonly string[] = Object.values(STANDING).flat()

export const ALL_SCENARIOS: readonly string[] = [...STANDING_NAMES, ...CONDITIONAL_NAMES]

/** Whether this name is one the registry knows about at all. */
export function isRegistered(name: string): boolean {
  return ALL_SCENARIOS.includes(name)
}

/** Whether this name is one of the suite's standing checks. */
export function isStanding(suite: Suite, name: string): boolean {
  return (STANDING[suite] as readonly string[]).includes(name)
}

/** Every standing scenario the selected suites set out to run, in suite order. */
export function standingFor(selected: readonly Suite[]): string[] {
  return selected.flatMap((suite) => [...STANDING[suite]])
}

/**
 * Whether the registry is internally consistent.
 *
 * Both directions, because each catches something the other cannot. A
 * duplicate name would make one scenario's result silently answer for
 * another's; a name in two suites would make "not reached" ambiguous about
 * which suite failed to reach it; and a standing name that is also
 * conditional would be exempted from the expectation it is meant to carry.
 */
export function registryProblems(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()

  for (const name of ALL_SCENARIOS) {
    if (seen.has(name)) problems.push(`\`${name}\` is registered more than once`)
    seen.add(name)
  }

  for (const name of CONDITIONAL_NAMES) {
    if (STANDING_NAMES.includes(name)) {
      problems.push(`\`${name}\` is both standing and conditional`)
    }

    // A conditional that claims to prevent something the registry does not
    // list for its suite would excuse a check nobody expects — silently, and
    // only on the runs where it failed.
    const { suite, prevents } = CONDITIONAL[name]
    for (const prevented of prevents) {
      if (!isStanding(suite, prevented)) {
        problems.push(`\`${name}\` claims to prevent \`${prevented}\`, which is not standing for ${suite}`)
      }
    }
  }

  return problems
}

/**
 * Every registered name, addressable by itself.
 *
 * `SCENARIO["passing run"]` rather than a bare `"passing run"` at each emitter,
 * so the name is a reference to this file and a typo is a missing property
 * rather than a scenario nobody expected. It reads as a small ceremony and it
 * is the thing that makes the registry authoritative rather than advisory.
 */
export const SCENARIO: Record<ScenarioName, ScenarioName> = Object.fromEntries(
  ALL_SCENARIOS.map((name) => [name, name]),
) as Record<ScenarioName, ScenarioName>
