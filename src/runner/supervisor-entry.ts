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

import {
  decodeMessages,
  encodeMessage,
  secretMatches,
  type ControlMessage,
} from "./control.ts"
import { systemProbe } from "./identity.ts"
import { spawnGatedChild } from "./gate.ts"
import { RUN_ARTIFACTS, storageFor, type Storage } from "./paths.ts"
import { readRunRecord, type RunRecord } from "./state.ts"
import { superviseRun } from "./supervisor.ts"

/** The inherited descriptors the adapter sets up before spawning. */
export const CONTROL_READ_FD = 3
export const CONTROL_WRITE_FD = 4

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
 * Read the launch spec from the control channel and supervise the run.
 *
 * Exported rather than executed at import time, so the module can be loaded by
 * a test without spawning anything.
 */
export async function main(): Promise<number> {
  const control = createWriteStream("", { fd: CONTROL_WRITE_FD })
  const spec = await readLaunchSpec()
  if (spec === undefined) return 70

  const storage = storageFor(spec.homeDir, spec.trustedRoot)
  const record = readRunRecord(storage, spec.runId)
  if (record === undefined) return 70

  control.write(encodeMessage({ type: "ready", runId: spec.runId }))

  const cancellation = createCancellation(spec.secret)
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
      cancellation,
    },
    { record, supervisorIdentity: selfIdentity() },
  )

  control.write(
    encodeMessage({
      type: "completed",
      ...(result.execution.exitCode === undefined ? {} : { exitCode: result.execution.exitCode }),
      ...(result.execution.signal === undefined ? {} : { signal: result.execution.signal }),
    }),
  )

  // Publish and exit. The supervisor never waits indefinitely for an absent
  // plugin; reconciliation finalizes the run from immutable artifacts instead.
  return 0
}

export function logPathFor(storage: Storage, runId: string): string {
  return join(storage.runsDir, runId, RUN_ARTIFACTS.rawLog)
}

function selfIdentity(): RunRecord["supervisor"] {
  const probe = systemProbe.identify(process.pid)
  return probe ?? { pid: process.pid, startedAt: "unknown" }
}

async function readLaunchSpec(): Promise<SupervisorLaunchSpec | undefined> {
  const stream = createReadStream("", { fd: CONTROL_READ_FD })
  let buffer = ""

  for await (const chunk of stream) {
    buffer += String(chunk)
    const { messages, rest } = decodeMessages(buffer)
    buffer = rest
    for (const message of messages) {
      if (message.type !== "hello") continue
      const spec = parseSpec(message)
      if (spec !== undefined) return spec
      return undefined
    }
  }
  return undefined
}

/**
 * The spec travels with the handshake secret so the two are inseparable; a
 * frame carrying one without the other is rejected rather than partly used.
 */
function parseSpec(message: ControlMessage & { type: "hello" }): SupervisorLaunchSpec | undefined {
  const candidate = message as unknown as Partial<SupervisorLaunchSpec>
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

function createCancellation(secret: string) {
  let aborted = false
  let announce: () => void = () => {}
  const whenAborted = new Promise<void>((resolve) => {
    announce = resolve
  })

  const stream = createReadStream("", { fd: CONTROL_READ_FD })
  let buffer = ""
  stream.on("data", (chunk) => {
    buffer += String(chunk)
    const { messages, rest } = decodeMessages(buffer)
    buffer = rest
    for (const message of messages) {
      // Only an authenticated cancel counts. An unauthenticated frame on a
      // private channel is a protocol violation, not a cancellation.
      if (message.type === "cancel") {
        aborted = true
        announce()
      }
      if (message.type === "hello" && !secretMatches(secret, message.secret)) {
        stream.destroy()
      }
    }
  })

  return {
    get aborted() {
      return aborted
    },
    whenAborted,
  }
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
      process.exitCode = code
    })
    .catch(() => {
      process.exitCode = 70
    })
}
