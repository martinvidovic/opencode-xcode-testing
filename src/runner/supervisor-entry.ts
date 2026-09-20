/**
 * The supervisor entrypoint.
 *
 * This is the process the adapter spawns through the resolved runtime, and it
 * imports only `domain` and `runner` code — never adapter code. It has to
 * outlive the adapter call that started it: OpenCode may disappear while
 * `xcodebuild` is still running, and a supervisor that had been linked to the
 * adapter's module graph would be a supervisor that dies with it.
 *
 * Everything it needs arrives over the private inherited control channel, so
 * no invocation detail is ever visible in `ps` output or the environment.
 * Holding that channel's endpoint is what authenticates the adapter to this
 * process (see `control.ts`).
 */

import { createReadStream, createWriteStream } from "node:fs"
import { join } from "node:path"

import { monotonicNow } from "../domain/clock.ts"
import { decodeMessages, encodeMessage, type LaunchSpec } from "./control.ts"
import { spawnGatedChild } from "./gate.ts"
import { systemProbe } from "./identity.ts"
import { isRunId, RUN_ARTIFACTS, runDirectory, storageFor, type Storage } from "./paths.ts"
import { readRunRecord, type RunRecord } from "./state.ts"
import { superviseRun } from "./supervisor.ts"

/** The inherited descriptors the adapter sets up before spawning. */
export const CONTROL_READ_FD = 3
export const CONTROL_WRITE_FD = 4

/** Exit statuses the adapter distinguishes. */
export const EXIT_OK = 0
export const EXIT_PROTOCOL = 70

export type SupervisorLaunchSpec = LaunchSpec

/**
 * One reader for the whole channel.
 *
 * The handshake and the later cancellation arrive on the same descriptor, so
 * they are served by the same reader — two streams over one fd would race for
 * the same bytes, and whichever lost would wait forever for a message the other
 * had already consumed.
 */
class ControlChannel {
  readonly #stream = createReadStream("", { fd: CONTROL_READ_FD })
  readonly #writer = createWriteStream("", { fd: CONTROL_WRITE_FD })
  #buffer = ""
  #handshaken = false
  #aborted = false
  #announce: () => void = () => {}

  readonly whenAborted = new Promise<void>((resolve) => {
    this.#announce = resolve
  })

  #onSpec: ((spec: SupervisorLaunchSpec | undefined) => void) | undefined
  #lost = false

