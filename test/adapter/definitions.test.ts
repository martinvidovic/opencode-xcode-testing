/**
 * The V2 tool definitions (issue #141).
 *
 * What `plugin.ts` hands to `ctx.tool.transform`, built and exercised here
 * with no host. Each property below is one a verified host fact makes
 * load-bearing (issue #140):
 *
 * - the effective name **is** the permission action, so a namespace would
 *   silently rename every key an agent allowlists;
 * - a tool left in Code Mode is offered to a model only through `execute`, so
 *   a restricted agent with `execute` denied would see no Test Tool at all;
 * - the model receives the text content of the result, so the renderer's
 *   output has to arrive there unchanged.
 */

import { describe, expect, test } from "bun:test"

import { toolDefinitions } from "../../src/adapter/definitions.ts"
import { descriptionFor, TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { inspectInputSchema, recoverInputSchema, testInputSchema } from "../../src/adapter/schema.ts"
import { PROTOCOL_STATES, type AdmittedRun, type TestToolService, type ToolDeps } from "../../src/adapter/tools.ts"
import { RESOLVED } from "../interpreter/harness.ts"
import { interpretFixture } from "../interpreter/harness.ts"

const ADMITTED: AdmittedRun = {
  runId: "0f8a2c",
  resolved: RESOLVED,
  admittedAt: "2026-09-13T10:00:00.000Z",
  queueDurationMs: 12,
}

function deps(service: Partial<TestToolService> = {}, overrides: Partial<ToolDeps> = {}): ToolDeps {
  let clock = 0
  return {
    service: {
      start: () => ({ admitted: Promise.resolve(ADMITTED), result: new Promise(() => {}) }),
      inspect: async () => ({ status: "notFound", subject: "run" }),
      recover: async () => ({ status: "alreadyHealthy" }),
      ...service,
    },
    now: () => (clock += 10),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timestamp: () => "2026-09-13T10:00:00.000Z",
    ...overrides,
  }
}

function byName(name: string, overrides?: ToolDeps) {
  const definition = toolDefinitions(overrides ?? deps()).find((tool) => tool.name === name)
  if (definition === undefined) throw new Error(`no definition named ${name}`)
  return definition
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("")
}

describe("the registered surface", () => {
  test("is exactly the three separately-deniable tool ids", () => {
    expect(toolDefinitions(deps()).map((tool) => tool.name)).toEqual([...TOOL_IDS])
  })

  test("adds no namespace, so the permission action is the bare id", () => {
    for (const tool of toolDefinitions(deps())) {
      expect(tool.options).not.toHaveProperty("namespace")
      expect(tool.options).not.toHaveProperty("permission")
    }
  })

  test("keeps every tool out of Code Mode, so a restricted agent is offered it directly", () => {
    for (const tool of toolDefinitions(deps())) expect(tool.options.codemode).toBe(false)
  })

  test("carries each tool's description and input schema", () => {
    expect(byName("xcode_test").description).toBe(descriptionFor("xcode_test"))
    expect(byName("xcode_test").input).toBe(testInputSchema)
    expect(byName("xcode_test_inspect").input).toBe(inspectInputSchema)
    expect(byName("xcode_test_recover").input).toBe(recoverInputSchema)
  })
})

describe("results", () => {
  test("wrap the rendered summary as structured text content", async () => {
    const { summary } = await interpretFixture("passed")
    const service: Partial<TestToolService> = {
      start: () => ({ admitted: Promise.resolve(ADMITTED), result: Promise.resolve(summary) }),
    }
    const result = await byName("xcode_test", deps(service)).execute({ scope: { kind: "all" } }, {})

    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type).toBe("text")
    expect(text(result)).toContain("passed")
    expect(text(result)).toMatch(/run\s+run-0000/)
  })

  test("carry no metadata, so nothing private rides along beside the text", async () => {
    const result = await byName("xcode_test_recover").execute({}, {})
    expect(Object.keys(result)).toEqual(["content"])
    expect(text(result).length).toBeGreaterThan(0)
  })

  test("render a domain outcome as an ordinary result rather than a throw", async () => {
    const result = await byName("xcode_test_inspect").execute({ runId: "0f8a2c", facet: "failures" }, {})
    expect(text(result)).toContain("notFound")
  })
})

describe("the host context", () => {
  test("forwards progress, so durable protocol states reach the host", async () => {
    const { summary } = await interpretFixture("passed")
    const seen: Array<Record<string, unknown>> = []
    const service: Partial<TestToolService> = {
      start(_request, callbacks) {
        for (const state of PROTOCOL_STATES) callbacks.onState(state)
        return { admitted: Promise.resolve(ADMITTED), result: Promise.resolve(summary) }
      },
    }

    await byName("xcode_test", deps(service)).execute(
      { scope: { kind: "all" } },
      { progress: async (update) => void seen.push(update) },
    )

    expect(seen.map((entry) => entry["state"])).toEqual(expect.arrayContaining([...PROTOCOL_STATES]))
    expect(seen.some((entry) => entry["runId"] === ADMITTED.runId)).toBe(true)
  })

  test("forwards an abort that lands before the run starts listening", async () => {
    // A signal aborts once and does not replay. If the run only starts
    // listening after its first await, an interrupt in that window must still
    // reach the supervisor — otherwise the model is told `cancelled` while
    // xcodebuild carries on.
    const controller = new AbortController()
    let cancelled = false
    const service: Partial<TestToolService> = {
      start(_request, _callbacks, cancellation) {
        void cancellation?.whenAborted.then(() => (cancelled = true))
        return { admitted: Promise.resolve(ADMITTED), result: new Promise(() => {}) }
      },
    }

    const pending = byName("xcode_test", deps(service, { abortWaitMs: 20 })).execute(
      { scope: { kind: "all" } },
      { signal: controller.signal },
    )
    controller.abort()
    const result = await pending

    expect(cancelled).toBe(true)
    expect(text(result)).toContain("Test Run cancelled")
  })
})
