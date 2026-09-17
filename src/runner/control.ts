/**
 * The supervisor control protocol (#3).
 *
 * **Possession of the inherited pipe endpoint is the authentication.** The
 * descriptors are created by the adapter and inherited by the process it
 * spawns; nothing else on the machine holds them, and a process that does not
 * hold one cannot send a frame at all. That is the whole boundary, and it is
 * why the invocation travels through the channel rather than through a
 * command line, an environment variable or persisted metadata — all of which
 * other processes can read.
 *
 * The protocol carried a generated secret once, and it authenticated nothing
 * (#115): it arrived inside the same frame it was supposed to vouch for, so
 * every frame carried its own credential. What the protocol does enforce is
 * sequencing — a `cancel` before a valid `hello` is about no run this process
 * knows of, and is dropped. Only the fixed message set below is accepted; an
 * unrecognized frame is a protocol violation, not something to interpret.
 */

/**
 * The launch spec travels with the handshake, so the two are inseparable.
 * Typed here rather than asserted at each end: a frame the adapter writes and
 * the supervisor reads is a shared contract, not a private shape.
 */
export type LaunchSpec = {
  homeDir: string
  trustedRoot: string
  runId: string
  command: string
  args: string[]
  environment: Record<string, string>
  developerDirectory: string
}

export type ControlMessage =
  | ({ type: "hello" } & LaunchSpec)
  | { type: "ready"; runId: string }
  | { type: "state"; state: string }
  | { type: "cancel" }
  | { type: "completed"; exitCode?: number; signal?: string }

const MESSAGE_TYPES = new Set(["hello", "ready", "state", "cancel", "completed"])

export function encodeMessage(message: ControlMessage): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Decode whole newline-delimited frames, returning any trailing partial frame
 * for the next read. A frame that is not one of the fixed messages is dropped
 * and reported, never guessed at.
 */
export function decodeMessages(buffer: string): {
  messages: ControlMessage[]
  rejected: number
  rest: string
} {
  const parts = buffer.split("\n")
  const rest = parts.pop() ?? ""
  const messages: ControlMessage[] = []
  let rejected = 0

  for (const part of parts) {
    if (part.trim().length === 0) continue
    const message = parseMessage(part)
    if (message === undefined) rejected += 1
    else messages.push(message)
  }

  return { messages, rejected, rest }
}

function parseMessage(line: string): ControlMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const type = (parsed as { type?: unknown }).type
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) return undefined
  return parsed as ControlMessage
}

