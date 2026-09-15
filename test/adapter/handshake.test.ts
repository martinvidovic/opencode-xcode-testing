/**
 * The supervisor handshake deadline (#3, issue #35).
 *
 * A supervisor that never answers is the hardest failure to handle honestly,
 * because the one thing nobody knows is what it is doing. Signalling it is not
 * the same as it being gone, and the difference decides whether the execution
 * slot may be handed to the next Test Run: releasing a root while a process
 * nobody is tracking may still be driving `xcodebuild` against the same
 * DerivedData is precisely what quarantine exists to prevent.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"
import { QUARANTINE_REASONS, readQueue } from "../../src/runner/queue.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { withSandbox, type Sandbox } from "../runner/harness.ts"

const STUB_SUPERVISOR = join(import.meta.dir, "..", "runner", "stub", "stub-supervisor.ts")

/**
 * A trusted root that resolves, with the committed stub scripted.
 *
 * Resolution validates the container against the real filesystem, so a run in
 * this file has to reach the supervisor before it can be about the supervisor
 * at all. The stub is the committed one ADR 0001 names for these transitions,
 * not a fixture written on the fly.
 */
function project(box: Sandbox, mode: string): string {
  const root = join(box.homeDir, "project")
  mkdirSync(join(root, "App.xcodeproj"), { recursive: true })
  writeFileSync(join(root, ".stub-mode"), `${mode}\n`)
  return root
}

function environmentFor(
  box: Sandbox,
  mode: string,
  overrides: Partial<ServiceEnvironment> = {},
): ServiceEnvironment {
  return {
    storage: box.storage,
    trustedRoot: project(box, mode),
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: process.execPath },
    supervisorEntrypoint: STUB_SUPERVISOR,
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 9),
    // Short, so the test does not wait out a production deadline.
    handshakeDeadlineMs: 300,
    ...overrides,
  }
}

/** Start one run against a project that resolves, and wait for its result. */
async function run(box: Sandbox, overrides: Partial<ServiceEnvironment> = {}) {
  return runScripted(box, "hang", overrides)
}

/**
 * The same, with the mode named and the protocol states it reported kept.
 *
 * The states are the only place a killed supervisor and a finished one differ
 * observably from out here: a run record is trimmed when it is finalized, so
 * what the supervisor got done has to be caught as it is reported.
 */
async function runScripted(
  box: Sandbox,
  mode: string,
  overrides: Partial<ServiceEnvironment> = {},
  states: string[] = [],
) {
  const service = createTestToolService(
    environmentFor(box, mode, {
      configuration: {
        status: "loaded",
        configuration: {
          schemaVersion: 1,
          xcodeContainer: { kind: "project", path: "App.xcodeproj" },
          scheme: "App",
          destination: { kind: "id", id: "SIMULATOR" },
        },
      },
      ...overrides,
    }),
  )
  return service.start(
    { requestedScope: { kind: "all" } },
    { onState: (state) => states.push(state) },
  ).result
}

