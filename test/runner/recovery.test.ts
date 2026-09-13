/**
 * Crash reconciliation and quarantine (#3).
 *
 * The states these cover cannot be produced on a real machine on demand — a
 * PID that has been reused, a group whose number is live but whose members are
 * somebody else's — so the probe is declared rather than observed. What is real
 * is the durable state on disk, which is what recovery actually reasons from.
 */

import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"

import { readQueue, writeQueue } from "../../src/runner/queue.ts"
import { quarantineSlot, reconcileRoot } from "../../src/runner/recovery.ts"
import { metadataPath, readRunRecord } from "../../src/runner/state.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"
import { fakeProbe, seedRun, withSandbox, type Sandbox } from "./harness.ts"

const TIMESTAMP = "2026-09-13T11:00:00.000Z"

function reconcile(box: Sandbox, world: Parameters<typeof fakeProbe>[0], signal?: { aborted: boolean }) {
  return reconcileRoot({
    storage: box.storage,
    probe: fakeProbe(world),
    timestamp: () => TIMESTAMP,
    ...(signal === undefined ? {} : { signal }),
  })
}

function seedDirectory(box: Sandbox, runId: string): void {
  createRunDirectory(box.storage, runId)
}

describe("an admitted run with no durable supervisor identity", () => {
  test("is finalized without rerunning, because Xcode provably never started", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-a")
      seedRun(box.storage, { runId: "run-a", state: "admitted" })
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-a" })

      const report = reconcile(box, { processes: {} })

      expect(report.status).toBe("recovered")
      expect(report.finalized).toEqual(["run-a"])
      const record = readRunRecord(box.storage, "run-a")
      expect(record?.state).toBe("completed")
      expect(record?.execObserved).toBe("no")
      expect(record?.completedAt).toBe(TIMESTAMP)
    })
  })

  test("gives the execution slot back", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-a")
      seedRun(box.storage, { runId: "run-a", state: "admitted" })
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-a" })

      reconcile(box, { processes: {} })
      expect(readQueue(box.storage).activeRunId).toBeUndefined()
    })
  })
})

describe("a run whose child is still alive", () => {
  test("is reported busy and left entirely alone", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-live")
      seedRun(box.storage, {
        runId: "run-live",
        state: "launchAuthorized",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })

      const report = reconcile(box, {
        processes: { 100: "s", 200: "c" },
        groups: { 200: [200] },
      })

      expect(report.status).toBe("busy")
      expect(report.finalized).toEqual([])
      expect(readRunRecord(box.storage, "run-live")?.state).toBe("launchAuthorized")
    })
  })

  test("is busy on a live supervisor alone, even with the child gone", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-sup")
      seedRun(box.storage, {
        runId: "run-sup",
        state: "childRecorded",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })

      expect(reconcile(box, { processes: { 100: "s" }, groups: {} }).status).toBe("busy")
    })
  })
})

describe("a run whose recorded identities are all gone", () => {
  test("is finalized from its immutable artifacts, never rerun", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-dead")
      seedRun(box.storage, {
        runId: "run-dead",
        state: "launchAuthorized",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
        descendantsConfirmedExited: "unknown",
      })

      const report = reconcile(box, { processes: {}, groups: {} })
      expect(report.finalized).toEqual(["run-dead"])
      expect(readRunRecord(box.storage, "run-dead")?.state).toBe("completed")
    })
  })

  test("treats a reused PID as gone rather than as its original process", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-reused")
      seedRun(box.storage, {
        runId: "run-reused",
        state: "launchAuthorized",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })

      // Both numbers are live, and neither is ours.
      const report = reconcile(box, {
        processes: { 100: "someone-else", 200: "someone-else" },
        groups: { 200: [200] },
      })

      expect(report.finalized).toEqual(["run-reused"])
    })
  })

  test("keeps its original runId, so it stays inspectable", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-keep")
      seedRun(box.storage, {
        runId: "run-keep",
        state: "executionCompleted",
        supervisor: { pid: 100, startedAt: "s" },
      })
      reconcile(box, { processes: {} })
      expect(readRunRecord(box.storage, "run-keep")?.runId).toBe("run-keep")
    })
  })
})

