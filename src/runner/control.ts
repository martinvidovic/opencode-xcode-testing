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
  containmentRoot: string
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

/**
 * The largest encoded frame either side will accept (issue #127).
 *
 * Both ends decode by accumulating whatever arrives until a newline turns up.
 * Without a bound that is a buffer somebody else's writes decide the size of:
 * a peer that never sends a newline grows it until the process dies, and the
 * process it kills is the one holding a detached `xcodebuild` group's
 * deadline and its only route to a terminal outcome.
 *
 * The buffer it bounds is this plus one read, not this exactly: a chunk is
 * appended before it can be measured, and a stream hands over as much as its
 * own high-water mark allows. Said precisely because "bounded" is the whole
 * claim, and a claim that is out by a factor is one somebody will rely on.
 *
 * The bound is on the whole protocol rather than per message type, because
 * the check has to happen before anything is parsed — which is exactly when
 * the type is not yet known. 64 KiB is two orders above the largest frame
 * this protocol has: a `hello` carries two directory paths, a command, its
 * arguments and a small environment, and measures a few hundred bytes.
 */
export const MAX_FRAME_BYTES = 64 * 1024

export function encodeMessage(message: ControlMessage): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Decode whole newline-delimited frames, returning any trailing partial frame
 * for the next read. A frame that is not one of the fixed messages is dropped
 * and reported, never guessed at.
 *
 * Nothing longer than `MAX_FRAME_BYTES` is parsed or carried (issue #127).
 * An oversized complete frame is rejected on its size, before `JSON.parse`
 * ever sees it — parsing it to find out whether it was legitimate would be
 * doing the unbounded work the bound exists to refuse. An oversized *partial*
 * frame is dropped along with the rest of the buffer, and `overflowed` says
 * so: the caller cannot resynchronize on a stream whose framing it has
 * already lost, and pretending otherwise would mean interpreting the tail of
 * something as the whole of something else.
 */
export function decodeMessages(buffer: string): {
  messages: ControlMessage[]
  rejected: number
  rest: string
  overflowed: boolean
} {
  const parts = buffer.split("\n")
  const rest = parts.pop() ?? ""
  const messages: ControlMessage[] = []
  let rejected = 0

  for (const part of parts) {
    // Size first: a frame past the bound is refused on that alone, whatever
    // it turns out to contain. Checking emptiness first would let an
    // oversized run of whitespace pass as nothing rather than be counted as
    // the protocol violation it is.
    if (oversized(part)) {
      rejected += 1
      continue
    }
    if (part.trim().length === 0) continue
    const message = parseMessage(part)
    if (message === undefined) rejected += 1
    else messages.push(message)
  }

  if (oversized(rest)) return { messages, rejected: rejected + 1, rest: "", overflowed: true }
  return { messages, rejected, rest, overflowed: false }
}

/**
 * Whether a frame is past the bound, in encoded bytes.
 *
 * The length check first because it is the common case and free: a UTF-8
 * encoding is never shorter than the string's own code units, so a string
 * inside the bound by length is inside it by bytes as well.
 */
function oversized(frame: string): boolean {
  return frame.length > MAX_FRAME_BYTES || Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES
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
