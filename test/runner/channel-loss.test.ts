/**
 * The supervisor outliving its adapter (issue #78).
 *
 * The supervisor is built to survive OpenCode disappearing: it is detached, it
 * imports no adapter code, and channel loss is a fact it records rather than a
 * reason to stop. All of that was defeated by a missing listener. The response
 * writer had none, so a write to a descriptor whose far end had gone raised an
 * `error` event with nobody to hear it — and an unheard `error` event is a
 * throw out of the event loop, which kills the process it happens in.
 *
 * The moment it happens is the worst one available. By then the supervisor may
 * have authorized a detached `xcodebuild` process group, and it is the only
 * thing holding that group's deadline, its cancellation, and the obligation to
 * publish a terminal outcome. Killing it leaves the group running with nothing
 * watching it and an execution slot held until somebody notices by hand.
 *
 * Driven through the real entrypoint in a real subprocess, with a real pipe
 * closed under it. `EPIPE` is a property of descriptors, and a fake writer
 * would only prove that the fake agrees.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { encodeMessage } from "../../src/runner/control.ts"
import { systemProbe } from "../../src/runner/identity.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { EXIT_PROTOCOL } from "../../src/runner/supervisor-entry.ts"
import { sandbox, seedRun, sleep } from "./harness.ts"

const ENTRYPOINT = join(import.meta.dir, "..", "..", "src", "runner", "supervisor-entry.ts")

/** Long enough that the run is unmistakably still in progress when it matters. */
const CHILD_SECONDS = 2

type Outcome = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  pgid: number | undefined
  survivors: number
  controlChannelLost: boolean | undefined
  state: string | undefined
}

/**
 * Run the real supervisor with its reply channel already closed.
 *
 * The read end goes before `hello` is written, so the far end is provably gone
 * by the time the supervisor answers — and the `EPIPE` that answer earns is
 * delivered asynchronously, a turn or more later, while a child is running.
 * That ordering is the whole point: an error arriving *during* supervision is
 * the one that used to take the supervisor down with a live process group.
 */
async function superviseWithoutAnAdapter(): Promise<Outcome> {
  const trustedRoot = mkdtempSync(join(tmpdir(), "xcode-test-root-"))
  const box = sandbox(trustedRoot)
  const runId = "a".repeat(32)

  try {
    createRunDirectory(box.storage, runId)
    seedRun(box.storage, { runId, timeoutSeconds: 60 })

    const child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: trustedRoot,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    // Closed first, so there is no window in which the reply lands in a pipe
    // buffer and the write quietly succeeds.
    child.stdio[4]?.destroy()

    child.stdio[3]?.write(
      encodeMessage({
        type: "hello",
        secret: "s".repeat(32),
        homeDir: box.homeDir,
        trustedRoot,
        runId,
        command: "/bin/sleep",
        args: [String(CHILD_SECONDS)],
        environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        developerDirectory: "/unused",
      }),
    )

    const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve) => child.on("exit", (code, received) => resolve([code, received])),
    )

    const record = readRunRecord(box.storage, runId)
    const pgid = record?.child?.pgid

    // Asked after the supervisor is gone, so what is counted is what it left
    // behind rather than what it was still tending.
    await sleep(50)

    return {
      exitCode,
      signal,
      stderr,
      pgid,
      survivors: pgid === undefined ? 0 : systemProbe.membersOf(pgid).length,
      controlChannelLost: record?.controlChannelLost,
      state: record?.state,
    }
  } finally {
    box.dispose()
    rmSync(trustedRoot, { recursive: true, force: true })
  }
}

describe("a supervisor whose adapter has gone", () => {
  let outcome: Outcome

  // One subprocess for the whole description. Each of these is a fact about
  // the same run, and running it four times would cost four real child
  // lifetimes to learn what one of them already showed.
  test("survives the write that can no longer be delivered", async () => {
    outcome = await superviseWithoutAnAdapter()

    // An unheard `error` event leaves through the default handler, which is a
    // signal-free non-zero exit with the throw on stderr. A supervisor that
    // chose its own status is one that was still in charge when it finished.
    expect(outcome.stderr).not.toContain("EPIPE")
    expect(outcome.signal).toBeNull()
    expect(outcome.exitCode).toBe(0)
  }, 30_000)

  test("drives the run it had already authorized to a terminal state", () => {
    // Not merely "did not crash". The supervisor owed this run a durable
    // outcome, and an adapter with nobody to tell is not a reason to stop
    // owing it. `executionCompleted` is as far as a supervisor can take a run
    // on its own; `completed` is the adapter's word, and there is no adapter.
    expect(outcome.state).toBe("executionCompleted")
  })

  test("leaves nothing of the child's process group behind", () => {
    // The failure this closes. A supervisor killed here leaves a detached
    // group with no deadline, no cancellation and no terminal outcome — and
    // the group in a real run is `xcodebuild`.
    expect(outcome.pgid).toBeGreaterThan(0)
    expect(outcome.survivors).toBe(0)
  })

  test("records the loss durably, for recovery to read", () => {
    // Recorded as a fact rather than as an outcome. It is what lets recovery
    // read a missing terminal summary as something nobody was there to
    // publish, rather than as a run that never reached one.
    expect(outcome.controlChannelLost).toBe(true)
  })
})

describe("a supervisor with no adapter at all", () => {
  test("spawns nothing when the channel closes before the spec arrives", async () => {
    // The other end of the same boundary. A supervisor that never learned what
    // to run has nothing to abandon, and it must not invent one — so what is
    // checked is that it chose its own status and left no process behind.
    const child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: tmpdir(),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.stdio[4]?.destroy()
    child.stdio[3]?.end()

    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.on("exit", (status, received) => resolve([status, received])),
    )

    expect(stderr).toBe("")
    expect(signal).toBeNull()
    expect(code).toBe(EXIT_PROTOCOL)
  }, 30_000)
})