  constructor() {
    this.#stream.on("data", (chunk) => this.#consume(String(chunk)))
    this.#stream.on("error", () => {
      this.#lost = true
      this.#onSpec?.(undefined)
    })
    // Channel loss after the handshake is the adapter going away, which the
    // supervisor is explicitly designed to survive — but it is recorded, since
    // it becomes the trigger when nothing else has fixed one.
    this.#stream.on("end", () => {
      this.#lost = true
      this.#onSpec?.(undefined)
    })

    // The write side needs listeners for exactly the same reason, and needs
    // them more (issue #78). A write to a descriptor whose far end has gone
    // fails asynchronously with `EPIPE`, and an `error` event with nobody
    // listening is a throw out of the event loop — which kills the supervisor.
    //
    // At that moment the supervisor may already have authorized a detached
    // `xcodebuild` process group, and killing the one process that holds the
    // deadline, the cancellation and the obligation to publish leaves that
    // group running with nothing watching it: no timeout, no cancellation, no
    // terminal outcome, and a slot held until somebody notices. The adapter
    // going away is precisely the case this supervisor exists to survive.
    //
    // One listener, not two: a writer that has been closed or ended answers a
    // later write with an `error` of its own, so `close` needs no handler to
    // be survivable — and treating it as loss would declare the channel gone
    // every time a healthy run ended by closing it.
    this.#writer.on("error", () => {
      this.#lost = true
    })
  }

  get aborted(): boolean {
    return this.#aborted
  }

  /** True once the private control channel has gone. */
  get lost(): boolean {
    return this.#lost
  }

  /** The launch spec, or `undefined` when the channel produced no usable one. */
  launchSpec(): Promise<SupervisorLaunchSpec | undefined> {
    return new Promise((resolve) => {
      this.#onSpec = (spec) => {
        this.#onSpec = undefined
        resolve(spec)
      }
      // A frame may already have arrived before this was called.
      this.#consume("")
    })
  }

  /**
   * Publish a message, or record that the channel is gone.
   *
   * Never throws. A synchronous refusal — a writer already ended, a descriptor
   * already closed — is the same fact as an asynchronous `EPIPE` and is
   * recorded the same way.
   *
   * `write`'s return value is deliberately unread. A `false` is backpressure,
   * not failure — the frame is buffered and will go — and this channel carries
   * a handful of short frames over the life of a run. A supervisor that paused
   * to wait for a drain would be suspending the supervision of a live process
   * group in order to wait on the very process that may have gone.
   */
  send(message: Parameters<typeof encodeMessage>[0]): void {
    try {
      this.#writer.write(encodeMessage(message))
    } catch {
      this.#lost = true
    }
  }

  close(): void {
    this.#stream.destroy()
    try {
      this.#writer.end()
    } catch {
      this.#lost = true
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk
    const { messages, rest, overflowed } = decodeMessages(this.#buffer)
    this.#buffer = rest

    for (const message of messages) {
      if (message.type === "hello") {
        const spec = parseSpec(message as unknown as Partial<SupervisorLaunchSpec>)
        // Latched, never re-assigned. A handshake cannot be taken back — the
        // adapter says the same of its own half — and assigning here would let
        // a later malformed `hello` un-handshake a live run, after which every
        // cancellation is silently dropped and only the deadline can end it.
        if (spec !== undefined) this.#handshaken = true
        this.#onSpec?.(spec)
        continue
      }
      if (message.type === "cancel") {
        // Only after the handshake. A `cancel` that arrives before this
        // process knows which run it is supervising cannot be about that run.
        // The channel itself is the authentication (see `control.ts`); this is
        // sequencing, which the channel cannot provide.
        if (!this.#handshaken) continue
        this.#aborted = true
        this.#announce()
      }
    }

    // A peer that writes without ever ending a frame (issue #127). The buffer
    // is bounded by the decoder; what is left is deciding what the stream now
    // means, and the answer is nothing: framing that has been lost cannot be
    // recovered by reading further, and this end has no way to ask for a
    // resend. Treated as the channel going, which is a state the supervisor
    // is already built to survive — it finishes the run it was given and
    // records that nobody was left to tell.
    //
    // After the frames, not before them. A `hello` that completed whole in
    // the same read as an oversized tail is a `hello` that arrived, and
    // `#onSpec` fires once: reacting first would answer it with `undefined`
    // and then drop the spec that was sitting in the same chunk.
    if (overflowed) {
      this.#lost = true
      // Stopped, not merely noted. Reading on would let this end resynchronize
      // on whatever followed the junk and act on a frame — a `cancel`, say —
      // from a peer it has just declared gone.
      this.#stream.destroy()
      this.#onSpec?.(undefined)
    }
  }
}

function parseSpec(candidate: Partial<SupervisorLaunchSpec>): SupervisorLaunchSpec | undefined {
  if (
    typeof candidate.homeDir !== "string" ||
    typeof candidate.containmentRoot !== "string" ||
    // Validated here rather than trusted: this is the supervisor's boundary,
    // and a spec that cannot address storage must become EXIT_PROTOCOL rather
    // than an exception thrown later from somewhere that derives a path.
    !isRunId(candidate.runId) ||
    typeof candidate.command !== "string" ||
    !Array.isArray(candidate.args)
  ) {
    return undefined
  }
  return candidate as SupervisorLaunchSpec
}

export async function main(): Promise<number> {
  const channel = new ControlChannel()

  try {
    const spec = await channel.launchSpec()
    if (spec === undefined) return EXIT_PROTOCOL

    const storage = storageFor(spec.homeDir, spec.containmentRoot)
    const record = readRunRecord(storage, spec.runId)
    if (record === undefined) return EXIT_PROTOCOL

    // Published, and then not waited on (issue #78). The `EPIPE` this write
    // earns when the adapter has gone arrives a turn or more later, so there
    // is no instant at which stopping here would be the answer — and stopping
    // would be the wrong answer anyway. From the next line on, the supervisor
    // may hold a detached process group's deadline, its cancellation and its
    // only route to a terminal outcome, and channel loss becomes something to
    // survive rather than to stop for: a group nobody is watching is worse
    // than an adapter with nobody to tell.
    channel.send({ type: "ready", runId: spec.runId })

    const result = await superviseRun(
      {
        storage,
        probe: systemProbe,
        now: monotonicNow,
        timestamp: () => new Date().toISOString(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        spawn: () =>
          spawnGatedChild({
            command: spec.command,
            args: spec.args,
            cwd: spec.containmentRoot,
            environment: spec.environment,
            logPath: logPathFor(storage, spec.runId),
          }),
        cancellation: {
          get aborted() {
            return channel.aborted
          },
          whenAborted: channel.whenAborted,
        },
        channelLost: () => channel.lost,
      },
      { record, supervisorIdentity: selfIdentity() },
    )

    channel.send({
      type: "completed",
      ...(result.execution.exitCode === undefined ? {} : { exitCode: result.execution.exitCode }),
      ...(result.execution.signal === undefined ? {} : { signal: result.execution.signal }),
    })

    return EXIT_OK
  } finally {
    // Publish and exit. The supervisor never waits indefinitely for an absent
    // plugin; reconciliation finalizes the run from immutable artifacts instead.
    channel.close()
  }
}

export function logPathFor(storage: Storage, runId: string): string {
  // Through `runDirectory`, not assembled here: it is the one place a run's
  // path is derived and therefore the one place the identifier is validated.
  // A second way to build the same path is a second way to skip that.
  return join(runDirectory(storage, runId), RUN_ARTIFACTS.rawLog)
}

function selfIdentity(): RunRecord["supervisor"] {
  return systemProbe.identify(process.pid) ?? { pid: process.pid, startedAt: "unknown" }
}

/**
 * True when this module is the process's entry, rather than merely imported.
 * The plugin ships as source with no build step, so the same file has to work
 * as both a module under test and a spawnable script.
 */
export function isEntrypoint(url: string): boolean {
  const invoked = process.argv[1]
  return invoked !== undefined && url.endsWith(invoked.replace(/^.*\//, ""))
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      // Exit explicitly: an inherited descriptor would otherwise keep the event
      // loop alive after the run is finished and published.
      process.exit(code)
    })
    .catch(() => {
      process.exit(EXIT_PROTOCOL)
    })
}
