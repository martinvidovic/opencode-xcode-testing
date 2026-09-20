/**
 * Quarantine clearance (#3, issue #35).
 *
 * Quarantine exists to stop a second `xcodebuild` starting alongside one
 * nobody can account for. That makes it dangerous in exactly two directions,
 * and both are tested here: a root released while something attributable is
 * still running, and a root held forever after everything has gone.
 *
 * The second is the easier failure to ship, because it looks like caution. It
 * is not — a containment root that can never be used again has the same practical
 * effect as a tool that does not work, and the only way out is deleting state
 * by hand.
 */

import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"

import { createRunDirectory, runDirectory } from "../../src/runner/paths.ts"
import {
  admit,
  MINIMUM_FREE_BYTES,
  QUARANTINE_REASON,
  readQueue,
  releaseSlot,
  writeQueue,
  type AdmissionEnvironment,
} from "../../src/runner/queue.ts"
import { withLock } from "../../src/runner/locks.ts"
import { reconcileRoot } from "../../src/runner/recovery.ts"
import { fakeProbe, seedRun, withSandbox, type Sandbox } from "./harness.ts"

const RUN = "run-quarantined"
const TIMESTAMP = "2026-09-14T09:00:00.000Z"

/** Publish a quarantine held by `runId`, as a crashed run would have left it. */
function holdRoot(box: Sandbox, runId = RUN): void {
  writeQueue(box.storage, {
    schemaVersion: 1,
    nextSequence: 1,
    tickets: [],
    quarantine: { runId, reason: QUARANTINE_REASON, since: TIMESTAMP },
  })
}

/** A completed run that recorded its own quarantine, and then the crash. */
function seedQuarantined(box: Sandbox, overrides: Parameters<typeof seedRun>[1] = { runId: RUN }) {
  createRunDirectory(box.storage, overrides.runId)
  return seedRun(box.storage, {
    state: "completed",
    completedAt: TIMESTAMP,
    quarantined: true,
    quarantineReason: QUARANTINE_REASON,
    ...overrides,
  })
}

function published(box: Sandbox): boolean {
  return readQueue(box.storage).quarantine !== undefined
}

describe("a root quarantined by a run whose processes have gone", () => {
  test("clears, rather than holding the root forever", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
        child: { pid: 4243, startedAt: "child-start", pgid: 4243 },
      })
      holdRoot(box)

      // Nothing recorded is alive any more: no process table entry, no group.
      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({}),
        timestamp: () => TIMESTAMP,
      })

      expect(published(box)).toBe(false)
      expect(report.uncertain).toEqual([])
      expect(report.status).toBe("recovered")
    })
  })

  test("clears a quarantine that an earlier pass had already published", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
      })
      holdRoot(box)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({}),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(true)
      expect(published(box)).toBe(false)
    })
  })

  test("clears when the run's artifacts are gone entirely", async () => {
    await withSandbox((box) => {
      // Retention evicted it. There is nothing left to attribute anything to,
      // and holding a root over a run that no longer exists is the one failure
      // quarantine must not have.
      holdRoot(box)
      rmSync(runDirectory(box.storage, RUN), { recursive: true, force: true })

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({}),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(true)
      expect(published(box)).toBe(false)
    })
  })
})

