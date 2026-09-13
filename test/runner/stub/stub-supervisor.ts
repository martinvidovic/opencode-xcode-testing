#!/usr/bin/env bun
/**
 * A stand-in supervisor that speaks the control protocol and nothing else.
 *
 * The real supervisor's job is to run `xcodebuild`; this one's is to let the
 * adapter's half of the protocol be tested without it — the handshake, the
 * durable state transitions, and the completion message, on demand and in
 * milliseconds.
 *
 * Behaviour is scripted through `XCODE_TEST_STUB`:
 *   ready-then-complete  (default) full protocol, exit 0
 *   silent               exit 0 without ever handshaking
 *   crash                exit non-zero after handshaking
 */

import { createReadStream, createWriteStream } from "node:fs"

import { decodeMessages, encodeMessage } from "../../../src/runner/control.ts"
import { storageFor } from "../../../src/runner/paths.ts"
import { advance, readRunRecord } from "../../../src/runner/state.ts"

const MODE = process.env["XCODE_TEST_STUB"] ?? "ready-then-complete"

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

    if (MODE === "silent") process.exit(0)

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
    process.exit(MODE === "crash" ? 70 : 0)
  }
})
