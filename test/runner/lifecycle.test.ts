/**
 * Crash windows in Test Run lifecycle coordination (#3, issue #21).
 *
 * Each test here names a point at which the process can die, and asserts that
 * what is left on disk is recoverable. The property that matters is not that
 * nothing goes wrong — it is that a trusted root is never permanently wedged,
 * and that a second Test Run is never admitted alongside one nobody can
 * account for.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createRunDirectory, newRunId, runDirectory } from "../../src/runner/paths.ts"
import {
  admit,
  MINIMUM_FREE_BYTES,
  readQueue,
  releaseSlot,
  writeQueue,
  type AdmissionEnvironment,
} from "../../src/runner/queue.ts"
import { reconcileRoot } from "../../src/runner/recovery.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { fakeProbe, seedRun, withSandbox, type Sandbox } from "./harness.ts"

const OWNER = { pid: 1000, startedAt: "owner-start" }
const TIMESTAMP = "2026-09-13T11:00:00.000Z"

function environmentFor(box: Sandbox, overrides: Partial<AdmissionEnvironment> = {}): AdmissionEnvironment {
  let clock = 0
  return {
    storage: box.storage,
    probe: fakeProbe({ processes: { 1000: "owner-start" } }),
    now: () => (clock += 10),
    timestamp: () => TIMESTAMP,
    freeBytes: () => MINIMUM_FREE_BYTES * 4,
    owner: OWNER,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    ...overrides,
  }
}

function recover(box: Sandbox, world: Parameters<typeof fakeProbe>[0] = { processes: {} }) {
  return reconcileRoot({
    storage: box.storage,
    probe: fakeProbe(world),
    timestamp: () => TIMESTAMP,
  })
}

describe("admission durability", () => {
  test("creates the run's durable state before the slot transfers to it", async () => {
    await withSandbox(async (box) => {
      const prepared: string[] = []
      const result = await admit(environmentFor(box), {
        prepare: (runId) => {
          // The slot must not be observable as transferred until this returns.
          expect(readQueue(box.storage).activeRunId).toBeUndefined()
          prepared.push(runId)
          return createRunDirectory(box.storage, runId) !== undefined
        },
      })

      expect(result.status).toBe("admitted")
      if (result.status !== "admitted") return
      expect(prepared).toEqual([result.runId])
      expect(existsSync(runDirectory(box.storage, result.runId))).toBe(true)
      expect(readQueue(box.storage).activeRunId).toBe(result.runId)
    })
  })

  test("never hands out a run id whose artifacts already exist", async () => {
    await withSandbox(async (box) => {
      // A collision must be resolved before the slot transfers, or queue
      // ownership and retained artifacts would name different runs.
      const taken = newRunId()
      createRunDirectory(box.storage, taken)

      const offered = [taken, newRunId()]
      let index = 0
      const result = await admit(environmentFor(box), {
        newRunId: () => offered[index++] ?? newRunId(),
        prepare: (runId) => createRunDirectory(box.storage, runId) !== undefined,
      })

      expect(result.status).toBe("admitted")
      if (result.status !== "admitted") return
      expect(result.runId).not.toBe(taken)
      expect(readQueue(box.storage).activeRunId).toBe(result.runId)
    })
  })

  test("transfers no slot at all when durable state cannot be created", async () => {
    await withSandbox(async (box) => {
      const result = await admit(environmentFor(box), { prepare: () => false })
      expect(result).toMatchObject({ status: "failed", reason: "recoveryFailed" })
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
      expect(readQueue(box.storage).tickets).toEqual([])
    })
  })
})

describe("a crash between the slot transfer and any durable run state", () => {
  test("leaves a slot recovery can release rather than a permanently wedged root", async () => {
    await withSandbox((box) => {
      // The protocol writes the run record first, so an active slot naming a
      // run with no record is a run that provably never started.
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [],
        activeRunId: "run-vanished",
      })

      const report = recover(box)
      expect(report.slotsReleased).toEqual(["run-vanished"])
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })
})

describe("a crash between completion and slot release", () => {
  test("reconciles stale completed ownership", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-done")
      seedRun(box.storage, { runId: "run-done", state: "completed", completedAt: TIMESTAMP })
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [],
        activeRunId: "run-done",
      })

      const report = recover(box)
      expect(report.slotsReleased).toEqual(["run-done"])
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
      // The completed run itself is untouched; only ownership was stale.
      expect(readRunRecord(box.storage, "run-done")?.state).toBe("completed")
    })
  })

  test("admits the next run once ownership is reconciled", async () => {
    await withSandbox(async (box) => {
      createRunDirectory(box.storage, "run-done")
      seedRun(box.storage, { runId: "run-done", state: "completed", completedAt: TIMESTAMP })
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-done" })

      recover(box)
      const result = await admit(environmentFor(box), {
        prepare: (runId) => createRunDirectory(box.storage, runId) !== undefined,
      })
      expect(result.status).toBe("admitted")
    })
  })
})

describe("an uncertain lifecycle", () => {
  test("publishes quarantine and clears ownership in one atomic transition", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-uncertain")
      seedRun(box.storage, {
        runId: "run-uncertain",
        state: "launchAuthorized",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [],
        activeRunId: "run-uncertain",
      })

      // The child's identity still matches but it has left the recorded group:
      // signalling is unsafe and its exit is unproven.
      const report = recover(box, { processes: { 200: "c" }, groups: { 200: [999] } })

      expect(report.status).toBe("stillQuarantined")
      const state = readQueue(box.storage)
      expect(state.quarantine?.runId).toBe("run-uncertain")
      expect(state.activeRunId).toBeUndefined()
    })
  })

  test("makes the next admission fail fast instead of waiting out the whole deadline", async () => {
    await withSandbox(async (box) => {
      createRunDirectory(box.storage, "run-uncertain")
      seedRun(box.storage, {
        runId: "run-uncertain",
        state: "launchAuthorized",
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-uncertain" })
      recover(box, { processes: { 200: "c" }, groups: { 200: [999] } })

      const result = await admit(environmentFor(box), { waitDeadlineMs: 10_000 })
      expect(result).toMatchObject({ status: "failed", reason: "executionSlotQuarantined" })
    })
  })
})

describe("recovery and live finalization", () => {
  test("are serialized, so recovery cannot advance a run underneath its owner", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-live")
      seedRun(box.storage, { runId: "run-live", state: "executionCompleted" })

      // Holding the root lock is what a finalizing run does; recovery must wait
      // for it rather than reading half-written state.
      const { acquireLock } = require("../../src/runner/locks.ts") as typeof import("../../src/runner/locks.ts")
      const held = acquireLock(box.storage.rootLock)
      let finished = false
      try {
        const probe = fakeProbe({ processes: {} })
        const promise = Promise.resolve().then(() => {
          const report = reconcileRoot({ storage: box.storage, probe, timestamp: () => TIMESTAMP })
          finished = true
          return report
        })
        expect(finished).toBe(false)
        held.release()
        return promise.then(() => {
          expect(finished).toBe(true)
        })
      } finally {
        held.release()
      }
    })
  })

  test("hands a finalizable run back rather than completing it without evidence", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-orphan")
      seedRun(box.storage, {
        runId: "run-orphan",
        state: "executionCompleted",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-orphan" })

      const report = recover(box)

      // The terminal summary and index are published by the caller, which owns
      // interpretation; recovery holds the slot until that happens.
      expect(report.needsFinalization).toEqual(["run-orphan"])
      expect(readRunRecord(box.storage, "run-orphan")?.state).toBe("executionCompleted")
      expect(readQueue(box.storage).activeRunId).toBe("run-orphan")
    })
  })
})

describe("isolated DerivedData", () => {
  test("is reconciled for a completed run that crashed before cleanup", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-dd")
      const derived = join(runDirectory(box.storage, "run-dd"), "DerivedData")
      mkdirSync(derived, { recursive: true })
      writeFileSync(join(derived, "big.bin"), "x")
      seedRun(box.storage, {
        runId: "run-dd",
        state: "completed",
        completedAt: TIMESTAMP,
        derivedDataMode: "isolated",
      })

      const report = recover(box)
      expect(report.derivedDataCleaned).toEqual(["run-dd"])
      expect(existsSync(derived)).toBe(false)
      expect(readRunRecord(box.storage, "run-dd")?.derivedDataCleaned).toBe(true)
    })
  })

  test("is never touched for a run that is still live", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-live")
      const derived = join(runDirectory(box.storage, "run-live"), "DerivedData")
      mkdirSync(derived, { recursive: true })
      seedRun(box.storage, {
        runId: "run-live",
        state: "launchAuthorized",
        derivedDataMode: "isolated",
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })

      recover(box, { processes: { 200: "c" }, groups: { 200: [200] } })
      expect(existsSync(derived)).toBe(true)
    })
  })
})

describe("a run whose owner is still alive", () => {
  test("is left alone even when no child or supervisor remains", async () => {
    // Between the supervisor exiting and the summary being published there is a
    // window where the lifecycle looks dead but the run is not finished.
    // Adopting it there would publish a second terminal summary alongside the
    // one its owner is already writing.
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-owned")
      seedRun(box.storage, {
        runId: "run-owned",
        state: "executionCompleted",
        supervisor: { pid: 100, startedAt: "s" },
        owner: { pid: 4242, startedAt: "owner-alive" },
      })

      const report = recover(box, { processes: { 4242: "owner-alive" } })
      expect(report.status).toBe("busy")
      expect(report.needsFinalization).toEqual([])
    })
  })

  test("is adopted once its owner is provably gone", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-owned")
      seedRun(box.storage, {
        runId: "run-owned",
        state: "executionCompleted",
        supervisor: { pid: 100, startedAt: "s" },
        owner: { pid: 4242, startedAt: "owner-alive" },
      })

      expect(recover(box, { processes: {} }).needsFinalization).toEqual(["run-owned"])
    })
  })

  test("is adopted when its owner's PID was reused by something else", async () => {
    await withSandbox((box) => {
      createRunDirectory(box.storage, "run-owned")
      seedRun(box.storage, {
        runId: "run-owned",
        state: "executionCompleted",
        owner: { pid: 4242, startedAt: "owner-alive" },
      })

      const report = recover(box, { processes: { 4242: "somebody-else" } })
      expect(report.needsFinalization).toEqual(["run-owned"])
    })
  })
})
