/**
 * The stub-process suite (ADR 0001, Layer 2).
 *
 * These drive the real gate and the real supervisor against a real process
 * tree. What the stub buys us is determinism: a process that ignores `SIGINT`,
 * or leaves a descendant behind, or hangs past its deadline, on demand and in
 * milliseconds. Asking `xcodebuild` for any of those would be slow, flaky, and
 * dependent on a machine with Xcode installed.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { spawnGatedChild, type GatedChild } from "../../src/runner/gate.ts"
import { signallingIsSafe, systemProbe } from "../../src/runner/identity.ts"
import { createRunDirectory, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { superviseRun, type SupervisionResult } from "../../src/runner/supervisor.ts"
import {
  fakeProbe,
  IMMEDIATE_ESCALATION,
  monotonic,
  seedRun,
  sleep,
  STUB_PROCESS,
  withSandbox,
  type Sandbox,
} from "./harness.ts"

type StubOptions = {
  children?: number
  trap?: NodeJS.Signals[]
  lingerMs?: number
  exitCode?: number
  sleepMs?: number
}

function stubArgs(options: StubOptions): string[] {
  return [
    STUB_PROCESS,
    `--children=${options.children ?? 0}`,
    `--trap=${(options.trap ?? []).join(",")}`,
    `--linger-ms=${options.lingerMs ?? 0}`,
    `--exit=${options.exitCode ?? 0}`,
    `--sleep-ms=${options.sleepMs ?? 0}`,
  ]
}

type Controls = {
  /** Flips cancellation the moment the child publishes its identity. */
  cancelOnRecorded?: boolean
  cancelAfterMs?: number
  timeoutSeconds?: number
}

async function supervise(
  box: Sandbox,
  options: StubOptions,
  controls: Controls = {},
): Promise<{ result: SupervisionResult; log: string; runId: string }> {
  const runId = "run-supervision"
  const directory = createRunDirectory(box.storage, runId)
  expect(directory).toBeDefined()

  const record = seedRun(box.storage, {
    runId,
    timeoutSeconds: controls.timeoutSeconds ?? 900,
  })

  let aborted = false
  let announce: () => void = () => {}
  const whenAborted = new Promise<void>((resolve) => {
    announce = resolve
  })
  const cancel = () => {
    aborted = true
    announce()
  }

  if (controls.cancelAfterMs !== undefined) setTimeout(cancel, controls.cancelAfterMs)

  const now = monotonic()
  const result = await superviseRun(
    {
      storage: box.storage,
      probe: systemProbe,
      now,
      timestamp: () => new Date().toISOString(),
      sleep,
      escalation: IMMEDIATE_ESCALATION,
      startupDeadlineMs: 10_000,
      cancellation: {
        get aborted() {
          return aborted
        },
        whenAborted,
      },
      spawn: (): GatedChild => {
        const child = spawnGatedChild({
          command: process.execPath,
          args: stubArgs(options),
          cwd: box.homeDir,
          environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          logPath: join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog),
        })
        if (controls.cancelOnRecorded === true) {
          void child.recorded.then(cancel).catch(() => {})
        }
        return child
      },
    },
    { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } },
  )

  let log = ""
  try {
    log = readFileSync(join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog), "utf8")
  } catch {
    log = ""
  }

  return { result, log, runId }
}

