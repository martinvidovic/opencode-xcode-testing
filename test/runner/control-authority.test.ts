/**
 * What actually authenticates a control frame (issue #115).
 *
 * `control.ts` says where the boundary is and why the secret that used to sit
 * here was not one. What is left to test is what the protocol does enforce:
 * sequencing. A `cancel` means nothing until this process knows which run it
 * is supervising, and everything afterwards.
 *
 * Exercised through real inherited descriptors on a real subprocess. The
 * boundary under discussion *is* a descriptor, so a fake writer would only
 * show that the fake agrees with itself.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decodeMessages, encodeMessage, MAX_FRAME_BYTES, type LaunchSpec } from "../../src/runner/control.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"
import { readRunRecord, type RunRecord } from "../../src/runner/state.ts"
import { EXIT_PROTOCOL } from "../../src/runner/supervisor-entry.ts"
import {
  sandbox,
  seedRun,
  sleep,
  spawnWithControlChannel,
  SUPERVISOR_ENTRYPOINT,
  type ProcessEnd,
} from "./harness.ts"

/** Long enough that a cancellation lands while the child is unmistakably alive. */
const CHILD_SECONDS = 5

type Conversation = {
  /** Say this before `hello` goes. */
  before?: string
  /** Say this once the supervisor has answered `ready`, and is under way. */
  afterReady?: string
  /** `false` to never send one, for the cases that are about what precedes it. */
  hello?: false
}

/**
 * Drive a real supervisor through real inherited descriptors, and report the
 * record it left behind.
 */
async function converse(talk: Conversation): Promise<{ record: RunRecord | undefined; end: ProcessEnd }> {
  const trustedRoot = mkdtempSync(join(tmpdir(), "xcode-test-root-"))
  const box = sandbox(trustedRoot)
  const runId = "c".repeat(32)

  try {
    createRunDirectory(box.storage, runId)
    seedRun(box.storage, { runId, timeoutSeconds: 60 })

    const { toSupervisor, fromSupervisor, ended } = spawnWithControlChannel(SUPERVISOR_ENTRYPOINT, {
      cwd: trustedRoot,
    })

    const ready = new Promise<void>((resolve) => {
      let buffer = ""
      fromSupervisor?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        const { messages, rest } = decodeMessages(buffer)
        buffer = rest
        if (messages.some((message) => message.type === "ready")) resolve()
      })
    })

    if (talk.before !== undefined) toSupervisor?.write(talk.before)

    const spec: LaunchSpec = {
      homeDir: box.homeDir,
      trustedRoot,
      runId,
      command: "/bin/sleep",
      args: [String(CHILD_SECONDS)],
      environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      developerDirectory: "/unused",
    }
    if (talk.hello !== false) toSupervisor?.write(encodeMessage({ type: "hello", ...spec }))

    if (talk.afterReady !== undefined) {
      await ready
      // `ready` is published before supervision starts, so a cancel sent on
      // its heels would land in the pre-launch window and prove something
      // else. The child sleeps for seconds; this waits long enough to be
      // inside the run, and is nowhere near long enough to race it.
      await sleep(750)
      toSupervisor?.write(talk.afterReady)
    }

    return { end: await ended, record: readRunRecord(box.storage, runId) }
  } finally {
    box.dispose()
    rmSync(trustedRoot, { recursive: true, force: true })
  }
}

describe("a cancellation on the private channel", () => {
  test("is obeyed once the handshake has happened", async () => {
    // The property the sequencing exists to provide, and the one that would
    // be silently lost by a change that only removed things.
    const { record } = await converse({ afterReady: encodeMessage({ type: "cancel" }) })

    expect(record?.terminationTrigger).toBe("callerCancellation")
    expect(record?.state).toBe("executionCompleted")
  }, 40_000)

  test("is ignored when it arrives before one", async () => {
    // A frame that arrives before the supervisor knows what run it is
    // supervising cannot be about that run. Acting on it would let a stray or
    // replayed frame cancel work it was never addressed to — and the order is
    // the only thing that distinguishes the two, since both are syntactically
    // perfect.
    const { record } = await converse({ before: encodeMessage({ type: "cancel" }) })

    expect(record?.terminationTrigger).not.toBe("callerCancellation")
    expect(record?.execObserved).toBe("yes")
  }, 40_000)
})

describe("a handshake that has already happened", () => {
  test("cannot be taken back by a later frame that fails to parse", async () => {
    // The flag is latched for a reason. Assigned on every `hello` instead, a
    // second malformed one un-handshakes a live run — and from then on every
    // cancellation is dropped in silence, leaving the deadline as the only
    // thing that can still end it.
    const { record } = await converse({
      afterReady: '{"type":"hello","homeDir":42}\n' + encodeMessage({ type: "cancel" }),
    })

    expect(record?.terminationTrigger).toBe("callerCancellation")
  }, 40_000)
})

describe("a frame that never ends", () => {
  test("ends the supervisor in bounded protocol failure rather than growing", async () => {
    // Written by whoever holds the other end of the pipe, which for a
    // supervisor is the only thing it trusts — and trusting it is not the
    // same as letting it decide how much memory this process uses. Framing
    // that has been lost cannot be recovered by reading further, so the
    // channel is treated as gone: this supervisor has no run to finish, and
    // it stops instead of waiting for a `hello` that can no longer arrive.
    //
    // In chunks, because that is how one arrives: every write is small and
    // unremarkable, and the buffer is what would grow.
    const chunk = "x".repeat(4_096)
    const { end } = await converse({
      hello: false,
      before: chunk.repeat(Math.ceil(MAX_FRAME_BYTES / chunk.length) + 1),
    })

    expect(end.exitCode).toBe(EXIT_PROTOCOL)
  }, 40_000)
})

describe("a frame the protocol does not recognize", () => {
  test("is dropped rather than interpreted, before or after the handshake", async () => {
    const { record } = await converse({ before: '{"type":"authorize","runId":"anything"}\n' })

    expect(record?.state).toBe("executionCompleted")
    expect(record?.terminationTrigger).not.toBe("callerCancellation")
  }, 40_000)
})
