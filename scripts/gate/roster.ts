/**
 * What each suite sets out to verify (issue #58).
 *
 * A report lists the scenarios that ran. On a run that finished, that is the
 * whole story. On one that was interrupted it is half of it, and the missing
 * half is the part a reader actually needs: a gate that produced four results
 * out of eight and a gate that produced four out of four look identical, and
 * only one of them verified what it set out to.
 *
 * Absence cannot carry that. The report can only say a scenario was not
 * reached if something independently says it was expected, which is what this
 * is: the names each suite runs in its ordinary course, written down.
 *
 * A roster drifts, and a stale one is worse than none — it would name
 * scenarios that no longer exist as unreached, on every failed run. So a
 * completed suite that did not produce a name listed here reports the
 * discrepancy as a scenario of its own. It never fails the gate: a roster is
 * bookkeeping about the gate, not evidence about the tool, and the same
 * argument that keeps freshness drift report-only applies here.
 *
 * Not every scenario belongs here. `b1 host registration` and `b2 execution`
 * are failure paths that exist only when something has gone wrong, and
 * `--project` adds scenarios the standing gate does not run. Those are
 * reported as themselves when they happen and are absent the rest of the time,
 * which is correct and needs no roster entry.
 */

import type { Suite } from "./options.ts"

export const SUITE_ROSTER: Record<Suite, readonly string[]> = {
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
}

/** Every scenario the selected suites set out to run, in suite order. */
export function expectedScenarios(selected: readonly Suite[]): string[] {
  return selected.flatMap((suite) => [...SUITE_ROSTER[suite]])
}