describe("an ordinary run", () => {
  test("reaches executionCompleted with no termination trigger", async () => {
    await withSandbox(async (box) => {
      const { result, runId } = await supervise(box, { exitCode: 0 })

      expect(result.trigger).toBe("none")
      expect(result.termination.requested).toBe("no")
      expect(result.execution).toMatchObject({ execObserved: "yes", successfulExit: "yes", exitCode: 0 })
      expect(result.termination.descendantsConfirmedExited).toBe("yes")
      expect(result.quarantine).toBeUndefined()
      expect(readRunRecord(box.storage, runId)?.state).toBe("executionCompleted")
    })
  }, 30_000)

  test("captures both streams through one shared channel, in kernel order", async () => {
    await withSandbox(async (box) => {
      const { log } = await supervise(box, { exitCode: 0 })
      expect(log).toContain("started")
      expect(log.indexOf("started")).toBeLessThan(log.indexOf("exiting"))
    })
  }, 30_000)

  test("reports a non-zero exit without inventing a trigger for it", async () => {
    await withSandbox(async (box) => {
      const { result } = await supervise(box, { exitCode: 65 })
      expect(result.trigger).toBe("none")
      expect(result.execution).toMatchObject({ exitCode: 65, successfulExit: "no" })
    })
  }, 30_000)
})

describe("the gated launch protocol", () => {
  test("records the child's identity before it may execute anything", async () => {
    await withSandbox(async (box) => {
      const { result, runId } = await supervise(box, { exitCode: 0 })
      const record = readRunRecord(box.storage, runId)
      const child = record?.child
      expect(typeof child?.pid).toBe("number")
      expect(typeof child?.startedAt).toBe("string")
      // A detached leader's PGID is its own PID, so the group is fully determined.
      expect(child?.pgid).toBe(child?.pid ?? -1)
      expect(record?.startedAt).toBeDefined()
      expect(result.startedAt).toBeDefined()
    })
  }, 30_000)

  test("lets a cancelled launch exit without ever executing Xcode", async () => {
    await withSandbox(async (box) => {
      const { result, log } = await supervise(box, { sleepMs: 30_000 }, { cancelOnRecorded: true })

      // Cancelled before anything needed terminating: no trigger, no request.
      expect(result.trigger).toBe("none")
      expect(result.termination.requested).toBe("no")
      expect(result.interruptionPhase).toBe("launching")
      expect(result.execution.execObserved).toBe("no")
      // The stub never ran, so it never wrote its start marker.
      expect(log).not.toContain("started")
    })
  }, 30_000)
})

describe("caller cancellation", () => {
  test("fixes `cancelled` and records that termination was requested", async () => {
    await withSandbox(async (box) => {
      const { result } = await supervise(box, { sleepMs: 30_000 }, { cancelAfterMs: 300 })

      expect(result.trigger).toBe("callerCancellation")
      expect(result.termination.requested).toBe("yes")
      expect(result.interruptionPhase).toBe("testing")
      expect(result.execution.successfulExit).toBe("no")
    })
  }, 30_000)
})

describe("the process deadline", () => {
  test("fixes `timedOut` and is not displaced by a later cancellation", async () => {
    await withSandbox(async (box) => {
      const { result } = await supervise(
        box,
        { sleepMs: 30_000 },
        { timeoutSeconds: 1, cancelAfterMs: 2_500 },
      )

      expect(result.trigger).toBe("processDeadline")
      expect(result.deadlineCrossedPhase).toBe("testing")
      expect(result.interruptionPhase).toBeUndefined()
    })
  }, 30_000)
})

describe("bounded escalation", () => {
  test("sends SIGINT, then SIGTERM, then SIGKILL, in that order", async () => {
    await withSandbox(async (box) => {
      const { result, log } = await supervise(
        box,
        { sleepMs: 30_000, trap: ["SIGINT", "SIGTERM"] },
        { cancelAfterMs: 300 },
      )

      expect(log).toContain("trapped SIGINT")
      expect(log).toContain("trapped SIGTERM")
      expect(log.indexOf("trapped SIGINT")).toBeLessThan(log.indexOf("trapped SIGTERM"))
      // Only SIGKILL could actually end it, and a signalled exit is not a code.
      expect(result.execution.signal).toBe("SIGKILL")
      expect(result.execution.exitCode).toBeUndefined()
      expect(result.trigger).toBe("callerCancellation")
    })
  }, 30_000)

  test("stops escalating as soon as the group is gone", async () => {
    await withSandbox(async (box) => {
      const { result, log } = await supervise(
        box,
        { sleepMs: 30_000, trap: [] },
        { cancelAfterMs: 300 },
      )
      expect(result.execution.signal).toBe("SIGINT")
      expect(log).not.toContain("trapped")
    })
  }, 30_000)
})

