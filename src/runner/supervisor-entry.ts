/**
 * The supervisor entrypoint.
 *
 * This is the process the adapter spawns through the resolved runtime, and it
 * imports only `domain` and `runner` code — never adapter code. It has to
 * outlive the adapter call that started it: OpenCode may disappear while
 * `xcodebuild` is still running, and a supervisor that had been linked to the
 * adapter's module graph would be a supervisor that dies with it.
 *
 * Everything it needs arrives over the private inherited control channel, so no
 * secret and no invocation detail is ever visible in `ps` output or the
 * environment.
 */

import { createReadStream, createWriteStream } from "node:fs"
import { join } from "node:path"

import { decodeMessages, encodeMessage, secretMatches } from "./control.ts"
import { spawnGatedChild } from "./gate.ts"
import { systemProbe } from "./identity.ts"
import { RUN_ARTIFACTS, storageFor, type Storage } from "./paths.ts"
import { readRunRecord, type RunRecord } from "./state.ts"
import { superviseRun } from "./supervisor.ts"

/** The inherited descriptors the adapter sets up before spawning. */
export const CONTROL_READ_FD = 3
export const CONTROL_WRITE_FD = 4

/** Exit statuses the adapter distinguishes. */
export const EXIT_OK = 0
export const EXIT_PROTOCOL = 70

export type SupervisorLaunchSpec = {
  secret: string
  homeDir: string
  trustedRoot: string
  runId: string
  command: string
  args: string[]
  environment: Record<string, string>
  developerDirectory: string
}

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
  #secret: string | undefined
  #aborted = false
  #announce: () => void = () => {}

  readonly whenAborted = new Promise<void>((resolve) => {
    this.#announce = resolve
  })

  #onSpec: ((spec: SupervisorLaunchSpec | undefined) => void) | undefined
  #lost = false

  constructor() {
    this.#stream.on("data", (chunk) => this.#consume(String(chunk)))
    this.#stream.on("error", () => this.#onSpec?.(undefined))
    // Channel loss after the handshake is the adapter going away, which the
    // supervisor is explicitly designed to survive — but it is recorded, since
    // it becomes the trigger when nothing else has fixed one.
    this.#stream.on("end", () => {
      this.#lost = true
      this.#onSpec?.(undefined)
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

  send(message: Parameters<typeof encodeMessage>[0]): void {
    this.#writer.write(encodeMessage(message))
  }

  close(): void {
    this.#stream.destroy()
    this.#writer.end()
  }

  #consume(chunk: string): void {
    this.#buffer += chunk
    const { messages, rest } = decodeMessages(this.#buffer)
    this.#buffer = rest

    for (const message of messages) {
      if (message.type === "hello") {
        const spec = parseSpec(message as unknown as Partial<SupervisorLaunchSpec>)
        this.#secret = spec?.secret
        this.#onSpec?.(spec)
        continue
      }
      if (message.type === "cancel") {
        // Only an authenticated channel may cancel. An unauthenticated frame on
        // a private channel is a protocol violation, not a cancellation.
        if (this.#secret === undefined) continue
        this.#aborted = true
        this.#announce()
      }
    }
  }
}

function parseSpec(candidate: Partial<SupervisorLaunchSpec>): SupervisorLaunchSpec | undefined {
  if (
    typeof candidate.secret !== "string" ||
    typeof candidate.homeDir !== "string" ||
    typeof candidate.trustedRoot !== "string" ||
    typeof candidate.runId !== "string" ||
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

    const storage = storageFor(spec.homeDir, spec.trustedRoot)
    const record = readRunRecord(storage, spec.runId)
    if (record === undefined) return EXIT_PROTOCOL

    channel.send({ type: "ready", runId: spec.runId })

    const result = await superviseRun(
      {
        storage,
        probe: systemProbe,
        now: () => Number(process.hrtime.bigint() / 1_000_000n),
        timestamp: () => new Date().toISOString(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        spawn: () =>
          spawnGatedChild({
            command: spec.command,
            args: spec.args,
            cwd: spec.trustedRoot,
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
  return join(storage.runsDir, runId, RUN_ARTIFACTS.rawLog)
}

function selfIdentity(): RunRecord["supervisor"] {
  return systemProbe.identify(process.pid) ?? { pid: process.pid, startedAt: "unknown" }
}

export { secretMatches }

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
