/**
 * A local OpenAI-compatible stub provider (ADR 0002, (b2)).
 *
 * Tool execution in the host requires a real model turn, and there is no
 * built-in stub model provider — so the gate supplies one. It emits **scripted**
 * tool calls rather than deciding anything, which makes the whole execution
 * layer deterministic, credential-free and offline.
 *
 * The package it is configured through is installed by the host into its own
 * config directory as test infrastructure. It is not a repository dependency,
 * so the zero-dependency rule is untouched.
 */

export const STUB_PROVIDER_ID = "stub"
export const STUB_MODEL_ID = "stub-model"
export const STUB_NPM = "@ai-sdk/openai-compatible"

export type ScriptedCall = { tool: string; args: unknown }

export type StubProvider = {
  /** The port the kernel assigned, and what `baseURL` is built from. */
  readonly port: number
  baseURL: string
  /** What the next turn should call. Cleared once emitted. */
  script(call: ScriptedCall): void
  /** Turns served so far, so a scenario can prove a turn actually happened. */
  readonly turns: number
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

      const body = (await request.json()) as { stream?: boolean }
      turns += 1

      // The first turn after a script emits the call; every turn after it just
      // ends the conversation, so a scenario is exactly one tool invocation.
      const call = pending
      pending = undefined

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

/** The provider block the host needs to reach the stub. */
export function stubProviderConfig(baseURL: string): Record<string, unknown> {
  return {
    [STUB_PROVIDER_ID]: {
      npm: STUB_NPM,
      name: "Acceptance gate stub",
      options: { baseURL, apiKey: "stub" },
      models: { [STUB_MODEL_ID]: { name: "Scripted" } },
    },
  }
}
