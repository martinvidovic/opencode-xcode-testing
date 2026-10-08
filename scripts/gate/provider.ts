/**
 * A local OpenAI-compatible stub provider (ADR 0002 (b2), issue #142).
 *
 * Tool execution in the host requires a real model turn, and there is no
 * built-in stub model provider — so the gate supplies one. It emits **scripted**
 * tool calls rather than deciding anything, which makes the whole execution
 * layer deterministic, credential-free and offline.
 *
 * On V2 it is also the gate's witness. The client has no route that lists a
 * Location's tools, so the `tools` array of each request is the record of what
 * the host offered a model under that agent's effective permissions (issue
 * #140) — names, descriptions and parameter schemas exactly as rendered.
 *
 * It is configured through `@opencode/ai/providers/openai-compatible`, which
 * the V2 host bundles: nothing is downloaded and nothing is a repository
 * dependency.
 */

export const STUB_PROVIDER_ID = "stub"
export const STUB_MODEL_ID = "stub-model"
export const STUB_PACKAGE = "@opencode/ai/providers/openai-compatible"

export type ScriptedCall = { tool: string; args: unknown }

/** One tool as a model request described it. */
export type OfferedTool = { name: string; description?: string; parameters?: unknown }

export type StubProvider = {
  /** The port the kernel assigned, and what `baseURL` is built from. */
  readonly port: number
  baseURL: string
  /** What the next turn that can make a call should call. Cleared once emitted. */
  script(call: ScriptedCall): void
  /** Turns served so far, so a scenario can prove a turn actually happened. */
  readonly turns: number
  /** A position in the request log, for `offeredSince`. */
  mark(): number
  /**
   * The tools offered by the first tool-bearing request after `mark`, or
   * `undefined` if none has arrived. Tool-less requests — a session's title
   * generation, an agent with nothing allowed — are skipped, not reported.
   */
  offeredSince(mark: number): OfferedTool[] | undefined
  stop(): void
}

/**
 * Start the stub provider on a port the kernel chooses (issue #125).
 *
 * `port: 0`, and then whatever came back. A fixed number is one a killed
 * invocation can still be holding, and this server refuses a held port
 * outright — so the suite does not start at all, for a reason reported
 * nowhere near where anyone would look for it. Asking the kernel removes the
 * question rather than answering it.
 */
export function startStubProvider(): StubProvider {
  let pending: ScriptedCall | undefined
  let turns = 0
  const offered: OfferedTool[][] = []

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: STUB_MODEL_ID, object: "model" }] })
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 })
      }

      const body = (await request.json()) as {
        stream?: boolean
        tools?: Array<{ function?: { name?: unknown; description?: unknown; parameters?: unknown } }>
        messages?: Array<{ role?: unknown }>
      }
      turns += 1

      const tools = (body.tools ?? []).map(offeredTool)
      offered.push(tools)

      // The scripted call goes to the first request that can make it: one
      // that offers tools and is not already answering a tool result. A new
      // session's first request is a tool-less title generation, and spending
      // the script there would leave the real turn with nothing to do — so a
      // scenario is still exactly one tool invocation.
      const answering = body.messages?.at(-1)?.role === "tool"
      const call = tools.length > 0 && !answering ? pending : undefined
      if (call !== undefined) pending = undefined

      if (body.stream === false) {
        return Response.json({
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: 1,
          model: STUB_MODEL_ID,
          choices: [
            { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
          ],
        })
      }

      const frames =
        call === undefined
          ? [chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")]
          : [
              chunk(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${turns}`,
                      type: "function",
                      function: { name: call.tool, arguments: JSON.stringify(call.args) },
                    },
                  ],
                },
                null,
              ),
              chunk({}, "tool_calls"),
            ]

      return new Response(`${frames.join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })

  // The port it bound, not the one it asked for — and it has to have one: a
  // provider nothing can address is a suite that fails for a reason nobody
  // would look for.
  const port = server.port
  if (port === undefined) throw new Error("the stub provider bound no port")

  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    script(call) {
      pending = call
    },
    get turns() {
      return turns
    },
    mark() {
      return offered.length
    },
    offeredSince(mark) {
      return offered.slice(mark).find((tools) => tools.length > 0)
    },
    stop() {
      server.stop(true)
    },
  }
}

function chunk(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-stub",
    object: "chat.completion.chunk",
    created: 1,
    model: STUB_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function offeredTool(tool: { function?: { name?: unknown; description?: unknown; parameters?: unknown } }): OfferedTool {
  const fn = tool.function ?? {}
  return {
    name: String(fn.name),
    ...(typeof fn.description === "string" ? { description: fn.description } : {}),
    ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }),
  }
}

/** The V2 `providers` block the host needs to reach the stub. */
export function stubProviderConfig(baseURL: string): Record<string, unknown> {
  return {
    [STUB_PROVIDER_ID]: {
      name: "Acceptance gate stub",
      package: STUB_PACKAGE,
      settings: { baseURL, apiKey: "stub" },
      models: { [STUB_MODEL_ID]: { name: "Scripted" } },
    },
  }
}