describe("a supervisor that never completes its handshake", () => {
  test("is a launching-phase runner failure", async () => {
    await withSandbox(async (box) => {
      const result = await run(box)

      if (!isTestRunSummary(result)) throw new Error(`expected a Test Run: ${result.outcome}`)
      expect(result.outcome).toBe("infrastructureFailed")
      expect(result.reason).toBe("runnerFailure")
      // It was never authorized to start anything, so nothing executed.
      expect(result.execution.execObserved).toBe("no")
    })
  })

  test("releases the root once the signalled supervisor is confirmed gone", async () => {
    await withSandbox(async (box) => {
      await run(box)

      // `SIGKILL` cannot be ignored, so an exit does arrive — and a confirmed
      // exit is certainty, not uncertainty. Holding the root here would wedge
      // every project whose supervisor was ever slow to start.
      expect(readQueue(box.storage).quarantine).toBeUndefined()
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })

  test("holds the root when the exit cannot be confirmed", async () => {
    await withSandbox(async (box) => {
      // The signal is sent and the exit never observed within its deadline.
      // Uncertainty holds the slot rather than releasing it.
      await run(box, { exitDeadlineMs: 0 })

      const state = readQueue(box.storage)
      expect(state.quarantine).toBeDefined()
      expect(state.quarantine?.reason).toBe(QUARANTINE_REASONS.supervisorStillRunning)
      expect(state.activeRunId).toBeUndefined()
    })
  })

  test("records the quarantine durably, so a crash cannot lose it", async () => {
    await withSandbox(async (box) => {
      await run(box, { exitDeadlineMs: 0 })

      // Written onto the run before the summary is published: `releaseOwnership`
      // reads it back from disk, so a crash between the two still leaves a root
      // that the next startup knows to hold.
      const runId = readQueue(box.storage).quarantine?.runId
      expect(runId).toBeDefined()
      expect(readRunRecord(box.storage, runId as string)?.quarantined).toBe(true)
    })
  })

  test("names the process the root is held over, so recovery can check it", async () => {
    await withSandbox(async (box) => {
      await run(box, { exitDeadlineMs: 0 })

      // A quarantine backed by no identity is one nothing can ever confirm
      // safe, and a root held on that basis is held until somebody deletes
      // state by hand. Recovery clears this one by asking whether that exact
      // process is still there.
      const runId = readQueue(box.storage).quarantine?.runId
      expect(readRunRecord(box.storage, runId as string)?.supervisor?.pid).toBeGreaterThan(0)
    })
  })

  test("holds the root when the supervisor cannot be signalled at all", async () => {
    await withSandbox(async (box) => {
      // The signal is refused and the process answers when asked. Nothing has
      // been established about what it is doing, and "we tried" is not
      // grounds to hand the root to the next Test Run.
      await run(box, {
        killProcess: () => false,
        identifyProcess: (pid) => ({ pid, startedAt: "still-here" }),
      })

      const state = readQueue(box.storage)
      expect(state.quarantine?.reason).toBe(QUARANTINE_REASONS.supervisorUnsignalled)
      expect(readRunRecord(box.storage, state.quarantine?.runId as string)?.supervisor?.startedAt)
        .toBe("still-here")
    })
  })

  test("releases when signalling fails because the process had already gone", async () => {
    await withSandbox(async (box) => {
      // The same refusal, and nothing answers. That is the outcome the signal
      // was trying to bring about, reached without it.
      await run(box, { killProcess: () => false, identifyProcess: () => undefined })

      expect(readQueue(box.storage).quarantine).toBeUndefined()
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })

  test("releases when the exit deadline finds nothing there", async () => {
    await withSandbox(async (box) => {
      // The event never arrived, and the operating system says it is gone. A
      // confirmed exit is certainty however it was confirmed.
      await run(box, { exitDeadlineMs: 0, identifyProcess: () => undefined })

      expect(readQueue(box.storage).quarantine).toBeUndefined()
    })
  })
})

describe("a supervisor that handshakes and then keeps working", () => {
  test("is not killed when its startup deadline comes round", async () => {
    await withSandbox(async (box) => {
      // The deadline is for saying hello, and this one said hello at once.
      // Crossing it afterwards is what every Test Run longer than half a
      // minute does, and it must mean nothing: left armed, the timer sends
      // `SIGKILL` to a healthy supervisor mid-run and reports a run that was
      // passing as a launching-phase runner failure.
      const states: string[] = []
      const result = await runScripted(
        box,
        "ready-then-linger:600",
        { handshakeDeadlineMs: 200 },
        states,
      )

      if (!isTestRunSummary(result)) throw new Error(`expected a Test Run: ${result.outcome}`)

      // The stub writes no Result Bundle, so this run cannot end in a verdict
      // — and that is the point of naming the reason rather than avoiding
      // one. `resultBundleMissing` is a publication fact, reached only by a
      // supervisor that was left alone to finish. `runnerFailure` is where an
      // armed timer would have put it, and it is a different phase entirely.
      expect(result.reason).toBe("resultBundleMissing")

      // And said again in what the supervisor reported: a handshake, then a
      // completion it could only send by being alive to send it.
      expect(states).toContain("executionCompleted")

      // Asserted here rather than in a test of its own, and marked for what it
      // is: this one holds either way. A supervisor killed at its startup
      // deadline is confirmed gone, and a confirmed exit releases the root —
      // so releasing it proves nothing about the timer. It is worth saying
      // once that the healthy path ends with the slot back.
      expect(readQueue(box.storage).quarantine).toBeUndefined()
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  }, 20_000)
})
