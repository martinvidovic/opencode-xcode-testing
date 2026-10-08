/**
 * One scripted model turn against an isolated V2 host (issue #142).
 *
 * Both execution-bearing suites need the same thing: open a session in a
 * Location under a chosen agent, let the stub provider make at most one
 * scripted call, wait for the session to settle, and read back two facts —
 * what the model was offered, and what the tool answered.
 *
 * What the model was offered comes from the stub, because no client route
 * lists a Location's tools on V2 (issue #140); it is the host's own rendering
 * of names, descriptions and schemas under the agent's effective permissions.
 * What the tool answered comes from `session.context`, which is what the
 * session actually recorded — including the host's own `truncated` flag,
 * which is the direct evidence that host truncation was or was not reached.
 */

import { bounded, TURN_MS, type HostClient } from "./host.ts"
import { STUB_MODEL_ID, STUB_PROVIDER_ID, type OfferedTool, type ScriptedCall, type StubProvider } from "./provider.ts"

export type ToolAnswer = {
  status: string
  /** The text content the model received, or the error message it was given. */
  text: string
  /** The host's own flag: true when it truncated the output. */
  truncated: boolean
}

export type TurnResult = {
  /** The tools the first tool-bearing request offered, or `undefined` if none did. */
  offered: OfferedTool[] | undefined
  /** The scripted tool's recorded answer, when a call was scripted and made. */
  answer?: ToolAnswer
}

export async function scriptedTurn(
  client: HostClient,
  stub: StubProvider,
  input: { directory: string; agent?: string; call?: ScriptedCall },
): Promise<TurnResult> {
  const mark = stub.mark()
  if (input.call !== undefined) stub.script(input.call)

  const session = await bounded(
    "session.create",
    client.session.create({
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID },
      location: { directory: input.directory },
    }),
  )

  await bounded("session.prompt", client.session.prompt({ sessionID: session.id, text: "run the scripted call" }))
  await bounded("session.wait", client.session.wait({ sessionID: session.id }), TURN_MS)

  const offered = stub.offeredSince(mark)
  if (input.call === undefined) return { offered }

  const messages = await bounded("session.context", client.session.context({ sessionID: session.id }))
  const answer = toolAnswer(messages, input.call.tool)
  return answer === undefined ? { offered } : { offered, answer }
}

/** The recorded state of the first call to `tool` in a session's messages. */
export function toolAnswer(messages: ReadonlyArray<unknown>, tool: string): ToolAnswer | undefined {
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue

    for (const part of content as Array<Record<string, unknown>>) {
      if (part["type"] !== "tool" || part["name"] !== tool) continue
      const state = (part["state"] ?? {}) as {
        status?: unknown
        content?: unknown
        error?: { message?: unknown }
        metadata?: { truncated?: unknown }
      }
      return {
        status: String(state.status ?? "unknown"),
        text: textOf(state.content) ?? String(state.error?.message ?? ""),
        truncated: state.metadata?.truncated === true,
      }
    }
  }
  return undefined
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  return content
    .map((part) => ((part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("")
}
