/**
 * The roster names scenarios that exist (issue #58).
 *
 * `SUITE_ROSTER` is what lets a report say a scenario was *not reached* rather
 * than leaving it merely absent, and it works by repeating names that are also
 * string literals in the suite files. That is duplication by construction, and
 * the failure mode is quiet: rename a scenario and the roster goes on naming
 * the old one as unreached on every failed report, for ever, while the new one
 * is never accounted for at all.
 *
 * The gate itself notices — a suite that ran cleanly and did not produce a
 * rostered name reports the discrepancy — but only on a machine with Xcode and
 * a host, which is to say not on the run where the rename happened. This is
 * the same check without either: read the suite files as text, and require
 * each rostered name to appear in one of them.
 *
 * Source text rather than execution, for the same reason `import-lint` and
 * `hygiene-lint` are source-text lints: it has to hold over a tree nobody can
 * run, and it must not need a host.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { SUITE_ROSTER } from "../../scripts/gate/roster.ts"
import { SUITES } from "../../scripts/gate/options.ts"

const GATE_DIR = join(import.meta.dir, "..", "..", "scripts", "gate")

/** Which files may emit each suite's scenarios. */
const SUITE_SOURCES: Record<string, readonly string[]> = {
  layer4: ["layer4.ts"],
  b1: ["registration.ts", "installation.ts"],
  b2: ["execution.ts"],
}

function sourceOf(suite: string): string {
  return (SUITE_SOURCES[suite] ?? [])
    .map((file) => readFileSync(join(GATE_DIR, file), "utf8"))
    .join("\n")
}

describe("every name the roster expects", () => {
  for (const suite of SUITES) {
    test(`is a scenario ${suite} can actually emit`, () => {
      const source = sourceOf(suite)
      const absent = SUITE_ROSTER[suite].filter((name) => !source.includes(`"${name}"`))

      // Named rather than counted: the point of failing is to say which.
      expect(absent).toEqual([])
    })
  }

  test("covers every suite, so a new one cannot arrive without a roster", () => {
    // `Record<Suite, …>` already forces this at the type level, and nothing
    // here type-checks — the repo ships no `tsc` — so it is worth one runtime
    // assertion rather than a guarantee that exists only in principle.
    for (const suite of SUITES) {
      expect(SUITE_ROSTER[suite].length).toBeGreaterThan(0)
      expect(SUITE_SOURCES[suite]).toBeDefined()
    }
  })
})