describe("a descendant that outlives the direct process", () => {
  test("is reported as unconfirmed and quarantines the execution slot", async () => {
    await withSandbox(async (box) => {
      const { result, runId } = await supervise(box, { children: 1, lingerMs: 8_000, exitCode: 0 })

      expect(result.termination.descendantsConfirmedExited).toBe("no")
      expect(result.quarantine).toBeDefined()
      expect(readRunRecord(box.storage, runId)?.quarantined).toBe(true)
      // Nothing had fixed a trigger, so the supervision failure becomes one.
      expect(result.trigger).toBe("toolFailure")
      expect(result.failure).toEqual({ reason: "runnerFailure", phase: "terminating" })
    })
  }, 40_000)
})

describe("identity validation", () => {
  test("permits signalling only a live, matching, in-group recorded process", () => {
    const probe = fakeProbe({ processes: { 42: "start-a" }, groups: { 42: [42, 43] } })
    expect(signallingIsSafe(probe, { pgid: 42, processes: [{ pid: 42, startedAt: "start-a" }] })).toBe(true)
  })

  test("refuses to signal when a PID was reused by something else", () => {
    // The number is live and in the group, but it is not the process we recorded.
    const probe = fakeProbe({ processes: { 42: "start-b" }, groups: { 42: [42] } })
    expect(signallingIsSafe(probe, { pgid: 42, processes: [{ pid: 42, startedAt: "start-a" }] })).toBe(false)
  })

  test("refuses to signal a recorded process that has left the group", () => {
    const probe = fakeProbe({ processes: { 42: "start-a" }, groups: { 42: [99] } })
    expect(signallingIsSafe(probe, { pgid: 42, processes: [{ pid: 42, startedAt: "start-a" }] })).toBe(false)
  })

  test("refuses to signal a group whose recorded processes are all gone", () => {
    const probe = fakeProbe({ processes: {}, groups: { 42: [99] } })
    expect(signallingIsSafe(probe, { pgid: 42, processes: [{ pid: 42, startedAt: "start-a" }] })).toBe(false)
  })
})

describe("the termination trigger", () => {
  test("is durable before the first signal is sent, not after the run ends", async () => {
    // A crash mid-escalation must not leave recovery unable to tell a cancelled
    // run from a timed-out one.
    await withSandbox(async (box) => {
      const observed: Array<string | undefined> = []
      const runId = "run-supervision"

      const watching = {
        ...systemProbe,
        signalGroup(pgid: number, signal: NodeJS.Signals) {
          observed.push(readRunRecord(box.storage, runId)?.terminationTrigger)
          systemProbe.signalGroup(pgid, signal)
        },
      }

      const directory = createRunDirectory(box.storage, runId)
      expect(directory).toBeDefined()
      const record = seedRun(box.storage, { runId, timeoutSeconds: 900 })

      let aborted = false
      let announce: () => void = () => {}
      const whenAborted = new Promise<void>((resolve) => {
        announce = resolve
      })
      setTimeout(() => {
        aborted = true
        announce()
      }, 300)

      await superviseRun(
        {
          storage: box.storage,
          probe: watching,
          now: monotonic(),
          timestamp: () => new Date().toISOString(),
          sleep,
          escalation: IMMEDIATE_ESCALATION,
          startupDeadlineMs: 10_000,
          cancellation: {
            get aborted() {
              return aborted
            },
            whenAborted,
          },
          spawn: () =>
            spawnGatedChild({
              command: process.execPath,
              args: stubArgs({ sleepMs: 30_000 }),
              cwd: box.homeDir,
              environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
              logPath: join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog),
            }),
        },
        { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } },
      )

      expect(observed.length).toBeGreaterThan(0)
      // Every signal was sent with the trigger already on disk.
      for (const trigger of observed) expect(trigger).toBe("callerCancellation")
    })
  }, 30_000)
})

