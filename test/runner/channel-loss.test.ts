/**
 * The supervisor outliving its adapter (issue #78).
 *
 * The supervisor is built to survive OpenCode disappearing: it is detached, it
 * imports no adapter code, and channel loss is a fact it records rather than a
 * reason to stop. All of that was defeated by a missing listener. The response
 * writer had none, so a write to a descriptor whose far end had gone raised an
 * `error` event with nobody to hear it — and an unheard `error` event is a
 * throw out of the event loop, which kills the process it happens in. What it
 * kills is the only thing holding a detached process group's deadline, its
 * cancellation, and its route to a terminal outcome.
 *
 * Driven through the real entrypoint in a real subprocess, with a real pipe
 * closed under it. `EPIPE` is a property of descriptors, and a fake writer
 * would only prove that the fake agrees.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { encodeMessage } from "../../src/runner/control.ts"
import { systemProbe } from "../../src/runner/identity.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { EXIT_PROTOCOL } from "../../src/runner/supervisor-entry.ts"
import { sandbox, seedRun, sleep, spawnWithControlChannel, SUPERVISOR_ENTRYPOINT } from "./harness.ts"

/** Long enough that the run is unmistakably still in progress when it matters. */
const CHILD_SECONDS = 2

describe("a supervisor whose adapter has gone", () => {
  test("finishes the run it was given and leaves nothing of it running", async () => {
    // Four facts about one run, asserted together rather than split across
    // four cases. Splitting them would mean either four real child lifetimes
    // to learn what one shows, or state shared between tests — and this repo
    // uses neither.
    const containmentRoot = mkdtempSync(join(tmpdir(), "xcode-test-root-"))
    const box = sandbox(containmentRoot)
    const runId = "a".repeat(32)

    try {
      createRunDirectory(box.storage, runId)
      seedRun(box.storage, { runId, timeoutSeconds: 60 })

      const { toSupervisor, fromSupervisor, ended } = spawnWithControlChannel(SUPERVISOR_ENTRYPOINT, {
        cwd: containmentRoot,
      })

      // Closed before `hello` goes, so there is no window in which the reply
      // lands in a pipe buffer and the write quietly succeeds. The `EPIPE` it
      // earns is delivered a turn or more later — while a child is running,
      // which is the ordering that used to be fatal.
      fromSupervisor?.destroy()

      toSupervisor?.write(
        encodeMessage({
          type: "hello",
          homeDir: box.homeDir,
          containmentRoot,
          rootKey: box.storage.rootKey,
          runId,
          command: "/bin/sleep",
          args: [String(CHILD_SECONDS)],
          environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          developerDirectory: "/unused",
        }),
      )

      const end = await ended

      // It chose its own status. An unheard `error` event leaves through the
      // default handler instead, which is a throw on stderr and a status
      // nobody picked.
      expect(end.stderr).not.toContain("EPIPE")
      expect(end.signal).toBeNull()
      expect(end.exitCode).toBe(0)

      const record = readRunRecord(box.storage, runId)

      // Not merely "did not crash". The supervisor owed this run a durable
      // outcome, and an adapter with nobody to tell is not a reason to stop
      // owing it. `executionCompleted` is as far as a supervisor can take a
      // run alone; `completed` is the adapter's word, and there is no adapter.
      expect(record?.state).toBe("executionCompleted")

      // The failure this closes. A supervisor killed here leaves a detached
      // group with no deadline, no cancellation and no terminal outcome — and
      // in a real run that group is `xcodebuild`.
      const pgid = record?.child?.pgid
      expect(pgid).toBeGreaterThan(0)
      await sleep(50)
      expect(systemProbe.membersOf(pgid as number)).toEqual([])

      // Recorded as a fact rather than as an outcome, so it survives even when
      // a cancellation or a deadline fixed the outcome first.
      expect(record?.controlChannelLost).toBe(true)
    } finally {
      box.dispose()
      rmSync(containmentRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test("cannot leave a gated child behind if it dies before authorizing one", async () => {
    // The boundary in between: a supervisor that has spawned a child but not
    // yet authorized it. The other two cases are about a supervisor that stays
    // alive; this one is about what it leaves if it does not, which is the
    // guarantee the gate exists to give. Forced rather than argued from the
    // gate script, because "the child would exit" is exactly the kind of claim
    // that stays true only until someone changes the script.
    const containmentRoot = mkdtempSync(join(tmpdir(), "xcode-test-root-"))
    const logPath = join(containmentRoot, "run.log")

    try {
      // Held at the gate and never authorized, in a process that is then
      // killed outright — no cleanup, no abandon, nothing cooperative.
      const script = `
        import { spawnGatedChild } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "runner", "gate.ts"))}
        const child = spawnGatedChild({
          command: "/bin/sleep",
          args: ["30"],
          cwd: ${JSON.stringify(containmentRoot)},
          environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          logPath: ${JSON.stringify(logPath)},
        })
        const recorded = await child.recorded
        process.stdout.write(String(recorded.pgid) + "\\n")
        await new Promise(() => {})
      `

      const holder = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] })
      const pgid = await new Promise<number>((resolve) => {
        let out = ""
        holder.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8")
          if (out.includes("\n")) resolve(Number.parseInt(out, 10))
        })
      })

      expect(pgid).toBeGreaterThan(0)
      holder.kill("SIGKILL")

      // The gate's read of its authorization descriptor fails the moment the
      // holder's end of it goes, so the child exits without ever reaching
      // `exec`. Given a budget rather than an instant: it is a real process
      // being scheduled, not a promise being resolved.
      const gone = await waitForEmptyGroup(pgid, 5_000)
      expect(gone).toBe(true)

      // And it never ran Xcode. An empty log is the gate's whole point: the
      // child proves it was recorded before it may execute anything.
      expect(readFileSync(logPath, "utf8")).toBe("")
    } finally {
      rmSync(containmentRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test("spawns nothing when the channel closes before the spec arrives", async () => {
    // The first startup boundary, where there is nothing yet to abandon. A
    // supervisor that never learned what to run must not invent one.
    const containmentRoot = mkdtempSync(join(tmpdir(), "xcode-test-root-"))
    try {
      const { toSupervisor, fromSupervisor, ended } = spawnWithControlChannel(SUPERVISOR_ENTRYPOINT, {
        cwd: containmentRoot,
      })
      fromSupervisor?.destroy()
      toSupervisor?.end()

      const end = await ended

      expect(end.stderr).toBe("")
      expect(end.signal).toBeNull()
      expect(end.exitCode).toBe(EXIT_PROTOCOL)
    } finally {
      rmSync(containmentRoot, { recursive: true, force: true })
    }
  }, 30_000)
})

/** Poll until nothing of the group is left, or the budget runs out. */
async function waitForEmptyGroup(pgid: number, budgetMs: number): Promise<boolean> {
  const until = Date.now() + budgetMs
  for (;;) {
    if (systemProbe.membersOf(pgid).length === 0) return true
    if (Date.now() >= until) return false
    await sleep(25)
  }
}