describe("an uncertain lifecycle", () => {
  test("holds the quarantine rather than releasing the slot", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-uncertain")
      seedRun(box.storage, {
        runId: "run-uncertain",
        state: "launchAuthorized",
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })

      // The child's identity still matches, but it is no longer in the recorded
      // group: signalling would be unsafe and its exit is unproven.
      const report = reconcile(box, { processes: { 200: "c" }, groups: { 200: [999] } })

      expect(report.status).toBe("stillQuarantined")
      expect(report.uncertain).toEqual(["run-uncertain"])
      expect(readRunRecord(box.storage, "run-uncertain")?.state).toBe("launchAuthorized")
    })
  })

  test("treats unreadable durable state as uncertainty, not as absence", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-corrupt")
      writeFileSync(metadataPath(box.storage, "run-corrupt"), "{ not json", { mode: 0o600 })

      const report = reconcile(box, { processes: {} })
      expect(report.status).toBe("stillQuarantined")
      expect(report.uncertain).toEqual(["run-corrupt"])
    })
  })
})

describe("quarantine", () => {
  test("clears once every recorded identity is confirmed gone", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-q")
      seedRun(box.storage, {
        runId: "run-q",
        state: "completed",
        completedAt: TIMESTAMP,
        supervisor: { pid: 100, startedAt: "s" },
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })
      quarantineSlot(box.storage, "run-q", "unconfirmed lifecycle", TIMESTAMP)

      const report = reconcile(box, { processes: {}, groups: {} })
      expect(report.quarantineCleared).toBe(true)
      expect(readQueue(box.storage).quarantine).toBeUndefined()
    })
  })

  test("is preserved while a recorded identity is still live", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-q")
      seedRun(box.storage, {
        runId: "run-q",
        state: "completed",
        completedAt: TIMESTAMP,
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })
      quarantineSlot(box.storage, "run-q", "unconfirmed lifecycle", TIMESTAMP)

      const report = reconcile(box, { processes: { 200: "c" }, groups: { 200: [200] } })
      expect(report.quarantineCleared).toBe(false)
      expect(readQueue(box.storage).quarantine).toBeDefined()
    })
  })

  test("does not survive numeric PGID reuse alone", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-q")
      seedRun(box.storage, {
        runId: "run-q",
        state: "completed",
        completedAt: TIMESTAMP,
        child: { pid: 200, startedAt: "c", pgid: 200 },
      })
      quarantineSlot(box.storage, "run-q", "unconfirmed lifecycle", TIMESTAMP)

      // The group number is busy again, but with processes that are not ours.
      const report = reconcile(box, {
        processes: { 200: "someone-else" },
        groups: { 200: [200, 201] },
      })
      expect(report.quarantineCleared).toBe(true)
    })
  })
})

describe("cancelling recovery", () => {
  test("stops future work without undoing what it already finished", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-a")
      seedRun(box.storage, { runId: "run-a", state: "admitted" })

      const report = reconcile(box, { processes: {} }, { aborted: true })
      expect(report.status).toBe("cancelled")
      expect(readRunRecord(box.storage, "run-a")?.state).toBe("admitted")
    })
  })
})

describe("a healthy root", () => {
  test("reports alreadyHealthy without touching anything", async () => {
    await withSandbox((box) => {
      seedDirectory(box, "run-done")
      seedRun(box.storage, { runId: "run-done", state: "completed", completedAt: TIMESTAMP })

      const report = reconcile(box, { processes: {} })
      expect(report).toMatchObject({ status: "alreadyHealthy", finalized: [], uncertain: [] })
    })
  })
})
