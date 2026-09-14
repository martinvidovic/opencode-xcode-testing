/**
 * The registration checks, when the host stops answering (issue #58).
 *
 * This suite ordinarily needs a real OpenCode process, which is why it belongs
 * to Layer 4 and not to `bun test`. But the property that matters here needs
 * only a client: `tool.list` is a second round trip to a host that is still
 * booting, it sits between the first check and the last two, and the question
 * is what has already been published when it does not come back.
 *
 * Collected and returned, the answer was nothing — the first check, already
 * decided and already true, went down with the round trip that followed it.
 * A machine that registered its tools correctly reported that it had not been
 * asked.
 */

import { describe, expect, test } from "bun:test"

import { TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { registrationScenarios } from "../../scripts/gate/registration.ts"
import { newObservations, scenarioSink } from "../../scripts/gate/observations.ts"

/**
 * A host that answers the first two calls and then stops.
 *
 * `tool.list` rejects, which is what a host still coming up actually does —
 * and the one place in this function where an already-decided result could be
 * lost.
 */
function clientThatStopsAnswering(): unknown {
  return {
    session: { create: async () => ({ data: { id: "session-1" } }) },
    tool: {
      ids: async () => ({ data: [...TOOL_IDS] }),
      list: async () => {
        throw new Error("the host did not answer")
      },
    },
  }
}

/** A host that answers everything, with tools that match their sidecars. */
function clientThatAnswers(): unknown {
  return {
    session: { create: async () => ({ data: { id: "session-1" } }) },
    tool: {
      ids: async () => ({ data: [...TOOL_IDS] }),
      list: async () => ({ data: [] }),
    },
  }
}

describe("a registration run interrupted between its checks", () => {
  test("has already published the check it decided before the interruption", async () => {
    const observed = newObservations("2026-09-14T01:00:00.000Z")
    const record = scenarioSink(observed)

    await expect(
      registrationScenarios(clientThatStopsAnswering() as never, "/project", record),
    ).rejects.toThrow()

    // The result is in the report, not in a list that was never returned.
    expect(observed.scenarios.map((scenario) => scenario.name)).toEqual([
      "b1 tool ids register",
    ])
    expect(observed.scenarios[0]?.status).toBe("passed")
  })

  test("publishes the tool-id check before it asks the host anything else", async () => {
    // Ordering, stated directly. The check is decided from `tool.ids`, and
    // nothing between deciding it and recording it may be able to fail.
    const seen: string[] = []
    const observed = newObservations("2026-09-14T01:00:00.000Z")

    const client = {
      session: { create: async () => ({ data: { id: "session-1" } }) },
      tool: {
        ids: async () => ({ data: [...TOOL_IDS] }),
        list: async () => {
          seen.push("tool.list")
          throw new Error("the host did not answer")
        },
      },
    }

    await expect(
      registrationScenarios(client as never, "/project", (scenario) => {
        seen.push(scenario.name)
      }),
    ).rejects.toThrow()

    expect(seen).toEqual(["b1 tool ids register", "tool.list"])
  })

  test("publishes every check when the host answers throughout", async () => {
    // The other direction, so the tests above cannot pass by publishing one
    // thing and giving up.
    const observed = newObservations("2026-09-14T01:00:00.000Z")

    await registrationScenarios(
      clientThatAnswers() as never,
      "/project",
      scenarioSink(observed),
    )

    expect(observed.scenarios.map((scenario) => scenario.name)).toEqual([
      "b1 tool ids register",
      "b1 tool descriptions",
      "b1 parameter schemas",
    ])
  })
})
