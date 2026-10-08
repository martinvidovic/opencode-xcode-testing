/**
 * The B1 registration checks, against a host that is not there (issue #142).
 *
 * On V2 the registration checks read what a model is offered, through the
 * stub provider. So the stand-in host here does what a real one does when
 * prompted: it sends the stub a model request carrying the tools it would
 * offer. Everything downstream — the stub's record, the checks, the order in
 * which they are published — is the production code.
 */

import { describe, expect, test } from "bun:test"

import { descriptionFor, TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { inspectInputSchema, recoverInputSchema, testInputSchema } from "../../src/adapter/schema.ts"
import type { HostClient } from "../../scripts/gate/host.ts"
import { newObservations, scenarioSink } from "../../scripts/gate/observations.ts"
import { startStubProvider, type StubProvider } from "../../scripts/gate/provider.ts"
import { effectiveEffect, registrationScenarios } from "../../scripts/gate/registration.ts"

type Tool = { name: string; description: string; parameters: unknown }

const SHIPPED: Tool[] = [
  { name: "xcode_test", description: descriptionFor("xcode_test"), parameters: testInputSchema },
  { name: "xcode_test_inspect", description: descriptionFor("xcode_test_inspect"), parameters: inspectInputSchema },
  { name: "xcode_test_recover", description: descriptionFor("xcode_test_recover"), parameters: recoverInputSchema },
]

/** A host that, when prompted, offers `tools` to the model at `stub`. */
function hostOffering(stub: StubProvider, tools: Tool[]): HostClient {
  return {
    session: {
      create: async () => ({ id: "session-1" }),
      prompt: async () => {
        await fetch(`${stub.baseURL}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stream: true,
            messages: [{ role: "user", content: "go" }],
            tools: tools.map((tool) => ({ type: "function", function: tool })),
          }),
        }).then((response) => response.text())
      },
      wait: async () => undefined,
      context: async () => [],
    },
  } as unknown as HostClient
}

async function scenariosFor(tools: Tool[]) {
  const stub = startStubProvider()
  try {
    const observed = newObservations("2026-10-08T00:00:00.000Z")
    await registrationScenarios(hostOffering(stub, tools), stub, "/project", scenarioSink(observed))
    return observed.scenarios.map((scenario) => [scenario.name, scenario.status])
  } finally {
    stub.stop()
  }
}

describe("the registration checks", () => {
  test("pass when the model is offered the family as shipped", async () => {
    expect(await scenariosFor([...SHIPPED, { name: "read", description: "Read", parameters: {} }])).toEqual([
      ["b1 tool ids register", "passed"],
      ["b1 tool descriptions", "passed"],
      ["b1 parameter schemas", "passed"],
    ])
  })

  test("fail, and still publish every check, when nothing is offered", async () => {
    expect(await scenariosFor([])).toEqual([
      ["b1 tool ids register", "failed"],
      ["b1 tool descriptions", "failed"],
      ["b1 parameter schemas", "failed"],
    ])
  })

  test("catch a description that is not the shipped sidecar", async () => {
    const drifted = SHIPPED.map((tool) => (tool.name === "xcode_test" ? { ...tool, description: "Runs tests." } : tool))
    expect(await scenariosFor(drifted)).toContainEqual(["b1 tool descriptions", "failed"])
  })

  test("catch a schema that made an optional argument required", async () => {
    const required = SHIPPED.map((tool) =>
      tool.name === "xcode_test" ? { ...tool, parameters: { ...testInputSchema, required: ["scope", "destination"] } } : tool,
    )
    expect(await scenariosFor(required)).toContainEqual(["b1 parameter schemas", "failed"])
  })

  test("name every missing tool", async () => {
    const stub = startStubProvider()
    try {
      const observed = newObservations("2026-10-08T00:00:00.000Z")
      await registrationScenarios(hostOffering(stub, SHIPPED.slice(0, 1)), stub, "/project", scenarioSink(observed))
      const detail = observed.scenarios[0]?.detail ?? ""
      for (const id of TOOL_IDS.slice(1)) expect(detail).toContain(id)
    } finally {
      stub.stop()
    }
  })
})

describe("an effective permission, as V2 decides it", () => {
  const RESTRICTED = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "*", resource: "*", effect: "deny" },
    { action: "xcode_test", resource: "*", effect: "allow" },
  ]

  test("is the last matching rule", () => {
    expect(effectiveEffect(RESTRICTED, "xcode_test")).toBe("allow")
    expect(effectiveEffect(RESTRICTED, "shell")).toBe("deny")
  })

  test("ignores rules about narrower resources", () => {
    expect(effectiveEffect(RESTRICTED, "read")).toBe("deny")
  })

  test("matches wildcard actions as whole values", () => {
    const rules = [{ action: "xcode_*", resource: "*", effect: "deny" }]
    expect(effectiveEffect(rules, "xcode_test_recover")).toBe("deny")
    expect(effectiveEffect(rules, "my_xcode_test")).toBeUndefined()
  })
})
