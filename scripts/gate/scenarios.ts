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

import { SUITES, type Suite } from "./options.ts"

/**
 * The scenarios each suite runs every time, grouped by the gate that runs them.
 *
 * A suite is not always one thing. `b1` is a registration gate and an
 * installation gate run back to back, and they fail independently: a host that
 * will not start says nothing about whether a documented symlink registers the
 * tool family. Grouping is how that shows up in data rather than in a comment.
 *
 * It is also what lets a bootstrap failure say what it prevented without
 * naming anything twice. A failure belongs to a gate, and a gate already knows
 * its checks — so adding a check to a gate adds it to what that gate's failure
 * prevents, with nothing to remember. A second list of names would be a second
 * list that drifts, and a `prevents` list that fell behind would reintroduce
 * exactly the false drift this grouping exists to remove: silently, and only
 * on the machines that cannot run the gate at all.
 *
 * Order within a gate, and gate order within a suite, is the order they run —
 * which is the order a reader expects to see them accounted for.
 */
export const STANDING = {
  layer4: {
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
  },
  b1: {
    registration: [
      "b1 tool ids register",
      "b1 tool descriptions",
      "b1 parameter schemas",
      "b1 enablement marker gates registration",
      "b1 restricted agents",
    ],
    installation: ["b1 documented installation path"],
  },
  b2: {
    execution: [
      "b2 passing",
      "b2 driven by a model turn",
      "b2 testFailed",
      "b2 rendered diagnostics",
      "b2 budget invariant",
      "b2 zero-match",
      "b2 buildFailed",
      "b2 inspection without rerun",
      "b2 log facet",
      "b2 configured host limits",
    ],
  },
} as const satisfies Record<Suite, Record<string, readonly string[]>>

/** Every standing check of a suite, in the order its gates run them. */
export function standingOf(suite: Suite): readonly ScenarioName[] {
  return Object.values(STANDING[suite]).flat() as readonly ScenarioName[]
}

/**
 * Scenarios reported when they happen, and not expected otherwise.
 *
 * A bootstrap failure names the **gate** it belongs to rather than the checks
 * it prevented. The gate knows its own checks, so there is nothing here to
 * fall out of step with, and nothing to remember when a check is added.
 *
 * - `b1 host registration` is the registration gate failing to start or be
 *   driven: no host, no SDK, no resolvable plugin. It prevents that gate's
 *   checks, and the installation gate runs regardless.
 * - `b2 execution` is the same for the execution gate, which is the whole of
 *   b2.
 * - `supplied project run` is what `--project` adds, and it runs *after* the
 *   standing scenarios. It belongs to no gate and prevents nothing: failing
 *   says nothing about whether they ran, which is why it must never excuse
 *   them.
 */
export const CONDITIONAL = {
  "b1 host registration": { suite: "b1", gate: "registration" },
  "b2 execution": { suite: "b2", gate: "execution" },
  "supplied project run": { suite: "layer4", gate: undefined },
} as const satisfies Record<string, { suite: Suite; gate: string | undefined }>

export const CONDITIONAL_NAMES = Object.keys(CONDITIONAL) as Array<keyof typeof CONDITIONAL>

/**
 * What a failure of this name, in this suite, prevented from running.
 *
 * Derived from the gate it belongs to, so it cannot disagree with the
 * registry. Empty for anything that belongs to no gate, and for a name
 * recorded in a suite it does not belong to: `b1 host registration` inside b2
 * is not b2 saying it could not start, and should excuse b2 from nothing.
 */
export function preventedBy(suite: Suite, name: string): readonly string[] {
  const entry = CONDITIONAL[name as keyof typeof CONDITIONAL]
  if (entry === undefined || entry.suite !== suite || entry.gate === undefined) return []

  const gates = STANDING[suite] as Record<string, readonly string[]>
  return gates[entry.gate] ?? []
}

/**
 * Every name the gate may report.
 *
 * A union rather than `string`, so an emitter naming something the registry
 * does not know is a mistake at the point it is written. There is no `tsc` in
 * this repository, so that is a guarantee for a reader and an editor rather
 * than for CI — which is why `isRegistered` checks the same thing at runtime.
 */
export type ScenarioName =
  | { [S in Suite]: GateNames<(typeof STANDING)[S]> }[Suite]
  | keyof typeof CONDITIONAL

/**
 * Every name in one suite's gates.
 *
 * Mapped over `Suite` above rather than indexed by it, and that is the whole
 * of the difference (issue #74). `STANDING[Suite]` is a *union* of three
 * differently-shaped objects, and `keyof` a union is the keys they share —
 * which for three suites with different gate names is none. So the standing
 * half of this type was `never`, every `SCENARIO["b2 passing"]` in the gates
 * was an index into a record that had no such key, and the union that is
 * supposed to make a typo a mistake where it is written contained only the
 * three conditional names.
 *
 * Nothing failed, because Bun strips types rather than checking them. The
 * registry's own comment says a union is used "so an emitter naming something
 * the registry does not know is a mistake at the point it is written"; for
 * the names it mostly exists to protect, it was not.
 */
type GateNames<T> = T[keyof T] extends readonly (infer Name)[] ? Name : never

const STANDING_NAMES: readonly string[] = SUITES.flatMap((suite) => standingOf(suite))

export const ALL_SCENARIOS: readonly string[] = [...STANDING_NAMES, ...CONDITIONAL_NAMES]

/** Whether this name is one the registry knows about at all. */
export function isRegistered(name: string): boolean {
  return ALL_SCENARIOS.includes(name)
}

/** Whether this name is one of the suite's standing checks. */
export function isStanding(suite: Suite, name: string): boolean {
  return (standingOf(suite) as readonly string[]).includes(name)
}

/** Every standing scenario the selected suites set out to run, in suite order. */
export function standingFor(selected: readonly Suite[]): ScenarioName[] {
  return selected.flatMap((suite) => [...standingOf(suite)])
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

    // A conditional naming a gate its suite does not have would prevent
    // nothing while looking as though it prevented something.
    const { suite, gate } = CONDITIONAL[name]
    if (gate !== undefined && !(gate in STANDING[suite])) {
      problems.push(`\`${name}\` names gate \`${gate}\`, which ${suite} does not have`)
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
