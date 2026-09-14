#!/usr/bin/env bun
/**
 * A stand-in supervisor that speaks the control protocol and nothing else.
 *
 * The real supervisor's job is to run `xcodebuild`; this one's is to let the
 * adapter's half of the protocol be tested without it — the handshake, the
 * durable state transitions, and the completion message, on demand and in
 * milliseconds.
 *
 * Behaviour is scripted through a `.stub-mode` file in the trusted root, so
 * nothing in shipped code has to know this stub exists:
 *   ready-then-complete  (default) full protocol, exit 0
 *   silent               exit 0 without ever handshaking
 *   crash                exit non-zero after handshaking
 *   hang                 never handshake and never exit, so the adapter's
 *                        startup deadline is the only thing that ends it
 */

import { createReadStream, createWriteStream } from "node:fs"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { decodeMessages, encodeMessage } from "../../../src/runner/control.ts"
import { storageFor } from "../../../src/runner/paths.ts"
import { advance, readRunRecord } from "../../../src/runner/state.ts"

const control = createWriteStream("", { fd: 4 })
const incoming = createReadStream("", { fd: 3 })

let buffer = ""
incoming.on("data", (chunk) => {
  buffer += String(chunk)
  const { messages, rest } = decodeMessages(buffer)
  buffer = rest

  for (const message of messages) {
    if (message.type !== "hello") continue
    const spec = message as unknown as { homeDir: string; trustedRoot: string; runId: string }

    const mode = modeFor(spec.trustedRoot)
    if (mode === "silent") process.exit(0)
    if (mode === "hang") {
      // Explicitly kept alive rather than relying on an inherited descriptor:
      // what is under test is the adapter giving up, and a stub that exited on
      // its own would quietly test nothing.
      setInterval(() => {}, 1_000)
      continue
    }

    control.write(encodeMessage({ type: "ready", runId: spec.runId }))

    const storage = storageFor(spec.homeDir, spec.trustedRoot)
    let record = readRunRecord(storage, spec.runId)
    if (record !== undefined) {
      for (const state of ["supervisorReady", "childRecorded", "launchAuthorized"] as const) {
        record = advance(storage, record, state)
      }
      record = advance(storage, record, "executionCompleted", {
        execObserved: "yes",
        exitCode: 0,
        descendantsConfirmedExited: "yes",
      })
    }

    control.write(encodeMessage({ type: "completed", exitCode: 0 }))
    process.exit(mode === "crash" ? 70 : 0)
  }
})

function modeFor(trustedRoot: string): string {
  try {
    return readFileSync(join(trustedRoot, ".stub-mode"), "utf8").trim()
  } catch {
    return "ready-then-complete"
  }
}
