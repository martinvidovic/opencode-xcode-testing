/**
 * The B1 registration and installation gates are independent (issue #70).
 *
 * These tests drive the orchestration seam with controlled peer gates. Real
 * OpenCode startup remains an acceptance-gate responsibility.
 */

import { describe, expect, test } from "bun:test"

import { runB1Suite, type B1Gates } from "../../scripts/gate/b1.ts"
import { DrivenRoots } from "../../scripts/gate/driven-roots.ts"
import type { ScenarioResult } from "../../scripts/gate/report.ts"

async function runB1WithGates(
  gates: (record: (scenario: ScenarioResult) => void) => B1Gates,
): Promise<ScenarioResult[]> {
  const scenarios: ScenarioResult[] = []
  const record = (scenario: ScenarioResult) => scenarios.push(scenario)
  await runB1Suite(record, new DrivenRoots(), gates(record))
  return scenarios
}

describe("a B1 run with a reported registration failure", () => {
  test("runs the independent installation check afterwards", async () => {
    const calls: string[] = []
    const scenarios = await runB1WithGates((record) => ({
      async registration() {
        calls.push("registration")
        record({
          name: "b1 host registration",
          kind: "gating",
          status: "failed",
          detail: "the host SDK was not available",
        })
      },
      async installation() {
        calls.push("installation")
        record({
          name: "b1 documented installation path",
          kind: "gating",
          status: "passed",
          detail: "the documented installation path worked",
        })
      },
    }))

    expect(calls).toEqual(["registration", "installation"])
    expect(scenarios.map((scenario) => [scenario.name, scenario.status])).toEqual([
      ["b1 host registration", "failed"],
      ["b1 documented installation path", "passed"],
    ])
  })
})

describe("a B1 run whose registration gate ends unexpectedly", () => {
  test("still runs the independent installation check", async () => {
    const calls: string[] = []
    const scenarios = await runB1WithGates((record) => ({
      async registration() {
        calls.push("registration")
        throw new Error("unexpected registration failure")
      },
      async installation() {
        calls.push("installation")
        record({
          name: "b1 documented installation path",
          kind: "gating",
          status: "passed",
          detail: "the documented installation path worked",
        })
      },
    }))

    expect(calls).toEqual(["registration", "installation"])
    expect(scenarios).toMatchObject([
      {
        name: "b1 host registration",
        status: "failed",
        detail: "the registration gate ended unexpectedly: Error: unexpected registration failure",
      },
      {
        name: "b1 documented installation path",
        status: "passed",
      },
    ])
  })
})