describe("a root quarantined by a run something still belongs to", () => {
  test("stays held while an identity-validated group member is alive", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        child: { pid: 4243, startedAt: "child-start", pgid: 4243 },
      })

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({
          processes: { 4243: "child-start" },
          groups: { 4243: [4243] },
        }),
        timestamp: () => TIMESTAMP,
      })

      expect(published(box)).toBe(true)
      expect(report.quarantineCleared).toBe(false)
    })
  })

  test("stays held while the supervisor is still the one that was recorded", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
      })

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ processes: { 4242: "supervisor-start" } }),
        timestamp: () => TIMESTAMP,
      })

      expect(published(box)).toBe(true)
      expect(report.quarantineCleared).toBe(false)
    })
  })

  test("releases once a reused PID proves the recorded process is gone", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
      })
      holdRoot(box)

      // The number is in use again, by something that started at a different
      // time. Numeric reuse alone must not hold a root forever.
      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ processes: { 4242: "something-else-entirely" } }),
        timestamp: () => TIMESTAMP,
      })

      expect(published(box)).toBe(false)
      expect(report.status).toBe("recovered")
    })
  })

  test("stays held over descendants that were never confirmed gone", async () => {
    await withSandbox((box) => {
      // `xcodebuild` spawns processes this tool never sees, so there is no
      // identity to ask about. Reading "nothing recorded survives" as "nothing
      // is running" would clear exactly the quarantine this condition raises.
      seedQuarantined(box, {
        runId: RUN,
        child: { pid: 200, startedAt: "child-start", pgid: 200 },
        descendantsConfirmedExited: "no",
      })
      holdRoot(box)

      // The child itself is gone and its group is not: a group number cannot
      // be reassigned while the group still has members, so 201 is ours.
      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ groups: { 200: [201] } }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(false)
      expect(published(box)).toBe(true)
    })
  })

  test("releases once that group has finally emptied", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        child: { pid: 200, startedAt: "child-start", pgid: 200 },
        descendantsConfirmedExited: "no",
      })
      holdRoot(box)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({}),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(true)
      expect(published(box)).toBe(false)
    })
  })

  test("releases when the group's number has been recycled by a stranger", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        child: { pid: 200, startedAt: "child-start", pgid: 200 },
        descendantsConfirmedExited: "no",
      })
      holdRoot(box)

      // The number is in use by a process that is not the one recorded, so it
      // was recycled and its members are strangers. Holding on their account
      // would keep the root held for as long as they happened to own it.
      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({
          processes: { 200: "a-completely-different-program" },
          groups: { 200: [200, 201] },
        }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(true)
    })
  })

  test("clears even though the OpenCode that started it is still running", async () => {
    await withSandbox((box) => {
      // The owner is the editor the user is sitting in front of. It outlives
      // the run by hours, so holding the root until it exits is holding the
      // root until the user quits OpenCode — with the artifacts, and the
      // quarantine, surviving the restart. The run itself is durably over:
      // nothing that executed it is left.
      seedQuarantined(box, {
        runId: RUN,
        owner: { pid: 900, startedAt: "owner-start" },
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
        child: { pid: 4243, startedAt: "child-start", pgid: 4243 },
        descendantsConfirmedExited: "yes",
      })
      holdRoot(box)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ processes: { 900: "owner-start" } }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(true)
      expect(published(box)).toBe(false)
    })
  })

  test("stays held while its gated child is alive, whatever the owner is doing", async () => {
    await withSandbox((box) => {
      // The child is the process that leads the group `xcodebuild` runs in.
      // It is alive and it is the one recorded, so the run really is still
      // writing to the DerivedData a second admission would share.
      seedQuarantined(box, {
        runId: RUN,
        owner: { pid: 900, startedAt: "owner-start" },
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
        child: { pid: 4243, startedAt: "child-start", pgid: 4243 },
      })
      holdRoot(box)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({
          processes: { 900: "owner-start", 4243: "child-start" },
          groups: { 4243: [4243] },
        }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(false)
      expect(published(box)).toBe(true)
    })
  })

  test("stays held while unrecorded descendants still answer, whatever the owner is doing", async () => {
    await withSandbox((box) => {
      // The hard case: everything recorded has gone, the run never confirmed
      // its descendants exited, and the group number is free of a leader but
      // not of members. A group number cannot be reassigned while the group
      // has members, so whatever is answering there is ours.
      seedQuarantined(box, {
        runId: RUN,
        owner: { pid: 900, startedAt: "owner-start" },
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
        child: { pid: 4243, startedAt: "child-start", pgid: 4243 },
        descendantsConfirmedExited: "unknown",
      })
      holdRoot(box)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({
          processes: { 900: "owner-start" },
          groups: { 4243: [4244, 4245] },
        }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(false)
      expect(published(box)).toBe(true)
    })
  })

  test("stays held while its supervisor is alive, whatever the owner is doing", async () => {
    await withSandbox((box) => {
      // The same live owner, and this time something that really does execute
      // the run is still there. A live owner is not what holds a root; a live
      // supervisor is.
      seedQuarantined(box, {
        runId: RUN,
        owner: { pid: 900, startedAt: "owner-start" },
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
      })
      holdRoot(box)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ processes: { 900: "owner-start", 4242: "supervisor-start" } }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.quarantineCleared).toBe(false)
      expect(published(box)).toBe(true)
    })
  })

  test("holds an unfinished run its owner is still driving", async () => {
    await withSandbox((box) => {
      // The window an owner check is actually for: the supervisor has exited,
      // the summary has not been published, and the run is not finished. That
      // is a live run, not a completed one, and it is `classify` that says so.
      createRunDirectory(box.storage, RUN)
      seedRun(box.storage, {
        runId: RUN,
        state: "executionCompleted",
        owner: { pid: 900, startedAt: "owner-start" },
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
      })

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({ processes: { 900: "owner-start" } }),
        timestamp: () => TIMESTAMP,
      })

      expect(report.status).toBe("busy")
      expect(report.needsFinalization).toEqual([])
    })
  })

  test("stays held while a run's durable state cannot be read at all", async () => {
    await withSandbox((box) => {
      // The directory is there and the record is not. That is corruption, not
      // absence, and there is nothing to validate identities against.
      createRunDirectory(box.storage, RUN)

      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({}),
        timestamp: () => TIMESTAMP,
      })

      expect(report.uncertain).toEqual([RUN])
      expect(published(box)).toBe(true)
      expect(report.status).toBe("stillQuarantined")
    })
  })
})

