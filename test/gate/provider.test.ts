/**
 * The scripted model provider, as the V2 gates use it (issue #142).
 *
 * The V2 client has no route that lists a Location's tools, so the request a
 * model receives is the evidence: its `tools` array is exactly what the host
 * offered, under the agent's effective permissions (issue #140). The stub is
 * therefore both the thing that drives a tool call and the witness of what
 * could be called.
 */

import { describe, expect, test } from "bun:test"

import { startStubProvider, stubProviderConfig, STUB_MODEL_ID, STUB_PROVIDER_ID } from "../../scripts/gate/provider.ts"

type Chunk = { choices: Array<{ delta: { tool_calls?: Array<{ function: { name: string } }> } }> }

async function turn(baseURL: string, tools: string[], last: "user" | "tool" = "user"): Promise<string[]> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: last, content: "go" }],
      tools: tools.map((name) => ({
        type: "function",
        function: { name, description: `${name} does things`, parameters: { type: "object" } },
      })),
    }),
  })
  const text = await response.text()
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .flatMap((line) => (JSON.parse(line.slice(6)) as Chunk).choices[0]?.delta.tool_calls ?? [])
    .map((call) => call.function.name)
}

describe("the stub provider", () => {
  test("is configured the V2 way, through the host's bundled compatible runtime", () => {
    const config = stubProviderConfig("http://127.0.0.1:1/v1")[STUB_PROVIDER_ID] as Record<string, unknown>
    expect(config["package"]).toBe("@opencode/ai/providers/openai-compatible")
    expect(config["settings"]).toEqual({ baseURL: "http://127.0.0.1:1/v1", apiKey: "stub" })
    expect(Object.keys(config["models"] as object)).toEqual([STUB_MODEL_ID])
  })

  test("keeps its scripted call for a request that can actually make it", async () => {
    // A new session's first request is a tool-less title generation. Emitting
    // the scripted call there would spend it on a request that cannot run it.
    const stub = startStubProvider()
    try {
      stub.script({ tool: "xcode_test", args: {} })
      expect(await turn(stub.baseURL, [])).toEqual([])
      expect(await turn(stub.baseURL, ["xcode_test"])).toEqual(["xcode_test"])
      expect(await turn(stub.baseURL, ["xcode_test"], "tool")).toEqual([])
    } finally {
      stub.stop()
    }
  })

  test("records what each request offered, as the host described it", async () => {
    const stub = startStubProvider()
    try {
      const mark = stub.mark()
      await turn(stub.baseURL, [])
      await turn(stub.baseURL, ["xcode_test", "xcode_test_inspect"])

      const offered = stub.offeredSince(mark)
      expect(offered?.map((tool) => tool.name)).toEqual(["xcode_test", "xcode_test_inspect"])
      expect(offered?.[0]).toEqual({
        name: "xcode_test",
        description: "xcode_test does things",
        parameters: { type: "object" },
      })
    } finally {
      stub.stop()
    }
  })

  test("says nothing was offered rather than reporting an earlier request", async () => {
    const stub = startStubProvider()
    try {
      await turn(stub.baseURL, ["xcode_test"])
      expect(stub.offeredSince(stub.mark())).toBeUndefined()
    } finally {
      stub.stop()
    }
  })
})