describe("a group that will not die", () => {
  test("does not make the supervisor wait indefinitely", async () => {
    // Signalling that achieves nothing and a drain that never empties are both
    // bounded; the run ends inside the termination window either way.
    await withSandbox(async (box) => {
      const runId = "run-stuck"
      createRunDirectory(box.storage, runId)
      const record = seedRun(box.storage, { runId, timeoutSeconds: 900 })

      const immortal = {
        identify: (pid: number) => ({ pid, startedAt: "immortal" }),
        membersOf: () => [4242],
        signalGroup: () => {},
      }

      const started = Date.now()
      const result = await superviseRun(
        {
          storage: box.storage,
          probe: immortal,
          now: monotonic(),
          timestamp: () => new Date().toISOString(),
          sleep,
          escalation: IMMEDIATE_ESCALATION,
          startupDeadlineMs: 5_000,
          spawn: () =>
            spawnGatedChild({
              command: process.execPath,
              args: stubArgs({ exitCode: 0 }),
              cwd: box.homeDir,
              environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
              logPath: join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog),
            }),
        },
        { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } },
      )

      expect(Date.now() - started).toBeLessThan(20_000)
      expect(result.termination.descendantsConfirmedExited).toBe("no")
      expect(result.quarantine).toBeDefined()
      expect(readRunRecord(box.storage, runId)?.quarantined).toBe(true)
    })
  }, 40_000)
})

describe("channel loss", () => {
  test("becomes the trigger when nothing else has fixed one", async () => {
    await withSandbox(async (box) => {
      const runId = "run-lost"
      createRunDirectory(box.storage, runId)
      const record = seedRun(box.storage, { runId, timeoutSeconds: 900 })

      const result = await superviseRun(
        {
          storage: box.storage,
          probe: systemProbe,
          now: monotonic(),
          timestamp: () => new Date().toISOString(),
          sleep,
          escalation: IMMEDIATE_ESCALATION,
          startupDeadlineMs: 10_000,
          channelLost: () => true,
          spawn: () =>
            spawnGatedChild({
              command: process.execPath,
              args: stubArgs({ exitCode: 0 }),
              cwd: box.homeDir,
              environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
              logPath: join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog),
            }),
        },
        { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } },
      )

      expect(result.trigger).toBe("toolFailure")
      expect(readRunRecord(box.storage, runId)?.terminationTrigger).toBe("toolFailure")
    })
  }, 30_000)

  test("never displaces a cancellation that already fixed the outcome", async () => {
    await withSandbox(async (box) => {
      const runId = "run-lost-after-cancel"
      createRunDirectory(box.storage, runId)
      const record = seedRun(box.storage, { runId, timeoutSeconds: 900 })

      let aborted = false
      let announce: () => void = () => {}
      const whenAborted = new Promise<void>((resolve) => {
        announce = resolve
      })
      setTimeout(() => {
        aborted = true
        announce()
      }, 200)

      const result = await superviseRun(
        {
          storage: box.storage,
          probe: systemProbe,
          now: monotonic(),
          timestamp: () => new Date().toISOString(),
          sleep,
          escalation: IMMEDIATE_ESCALATION,
          startupDeadlineMs: 10_000,
          channelLost: () => true,
          cancellation: {
            get aborted() {
              return aborted
            },
            whenAborted,
          },
          spawn: () =>
            spawnGatedChild({
              command: process.execPath,
              args: stubArgs({ sleepMs: 30_000 }),
              cwd: box.homeDir,
              environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
              logPath: join(box.storage.runsDir, runId, RUN_ARTIFACTS.rawLog),
            }),
        },
        { record, supervisorIdentity: { pid: process.pid, startedAt: "test" } },
      )

      expect(result.trigger).toBe("callerCancellation")
    })
  }, 30_000)
})