describe("while a root is held", () => {
  function admissionFor(box: Sandbox): AdmissionEnvironment {
    let clock = 0
    return {
      storage: box.storage,
      probe: fakeProbe({ processes: { 1000: "owner-start" } }),
      now: () => (clock += 10),
      timestamp: () => TIMESTAMP,
      freeBytes: () => MINIMUM_FREE_BYTES * 4,
      owner: { pid: 1000, startedAt: "owner-start" },
      sleep: () => Promise.resolve(),
    }
  }

  test("no second Test Run is admitted", async () => {
    await withSandbox(async (box) => {
      holdRoot(box)

      // Fails fast with a reason rather than waiting out its whole enrollment
      // deadline behind a run nobody can account for. Waiting would be worse
      // than refusing: the caller learns nothing, slowly.
      const result = await admit(admissionFor(box))
      expect(result).toMatchObject({ status: "failed", reason: "executionSlotQuarantined" })
    })
  })
})

describe("publishing a quarantine", () => {
  test("does not depend on still holding the execution slot", async () => {
    await withSandbox((box) => {
      // A recovery pass released this run's stale slot a moment ago; its owner
      // is only now finding out the lifecycle could not be confirmed. Dropping
      // the quarantine because the slot has gone would release a root nobody
      // has established is safe, which is the one thing it exists to prevent.
      writeQueue(box.storage, { schemaVersion: 1, nextSequence: 1, tickets: [] })

      releaseSlot(box.storage, RUN, { reason: QUARANTINE_REASON, since: TIMESTAMP })

      expect(readQueue(box.storage).quarantine?.runId).toBe(RUN)
    })
  })

  test("still releases the slot when it does hold it", async () => {
    await withSandbox((box) => {
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 1,
        tickets: [],
        activeRunId: RUN,
      })

      releaseSlot(box.storage, RUN, { reason: QUARANTINE_REASON, since: TIMESTAMP })

      const state = readQueue(box.storage)
      // Both facts at once: a root that is quarantined must never also look
      // busy, or admission waits out its deadline instead of failing fast.
      expect(state.activeRunId).toBeUndefined()
      expect(state.quarantine?.runId).toBe(RUN)
    })
  })

  test("never displaces another run's live quarantine", async () => {
    await withSandbox((box) => {
      // Somebody else's held root, with its own reason and its own moment.
      // Replacing it would leave the root just as held and no longer explain
      // why, which is the part anyone reading it needs.
      holdRoot(box, "run-someone-else")

      releaseSlot(box.storage, RUN, { reason: "a different reason", since: TIMESTAMP })

      const state = readQueue(box.storage)
      expect(state.quarantine?.runId).toBe("run-someone-else")
      expect(state.quarantine?.reason).toBe(QUARANTINE_REASON)
    })
  })

  test("leaves an unrelated run's slot alone", async () => {
    await withSandbox((box) => {
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 1,
        tickets: [],
        activeRunId: "run-someone-else",
      })

      releaseSlot(box.storage, RUN, { reason: QUARANTINE_REASON, since: TIMESTAMP })

      const state = readQueue(box.storage)
      expect(state.activeRunId).toBe("run-someone-else")
      expect(state.quarantine?.runId).toBe(RUN)
    })
  })
})

