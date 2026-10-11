/**
 * Startup as production wires it (issue #52).
 *
 * `runStartup` is a sequence with no host in it and has always been testable.
 * The *wiring* — the object of closures the entrypoint hands it — was not, and
 * the wiring is where the interesting failure actually happened: the deadline
 * was built from the monotonic clock and compared against the wall clock, so
 * reconciliation was cancelled before it looked at anything, on every start.
 *
 * Neither half was wrong on its own, and a test of either half passed. What
 * these tests exercise is the pair, against the real ports, with a real
 * storage tree and a real quarantined run to reconcile.
 *
 * They are written to fail loudly for the two things that would bring the bug
 * back: a deadline from a different clock, and a pass that gives up before it
 * has looked at anything.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { monotonicNow } from "../../src/domain/clock.ts"
import { startupPortsFor } from "../../src/adapter/startup-ports.ts"
import { HOUSEKEEPING_BUDGET_MS, RECONCILIATION_BUDGET_MS, runStartup } from "../../src/adapter/startup.ts"
import { noteRootSeen, readRegistry, writeRegistry } from "../../src/runner/housekeeping.ts"
import { createRunDirectory, prepareStorage, RUN_ARTIFACTS, runDirectory, storageFor } from "../../src/runner/paths.ts"
import { QUARANTINE_REASON, readQueue, writeQueue } from "../../src/runner/queue.ts"
import { reclamationsSettled } from "../../src/runner/reclamation.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"

const RUN = "run-after-a-crash"
const TIMESTAMP = "2026-09-14T09:00:00.000Z"

/** A containment root that has opted in, with a quarantine nothing still owns. */
function crashedRoot(box: Sandbox, containmentRoot: string): void {
  mkdirSync(join(containmentRoot, ".opencode"), { recursive: true })
  writeFileSync(join(containmentRoot, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')

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

/** The real ports, with only the host-shaped edges stubbed out. */
function portsFor(box: Sandbox, configurationRoot: string) {
  return startupPortsFor({
    configurationRoot,
    homeDir: box.homeDir,
    storage: box.storage,
    configuration: { status: "absent" },
    // Structural verification is a separate concern; an empty list keeps this
    // about the clock without asserting where a checkout puts its files.
    requiredFiles: () => [],
    regularFileExists: () => true,
    readHostVersion: async () => "2.0.25",
    onRuntime: () => {},
  })
}

describe("the ports the plugin entrypoint actually builds", () => {
  test("look for enablement at the configuration root", async () => {
    await withSandbox(async (box) => {
      const containmentRoot = join(box.homeDir, "project")
      const configurationRoot = join(containmentRoot, "module")
      mkdirSync(join(configurationRoot, ".opencode"), { recursive: true })
      writeFileSync(
        join(configurationRoot, ".opencode", "xcode-test.json"),
        '{ "schemaVersion": 1 }\n',
      )

      expect(portsFor(box, configurationRoot).markerExists()).toBe(true)
    })
  })

  test("reconcile the root, rather than giving up before looking at it", async () => {
    await withSandbox(async (box) => {
      const containmentRoot = join(box.homeDir, "project")
      crashedRoot(box, containmentRoot)

      const outcome = await runStartup(portsFor(box, containmentRoot))

      expect(outcome.status).toBe("ready")
      if (outcome.status !== "ready") return

      // The assertion that matters: the quarantine is gone, which can only
      // have happened if the pass ran. A deadline from the wrong clock makes
      // this fail, and nothing else about startup changes — which is exactly
      // why the bug was invisible.
      expect(readQueue(box.storage).quarantine).toBeUndefined()
      expect(outcome.incomplete).not.toContain("reconciliation")
    })
  })

  test("are given a deadline on the clock the pass reads", async () => {
    await withSandbox(async (box) => {
      const containmentRoot = join(box.homeDir, "project")
      crashedRoot(box, containmentRoot)

      let handed: number | undefined
      const ports = portsFor(box, containmentRoot)
      const real = ports.reconcileRoot.bind(ports)
      ports.reconcileRoot = async (deadlineMs: number) => {
        handed = deadlineMs
        await real(deadlineMs)
      }

      await runStartup(ports)

      // A wall-clock deadline is larger than any budget by twelve orders of
      // magnitude, so this catches the mismatch on startup's side of the pair.
      expect(handed).toBeDefined()
      expect((handed as number) - monotonicNow()).toBeLessThanOrEqual(RECONCILIATION_BUDGET_MS)
      expect(handed as number).toBeGreaterThan(0)
    })
  })

  test("honour the deadline they are handed rather than one of their own", async () => {
    await withSandbox(async (box) => {
      const containmentRoot = join(box.homeDir, "project")
      crashedRoot(box, containmentRoot)

      // The port's side of the pair, and the direction the other tests cannot
      // see. A port that quietly derived its own deadline — from the wall
      // clock, say — would be handed an instant that has already passed and
      // reconcile anyway, because a wall-clock deadline is effectively
      // infinite to a monotonic reader. The budget would stop bounding
      // anything, silently, while every other assertion here still held.
      await portsFor(box, containmentRoot).reconcileRoot(monotonicNow() - 1)

      expect(readQueue(box.storage).quarantine?.runId).toBe(RUN)
    })
  })

  test("skip reconciliation entirely for a root that never opted in", async () => {
    await withSandbox(async (box) => {
      // The other half of the contract: an unmarked project pays nothing. A
      // reconciliation that ran here would be work done on a root that has not
      // asked for any.
      const containmentRoot = join(box.homeDir, "project")
      crashedRoot(box, containmentRoot)
      writeFileSync(join(containmentRoot, ".opencode", "xcode-test.json"), "")
      mkdirSync(join(box.homeDir, "unmarked"), { recursive: true })

      const outcome = await runStartup(portsFor(box, join(box.homeDir, "unmarked")))

      expect(outcome.status).toBe("disabled")
      expect(readQueue(box.storage).quarantine?.runId).toBe(RUN)
    })
  })
})

describe("isolated DerivedData a crash left behind (issue #161)", () => {
  /** A completed isolated run whose cache was never reclaimed. */
  function leftover(box: Sandbox, containmentRoot: string): string {
    mkdirSync(join(containmentRoot, ".opencode"), { recursive: true })
    writeFileSync(join(containmentRoot, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')
    createRunDirectory(box.storage, RUN)
    const derived = join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.derivedData)
    mkdirSync(join(derived, "Build"), { recursive: true })
    writeFileSync(join(derived, "Build", "App.o"), "o")
    seedRun(box.storage, { runId: RUN, state: "completed", completedAt: TIMESTAMP, derivedDataMode: "isolated" })
    return derived
  }

  test("is reclaimed by the startup reconciliation", async () => {
    await withSandbox(async (box) => {
      const containmentRoot = join(box.homeDir, "project")
      const derived = leftover(box, containmentRoot)

      await portsFor(box, containmentRoot).reconcileRoot(monotonicNow() + RECONCILIATION_BUDGET_MS)
      await reclamationsSettled()

      expect(existsSync(derived)).toBe(false)
      expect(readRunRecord(box.storage, RUN)?.derivedDataCleaned).toBe(true)
    })
  })

  test("is reclaimed by housekeeping, in a root nobody opens again", async () => {
    await withSandbox(async (box) => {
      const containmentRoot = join(box.homeDir, "project")
      const derived = leftover(box, containmentRoot)
      // Registered as seen, as an earlier session would have left it, and then
      // never reconciled by a startup of its own.
      noteRootSeen(box.storage, Date.now())

      // Off the main thread (#153), so this process's own registry of
      // reclamations never sees it: the pass is over when its worker is.
      await portsFor(box, containmentRoot).runHousekeeping(monotonicNow() + HOUSEKEEPING_BUDGET_MS)

      expect(existsSync(derived)).toBe(false)
      expect(readRunRecord(box.storage, RUN)?.derivedDataCleaned).toBe(true)
    })
  })
})

describe("housekeeping as production runs it (issue #153)", () => {
  /** The worst gap between ticks of a 10 ms timer while `work` runs. */
  async function worstTimerLag(work: () => Promise<unknown>): Promise<number> {
    let worst = 0
    let last = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last - 10)
      last = now
    }, 10)
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await work()
      await new Promise((resolve) => setTimeout(resolve, 30))
    } finally {
      clearInterval(timer)
    }
    return worst
  }

  test("runs off the host's event loop, however long its filesystem work takes", async () => {
    await withSandbox(async (box) => {
      // A root nobody has opened in a long while, holding enough files that
      // collecting it synchronously stalls a thread for around a second.
      const stale = storageFor(box.homeDir, "/workspace/abandoned")
      prepareStorage(stale)
      for (let directory = 0; directory < 150; directory += 1) {
        const leaf = join(stale.runsDir, `run-${String(directory).padStart(4, "0")}`, "Objects")
        mkdirSync(leaf, { recursive: true })
        for (let file = 0; file < 200; file += 1) writeFileSync(join(leaf, `${file}.o`), "o")
      }
      const longAgo = Date.now() - 90 * 24 * 60 * 60 * 1000
      writeRegistry(box.storage, { schemaVersion: 1, roots: { [stale.rootKey]: { lastSeenAtMs: longAgo } } })
      utimesSync(stale.rootDir, longAgo / 1000, longAgo / 1000)

      const ports = portsFor(box, join(box.homeDir, "project"))
      const lag = await worstTimerLag(() => ports.runHousekeeping(monotonicNow() + 60_000))

      expect(existsSync(stale.rootDir)).toBe(false)
      expect(readRegistry(box.storage).roots[stale.rootKey]).toBeUndefined()
      expect(lag).toBeLessThan(250)
    })
  }, 60_000)

  test("stops at the deadline it is handed, leaving the rest for the next pass", async () => {
    await withSandbox(async (box) => {
      noteRootSeen(box.storage, Date.now())

      await portsFor(box, join(box.homeDir, "project")).runHousekeeping(monotonicNow() - 1)

      expect(readRegistry(box.storage).pendingRoots).toEqual([box.storage.rootKey])
    })
  })
})
