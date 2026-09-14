/**
 * The clock a startup deadline is measured against (issue #42).
 *
 * Reconciliation is the pass that returns a trusted root to service after a
 * crash. Nothing downstream reads its report, a healthy machine expects it to
 * find nothing, and a pass that examined nothing at all is indistinguishable
 * from a pass that found nothing wrong. So a bound that is wrong by the age of
 * the Unix epoch does not look like a bug — it looks like a working plugin
 * that has quietly stopped recovering anything.
 *
 * That is the failure these tests exist for, and it is why they assert on the
 * deadline's *clock* and not merely on its size.
 */

import { describe, expect, test } from "bun:test"

import { monotonicNow } from "../../src/domain/clock.ts"
import { reconcileRootBounded } from "../../src/adapter/reconciliation.ts"
import {
  RECONCILIATION_BUDGET_MS,
  runStartup,
  type StartupPorts,
} from "../../src/adapter/startup.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"
import { QUARANTINE_REASON, readQueue, writeQueue } from "../../src/runner/queue.ts"
import { fakeProbe, seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"

const RUN = "run-after-a-crash"
const TIMESTAMP = "2026-09-14T09:00:00.000Z"

/** A root left quarantined by a run whose processes have since gone. */
function crashedRoot(box: Sandbox): void {
  createRunDirectory(box.storage, RUN)
  seedRun(box.storage, {
    runId: RUN,
    state: "completed",
    completedAt: TIMESTAMP,
    quarantined: true,
    quarantineReason: QUARANTINE_REASON,
    supervisor: { pid: 4242, startedAt: "supervisor-start" },
  })
  writeQueue(box.storage, {
    schemaVersion: 1,
    nextSequence: 1,
    tickets: [],
    quarantine: { runId: RUN, reason: QUARANTINE_REASON, since: TIMESTAMP },
  })
}

describe("the reconciliation pass as production wires it", () => {
  test("examines the root, given the deadline production gives it", async () => {
    await withSandbox((box) => {
      crashedRoot(box)

      // Built exactly as `runStartup` builds it: an instant on the monotonic
      // clock. The pass must measure against that same clock — comparing it
      // against the wall clock makes the deadline roughly fifty-six years
      // past, and every startup a no-op.
      const report = reconcileRootBounded({
        storage: box.storage,
        probe: fakeProbe({}),
        deadlineMs: monotonicNow() + RECONCILIATION_BUDGET_MS,
        timestamp: () => TIMESTAMP,
      })

      expect(report.status).not.toBe("cancelled")
      expect(report.quarantineCleared).toBe(true)
      expect(readQueue(box.storage).quarantine).toBeUndefined()
    })
  })

  test("stops when its deadline really has passed, without undoing anything", async () => {
    await withSandbox((box) => {
      crashedRoot(box)

      const report = reconcileRootBounded({
        storage: box.storage,
        probe: fakeProbe({}),
        deadlineMs: monotonicNow() - 1,
        timestamp: () => TIMESTAMP,
      })

      // Cancelled before it looked at anything, so the root is left held —
      // which is the safe direction for a pass that established nothing.
      expect(report.status).toBe("cancelled")
      expect(readQueue(box.storage).quarantine?.runId).toBe(RUN)
    })
  })
})

describe("the deadline startup hands to reconciliation", () => {
  test("is an instant on startup's own clock, not on the wall clock", async () => {
    // The two halves of the bug meet here. `runStartup` owns the clock; the
    // pass owns the comparison; neither can be wrong on its own. What can be
    // wrong is the pair, so this asserts the deadline arrives in the domain
    // the caller's `now` reports — a wall-clock deadline would be larger than
    // the budget by twelve orders of magnitude.
    let clock = 1_000
    let handed: number | undefined

    const ports: StartupPorts = {
      markerExists: () => true,
      requiredFiles: () => [],
      regularFileExists: () => true,
      probeRuntime: async () => ({ status: "resolved" }),
      readHostVersion: async () => "1.18.30",
      reconcileRoot: async (deadlineMs: number) => {
        handed = deadlineMs
      },
      runHousekeeping: async () => {},
      now: () => (clock += 1),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }

    await runStartup(ports)

    expect(handed).toBeDefined()
    expect(handed as number).toBeGreaterThan(clock)
    expect((handed as number) - clock).toBeLessThanOrEqual(RECONCILIATION_BUDGET_MS)
  })
})