describe("reconciliation at startup", () => {
  test("defers rather than waiting when another instance holds the root", async () => {
    await withSandbox((box) => {
      // Reconciliation runs inside plugin startup, which is synchronous from
      // the host's point of view — so a blocking acquisition could not be cut
      // short by the deadline meant to bound it. The timer cannot fire until
      // the wait it is bounding has already ended.
      const report = withLock(box.storage.rootLock, () =>
        reconcileRoot({
          storage: box.storage,
          probe: fakeProbe({}),
          timestamp: () => TIMESTAMP,
        }),
      )

      // `deferred`, not `busy`. They sound alike and mean opposite things:
      // `busy` is something a pass *found*, and this pass found nothing
      // because it looked at nothing.
      expect(report.status).toBe("deferred")
    })
  })

  test("reports nothing done when it deferred", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, { runId: RUN })

      const report = withLock(box.storage.rootLock, () =>
        reconcileRoot({
          storage: box.storage,
          probe: fakeProbe({}),
          timestamp: () => TIMESTAMP,
        }),
      )

      // It did not look, so it must not claim to have found anything.
      expect(report.needsFinalization).toEqual([])
      expect(report.quarantined).toEqual([])
      expect(report.quarantineCleared).toBe(false)
    })
  })

  test("stops scanning when its budget expires, rather than finishing regardless", async () => {
    await withSandbox((box) => {
      for (const runId of ["run-a", "run-b", "run-c"]) {
        createRunDirectory(box.storage, runId)
      }

      // The pass is synchronous filesystem work, so nothing outside it can
      // interrupt it once started. A deadline that holds is one the scan asks
      // about between runs — this one has already passed.
      const report = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe({}),
        timestamp: () => TIMESTAMP,
        signal: { get aborted() { return true } },
      })

      expect(report.status).toBe("cancelled")
      expect(report.uncertain).toEqual([])
    })
  })

  test("gives each pass its own report to fill", async () => {
    await withSandbox((box) => {
      seedQuarantined(box, {
        runId: RUN,
        supervisor: { pid: 4242, startedAt: "supervisor-start" },
      })

      const world = { processes: { 4242: "supervisor-start" } }
      const first = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe(world),
        timestamp: () => TIMESTAMP,
      })
      const second = reconcileRoot({
        storage: box.storage,
        probe: fakeProbe(world),
        timestamp: () => TIMESTAMP,
      })

      // Two passes, two reports. Sharing one template's arrays would make the
      // second pass report everything the first one found as well.
      expect(first.quarantined).toEqual([RUN])
      expect(second.quarantined).toEqual([])
    })
  })
})
