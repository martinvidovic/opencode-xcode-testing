/**
 * The supervisor control protocol (#3).
 *
 * The channel is private and inherited, and its handshake secret travels
 * through that channel — never a command-line argument, an environment
 * variable, or persisted plaintext metadata, all of which are readable by other
 * processes on the machine. Only the fixed message set below is accepted; an
 * unrecognized frame is a protocol violation, not something to interpret.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"

export type ControlMessage =
  | { type: "hello"; secret: string }
  | { type: "ready"; runId: string }
  | { type: "state"; state: string }
  | { type: "cancel" }
  | { type: "completed"; exitCode?: number; signal?: string }

const MESSAGE_TYPES = new Set(["hello", "ready", "state", "cancel", "completed"])

export function newChannelSecret(): string {
  return randomBytes(32).toString("base64url")
}

/** Constant-time, so a wrong secret cannot be discovered one byte at a time. */
export function secretMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(received, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

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

/**
 * Channel loss is only a trigger when nothing has fixed one already: a channel
 * that dropped while a cancelled run was being torn down does not change the
 * fact that the caller cancelled it.
 */
export function channelLossIsTrigger(alreadyFixed: boolean): boolean {
  return !alreadyFixed
}
