/**
 * Durable FIFO admission (#3).
 *
 * The queue is the only thing standing between two OpenCode instances on one
 * worktree and two concurrent `xcodebuild` processes sharing a DerivedData
 * directory, so these tests care less about throughput than about the two
 * properties that make it trustworthy: a newer ticket never overtakes an older
 * live one, and every exit path gives the slot back.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"

import {
  admit,
  CoordinationStateError,
  MINIMUM_FREE_BYTES,
  readQueue,
  reap,
  releaseSlot,
  writeQueue,
  type AdmissionEnvironment,
} from "../../src/runner/queue.ts"
import { quarantineSlot, reconcileRoot } from "../../src/runner/recovery.ts"
import { fakeProbe, sleep, withSandbox, type Sandbox } from "./harness.ts"

const OWNER = { pid: 1000, startedAt: "owner-start" }

function environmentFor(
  box: Sandbox,
  overrides: Partial<AdmissionEnvironment> = {},
): AdmissionEnvironment {
  let clock = 0
  return {
    storage: box.storage,
    probe: fakeProbe({ processes: { 1000: "owner-start" } }),
    now: () => (clock += 10),
    timestamp: () => "2026-09-13T10:00:00.000Z",
    freeBytes: () => MINIMUM_FREE_BYTES * 4,
    owner: OWNER,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    ...overrides,
  }
}

describe("admission", () => {
  test("hands the root's execution slot to exactly one run", async () => {
    await withSandbox(async (box) => {
      const result = await admit(environmentFor(box))
      expect(result.status).toBe("admitted")
      expect(result.status === "admitted" && result.runId).toMatch(/^[0-9a-f]{32}$/)
      expect(readQueue(box.storage).activeRunId).toBeDefined()
    })
  })

  test("reports the queue duration it actually made the caller wait", async () => {
    await withSandbox(async (box) => {
      const result = await admit(environmentFor(box))
      expect(result.queuedAt).toBe("2026-09-13T10:00:00.000Z")
      expect(result.queueDurationMs).toBeGreaterThan(0)
    })
  })

  test("refuses a second run while the slot is held, then admits it once freed", async () => {
    await withSandbox(async (box) => {
      const first = await admit(environmentFor(box))
      expect(first.status).toBe("admitted")

      const blocked = await admit(environmentFor(box), { waitDeadlineMs: 30 })
      expect(blocked).toMatchObject({ status: "failed", reason: "concurrencyWaitTimedOut" })

      if (first.status === "admitted") await releaseSlot(box.storage, first.runId)
      const second = await admit(environmentFor(box))
      expect(second.status).toBe("admitted")
    })
  })

  test("leaves no ticket behind when the wait expires", async () => {
    await withSandbox(async (box) => {
      await admit(environmentFor(box))
      await admit(environmentFor(box), { waitDeadlineMs: 30 })
      expect(readQueue(box.storage).tickets).toEqual([])
    })
  })

  test("returns `cancelled` with queued timing and no run", async () => {
    await withSandbox(async (box) => {
      const result = await admit(environmentFor(box), { signal: { aborted: true } })
      expect(result.status).toBe("cancelled")
      expect(result).not.toHaveProperty("runId")
      expect(result.queuedAt).toBeDefined()
    })
  })

  test("fails closed on insufficient storage before anything is allocated", async () => {
    await withSandbox(async (box) => {
      const result = await admit(
        environmentFor(box, { freeBytes: () => MINIMUM_FREE_BYTES - 1 }),
      )
      expect(result).toMatchObject({ status: "failed", reason: "insufficientStorage" })
      expect(readQueue(box.storage).tickets).toEqual([])
    })
  })

  test("fails immediately when the execution slot is quarantined", async () => {
    await withSandbox(async (box) => {
      quarantineSlot(box.storage, "run-earlier", "unconfirmed lifecycle", "2026-09-13T09:00:00.000Z")
      const result = await admit(environmentFor(box), { waitDeadlineMs: 5_000 })
      expect(result).toMatchObject({ status: "failed", reason: "executionSlotQuarantined" })

      // Only recovery clears a quarantine, and only after identity-safe
      // confirmation that nothing attributable to the run is still running.
      reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ processes: {} }),
        timestamp: () => "2026-09-13T10:00:00.000Z",
      })
      expect(
        (
          await admit(environmentFor(box), {
            prepare: () => true,
          })
        ).status,
      ).toBe("admitted")
    })
  })
})

describe("the FIFO ordering", () => {
  test("gives an older live ticket the slot before a newer one", async () => {
    await withSandbox(async (box) => {
      const environment = environmentFor(box)
      // An older ticket, owned by a live process that is not this one.
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 5,
        tickets: [
          {
            sequence: 4,
            ticketId: "older",
            owner: { pid: 1000, startedAt: "owner-start" },
            createdAt: "2026-09-13T09:59:00.000Z",
            deadlineAtMs: 1_000_000,
          },
        ],
      })

      const result = await admit(environment, { waitDeadlineMs: 40 })
      expect(result).toMatchObject({ status: "failed", reason: "concurrencyWaitTimedOut" })
      // The older ticket is untouched; only our own was withdrawn.
      expect(readQueue(box.storage).tickets.map((ticket) => ticket.ticketId)).toEqual(["older"])
    })
  })

  test("allocates immutable, monotonically increasing sequences", async () => {
    await withSandbox(async (box) => {
      const environment = environmentFor(box)
      await admit(environment)
      const afterFirst = readQueue(box.storage).nextSequence
      await admit(environment, { waitDeadlineMs: 20 })
      expect(readQueue(box.storage).nextSequence).toBeGreaterThan(afterFirst)
    })
  })
})

describe("reaping", () => {
  test("drops a ticket whose owner is provably gone", async () => {
    await withSandbox(async (box) => {
      const environment = environmentFor(box, { probe: fakeProbe({ processes: {} }) })
      const state = reap(environment, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [
          {
            sequence: 1,
            ticketId: "dead",
            owner: { pid: 4242, startedAt: "gone" },
            createdAt: "x",
            deadlineAtMs: 1_000_000,
          },
        ],
      })
      expect(state.tickets).toEqual([])
    })
  })

  test("drops a ticket whose PID was reused by something else", async () => {
    await withSandbox(async (box) => {
      const environment = environmentFor(box, {
        probe: fakeProbe({ processes: { 4242: "a-different-process" } }),
      })
      const state = reap(environment, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [
          {
            sequence: 1,
            ticketId: "reused",
            owner: { pid: 4242, startedAt: "gone" },
            createdAt: "x",
            deadlineAtMs: 1_000_000,
          },
        ],
      })
      expect(state.tickets).toEqual([])
    })
  })

  test("keeps a live owner's ticket, and its place in line", async () => {
    await withSandbox(async (box) => {
      const environment = environmentFor(box, {
        probe: fakeProbe({ processes: { 7: "live", 8: "live" } }),
      })
      const tickets = [7, 8].map((pid, index) => ({
        sequence: index + 1,
        ticketId: `t${pid}`,
        owner: { pid, startedAt: "live" },
        createdAt: "x",
        deadlineAtMs: 1_000_000,
      }))
      const state = reap(environment, { schemaVersion: 1, nextSequence: 3, tickets })
      expect(state.tickets.map((ticket) => ticket.ticketId)).toEqual(["t7", "t8"])
    })
  })

  test("drops an expired ticket even when its owner is alive", async () => {
    await withSandbox(async (box) => {
      const environment = environmentFor(box, { now: () => 5_000 })
      const state = reap(environment, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [
          { sequence: 1, ticketId: "stale", owner: OWNER, createdAt: "x", deadlineAtMs: 1_000 },
        ],
      })
      expect(state.tickets).toEqual([])
    })
  })
})

describe("malformed coordination state", () => {
  test("fails closed rather than starting from an assumed-empty queue", async () => {
    await withSandbox((box) => {
      writeFileSync(box.storage.queueFile, "{ not json", { mode: 0o600 })
      expect(() => readQueue(box.storage)).toThrow(CoordinationStateError)
    })
  })

  test("preserves the suspect file rather than discarding it", async () => {
    await withSandbox(async (box) => {
      writeFileSync(box.storage.queueFile, "{ not json", { mode: 0o600 })
      try {
        readQueue(box.storage)
      } catch {
        // expected
      }
      expect(Bun.file(box.storage.queueFile).size).toBeGreaterThan(0)
      await sleep(0)
    })
  })
})

describe("a root lock someone else is holding (issue #153)", () => {
  /**
   * Hold `path` from another process for `ms`, resolving once it is held.
   *
   * Another process rather than a second open here, because the property is
   * about this thread: a blocking acquisition would wait on a lock nothing on
   * this thread could ever release.
   */
  function holdElsewhere(path: string, ms: number): Promise<void> {
    const script = `
      const fs = require("node:fs")
      const fd = fs.openSync(${JSON.stringify(path)}, fs.constants.O_CREAT | fs.constants.O_RDWR | 0x20, 0o600)
      process.stdout.write("held\\n")
      setTimeout(() => { fs.closeSync(fd); process.exit(0) }, ${ms})
    `
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] })
    return new Promise((resolve) => child.stdout?.once("data", () => resolve()))
  }

  test("is waited for without holding this thread's event loop", async () => {
    await withSandbox(async (box) => {
      await holdElsewhere(box.storage.rootLock, 600)

      let worst = 0
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last - 10)
        last = now
      }, 10)
      const result = await admit(
        environmentFor(box, { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }),
      )
      await sleep(30)
      clearInterval(timer)

      // Housekeeping holds a root lock while it reclaims, and on its own
      // thread it can now be doing so while this host admits a run. Waiting
      // for it has to cost the caller time, never the host its event loop.
      expect(result.status).toBe("admitted")
      expect(worst).toBeLessThan(150)
    })
  }, 10_000)

  test("is waited for the same way when a slot is given back", async () => {
    await withSandbox(async (box) => {
      const first = await admit(environmentFor(box))
      if (first.status !== "admitted") throw new Error(`expected admission: ${first.status}`)
      await holdElsewhere(box.storage.rootLock, 600)

      let worst = 0
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last - 10)
        last = now
      }, 10)
      await releaseSlot(box.storage, first.runId)
      await sleep(30)
      clearInterval(timer)

      expect(readQueue(box.storage).activeRunId).toBeUndefined()
      expect(worst).toBeLessThan(150)
    })
  }, 10_000)
})
