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
 * Scenarios that are reported when they happen and are not expected otherwise.
 *
 * Each is here for a stated reason, because "conditional" is otherwise an
 * invitation to exempt anything inconvenient:
 *
 * - `b1 host registration` and `b2 execution` are failure paths. They exist
 *   only when a host could not be started or driven at all, in which case the
 *   suite's standing scenarios are separately reported as unreached.
 * - `supplied project run` is what `--project` adds. The standing gate must
 *   run from committed files, so this can never be a standing check.
 */
export const CONDITIONAL = [
  "b1 host registration",
  "b2 execution",
  "supplied project run",
] as const

/**
 * Every name the gate may report.
 *
 * A union rather than `string`, so an emitter naming something the registry
 * does not know is a mistake at the point it is written. There is no `tsc` in
 * this repository, so that is a guarantee for a reader and an editor rather
 * than for CI — which is why `isRegistered` checks the same thing at runtime.
 */
export type ScenarioName =
  | (typeof STANDING)[Suite][number]
  | (typeof CONDITIONAL)[number]

const STANDING_NAMES: readonly string[] = Object.values(STANDING).flat()

export const ALL_SCENARIOS: readonly string[] = [...STANDING_NAMES, ...CONDITIONAL]

/** Whether this name is reported only when something specific happens. */
export function isConditional(name: string): boolean {
  return (CONDITIONAL as readonly string[]).includes(name)
}

/** Whether this name is one the registry knows about at all. */
export function isRegistered(name: string): boolean {
  return ALL_SCENARIOS.includes(name)
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

  for (const name of CONDITIONAL) {
    if (STANDING_NAMES.includes(name)) {
      problems.push(`\`${name}\` is both standing and conditional`)
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
