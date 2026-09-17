/**
 * The complete user-wide footprint, and whether the byte targets bound it
 * (issue #96).
 *
 * They did not. User-wide accounting summed each root's `runs` directory and
 * nothing else, while shared DerivedData sat beside it in the same tree and
 * was never counted, never reclaimed, and larger than everything it was being
 * compared against: 5.0 GB accounted for against 34.3 GB occupied, on the
 * machine where this was measured. A cap computed over an eighth of what it is
 * capping is not a cap — and the number it produced sat comfortably under
 * target the whole time the disk was filling.
 *
 * Two things follow, and the order between them is the design. Evidence is
 * what a caller asked for and cannot regenerate; a build cache is a warm start
 * `xcodebuild` will rebuild on demand. So caches go first, and evidence is
 * evicted only for what reclaiming every cache could not cover — the reverse
 * order spends the unregenerable to buy back the regenerable.
 *
 * Byte accounting uses **sparse files** throughout, as the retention suite
 * does: `ftruncate` gives a file a multi-gigabyte apparent size while
 * allocating nothing, so the real accounting path runs against a real
 * filesystem without asking a laptop for a hundred gigabytes.
 */

import { describe, expect, test } from "bun:test"
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, utimesSync } from "node:fs"
import { join } from "node:path"

import { createRunDirectory, RUN_ARTIFACTS, sharedDerivedDataFor } from "../../src/runner/paths.ts"
import {
  RETENTION,
  runRetention,
  sharedCaches,
  directorySize,
} from "../../src/runner/retention.ts"
import { totalToolBytes } from "../../src/runner/housekeeping.ts"
import { seedRun, withSandbox, type Sandbox } from "./harness.ts"
import { writeQueue } from "../../src/runner/queue.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const GIB = 1024 ** 3
const NOW = Date.parse("2026-09-13T12:00:00.000Z")

/** A file with a large apparent size and no allocated blocks. */
function sparseFile(path: string, bytes: number): void {
  const fd = openSync(path, "w", 0o600)
  try {
    ftruncateSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

function completedRun(box: Sandbox, runId: string, bytes: number, daysAgo = 0): void {
  createRunDirectory(box.storage, runId)
  seedRun(box.storage, {
    runId,
    state: "completed",
    completedAt: new Date(NOW - daysAgo * DAY_MS).toISOString(),
  })
  sparseFile(join(box.storage.runsDir, runId, "result.xcresult"), bytes)
}

/** A shared build cache for one container, as a real build leaves it. */
function cache(box: Sandbox, container: string, bytes: number, daysAgo = 0): string {
  const path = sharedDerivedDataFor(box.storage, container)
  mkdirSync(join(path, "Build", "Products"), { recursive: true })
  sparseFile(join(path, "Build", "Products", "App.app"), bytes)
  const when = new Date(NOW - daysAgo * DAY_MS)
  utimesSync(path, when, when)
  return path
}

function retain(
  box: Sandbox,
  options: { userWideBytes?: number; activeRunId?: string; nothingIsRunning?: boolean } = {},
) {
  return runRetention({
    storage: box.storage,
    now: () => NOW,
    ...(options.userWideBytes === undefined ? {} : { userWideBytes: options.userWideBytes }),
    ...(options.activeRunId === undefined ? {} : { activeRunId: options.activeRunId }),
    ...(options.nothingIsRunning === undefined ? {} : { nothingIsRunning: options.nothingIsRunning }),
  })
}

describe("what the tool is measured as occupying", () => {
  test("is every tool-owned byte, not the run directories alone", () => {
    withSandbox((box) => {
      completedRun(box, "a".repeat(32), 1 * GIB)
      cache(box, "/work/Example.xcodeproj", 8 * GIB)

      // The defect, stated as arithmetic. Nine gigabytes are there and the
      // number that decides eviction used to say one.
      expect(totalToolBytes(box.storage)).toBeGreaterThanOrEqual(9 * GIB)
      expect(directorySize(box.storage.runsDir)).toBeLessThan(2 * GIB)
    })
  })

  test("counts only directories named by a well-formed key", () => {
    withSandbox((box) => {
      // These paths are deleted and these bytes decide evictions; anything
      // that merely happens to sit here must not be able to inflate either.
      const stray = join(box.storage.rootDir, RUN_ARTIFACTS.derivedData, "not-a-key")
      mkdirSync(stray, { recursive: true })
      sparseFile(join(stray, "big"), 4 * GIB)
      cache(box, "/work/Example.xcodeproj", 1 * GIB)

      expect(sharedCaches(box.storage).map((entry) => entry.bytes)).toEqual([1 * GIB])
    })
  })
})

describe("byte targets when most of the bytes are a build cache", () => {
  test("converge, where before they could not", () => {
    withSandbox((box) => {
      completedRun(box, "a".repeat(32), 1 * GIB)
      cache(box, "/work/One.xcodeproj", 20 * GIB)
      cache(box, "/work/Two.xcodeproj", 20 * GIB)

      const report = retain(box)

      expect(report.cachesReclaimed.length).toBeGreaterThan(0)
      expect(report.retainedBytes).toBeLessThanOrEqual(RETENTION.perRootByteTarget)
      // And the run's evidence is still there: a caller asked for that, and
      // nothing here can regenerate it.
      expect(existsSync(join(box.storage.runsDir, "a".repeat(32)))).toBe(true)
    })
  })

  test("reclaim the cache that buys the least first", () => {
    withSandbox((box) => {
      cache(box, "/work/Old.xcodeproj", 4 * GIB, 30)
      cache(box, "/work/Recent.xcodeproj", 4 * GIB, 0)

      const report = retain(box)

      expect(report.cachesReclaimed).toHaveLength(1)
      expect(existsSync(sharedDerivedDataFor(box.storage, "/work/Old.xcodeproj"))).toBe(false)
      expect(existsSync(sharedDerivedDataFor(box.storage, "/work/Recent.xcodeproj"))).toBe(true)
    })
  })

  test("answer to the user-wide target as well as the per-root one", () => {
    withSandbox((box) => {
      // One root well inside its own target, on a machine that is not.
      cache(box, "/work/Example.xcodeproj", 1 * GIB)
      expect(retain(box).cachesReclaimed).toEqual([])

      expect(
        retain(box, { userWideBytes: RETENTION.userWideByteTarget + GIB }).cachesReclaimed,
      ).toHaveLength(1)
    })
  })

  test("reclaim a cache nobody has built against in a fortnight, whatever the totals say", () => {
    // Age applies on its own, as it does to runs. A cache for a container
    // nobody has touched is buying a warm start nobody is waiting for.
    withSandbox((box) => {
      cache(box, "/work/Forgotten.xcodeproj", 1024, 30)
      expect(retain(box).cachesReclaimed).toHaveLength(1)
    })
  })

  test("keep a small, recent cache, which is the case this exists to serve", () => {
    withSandbox((box) => {
      cache(box, "/work/Example.xcodeproj", 1024, 1)
      const report = retain(box)

      expect(report.cachesReclaimed).toEqual([])
      expect(report.cacheBytes).toBeGreaterThan(0)
    })
  })
})

describe("which of the two goes first", () => {
  test("never evicts evidence to offset bytes a cache was about to give back", () => {
    // The ordering defect. The user-wide total now counts caches, so planning
    // eviction against it before reclaiming them had runs evicted for
    // `userWideBytes` to make room for bytes the very next step removed —
    // trading something nothing can regenerate for a warm start `xcodebuild`
    // rebuilds on demand.
    withSandbox((box) => {
      completedRun(box, "a".repeat(32), 1024)
      completedRun(box, "b".repeat(32), 1024)
      cache(box, "/work/Example.xcodeproj", 8 * GIB)

      // Over the user-wide target by exactly what the cache accounts for.
      const report = retain(box, { userWideBytes: RETENTION.userWideByteTarget + 8 * GIB })

      expect(report.cachesReclaimed).toHaveLength(1)
      expect(report.evicted).toEqual([])
      expect(existsSync(join(box.storage.runsDir, "a".repeat(32)))).toBe(true)
      expect(existsSync(join(box.storage.runsDir, "b".repeat(32)))).toBe(true)
    })
  })

  test("still evicts evidence when reclaiming every cache is not enough", () => {
    // Caches first is an ordering, not an exemption.
    withSandbox((box) => {
      completedRun(box, "a".repeat(32), 30 * GIB, 1)
      completedRun(box, "b".repeat(32), 1024, 0)
      cache(box, "/work/Example.xcodeproj", 1024)

      const report = retain(box, { userWideBytes: RETENTION.userWideByteTarget + 30 * GIB })

      expect(report.evicted).toContain("a".repeat(32))
      expect(["perRootBytes", "userWideBytes"]).toContain(report.reasons["a".repeat(32)] ?? "")
    })
  })
})

describe("a cache a build may be writing into", () => {
  test("is left alone while a run holds the execution slot", () => {
    // A cache is safe to delete because it is regenerable, not because it is
    // idle — and the one moment that is untrue is while a build is using it.
    withSandbox((box) => {
      cache(box, "/work/Example.xcodeproj", 40 * GIB, 30)
      const report = retain(box, { activeRunId: "b".repeat(32) })

      expect(report.cachesReclaimed).toEqual([])
      expect(report.cacheBytes).toBeGreaterThanOrEqual(40 * GIB)
      expect(existsSync(sharedDerivedDataFor(box.storage, "/work/Example.xcodeproj"))).toBe(true)
    })
  })
})

describe("the report", () => {
  test("tells cache reclamation from run eviction", () => {
    // They are not the same event, and a reader deciding whether anything was
    // lost needs them apart: an evicted run is evidence someone may have
    // wanted, a reclaimed cache costs the next build its warm start.
    withSandbox((box) => {
      completedRun(box, "a".repeat(32), 1024, 30)
      cache(box, "/work/Example.xcodeproj", 1024, 30)

      const report = retain(box)

      expect(report.evicted).toEqual(["a".repeat(32)])
      expect(report.cachesReclaimed).toHaveLength(1)
      expect(report.cacheBytesReclaimed).toBeGreaterThan(0)
      expect(report.reasons["a".repeat(32)]).toBe("age")
    })
  })
})

describe("a tree whose largest cache is pinned by a crashed run", () => {
  /**
   * The whole of #110, at the scale it was measured (issue #101, finding 1).
   *
   * One root holds far more than the user-wide target in a build cache, and
   * its execution slot is held by a run that never completed. Every pass reads
   * that slot, concludes a build may be writing there, and declines — so the
   * total never converges, however many passes run.
   */
  function pinnedTree(box: Sandbox): { cache: string; run: string } {
    completedRun(box, "a".repeat(32), 1024, 1)

    const stuck = "f".repeat(32)
    createRunDirectory(box.storage, stuck)
    seedRun(box.storage, { runId: stuck, state: "launchAuthorized" })
    writeQueue(box.storage, {
      schemaVersion: 1,
      nextSequence: 2,
      tickets: [],
      activeRunId: stuck,
    })

    return { cache: cache(box, "/work/Example.xcodeproj", 30 * GIB), run: stuck }
  }

  test("does not converge while the slot is taken at face value", () => {
    withSandbox((box) => {
      const { cache: pinned } = pinnedTree(box)
      const report = retain(box, { userWideBytes: 30 * GIB })

      expect(report.cachesReclaimed).toEqual([])
      expect(report.retainedBytes).toBeGreaterThan(RETENTION.userWideByteTarget)
      expect(existsSync(pinned)).toBe(true)
    })
  })

  test("converges once recovery has said nothing is running", () => {
    withSandbox((box) => {
      const { cache: pinned } = pinnedTree(box)
      const report = retain(box, { userWideBytes: 30 * GIB, nothingIsRunning: true })

      expect(report.cachesReclaimed).toHaveLength(1)
      expect(existsSync(pinned)).toBe(false)
      expect(report.retainedBytes).toBeLessThanOrEqual(RETENTION.userWideByteTarget)
    })
  })

  test("converges by deleting cache, not by evicting evidence that has not expired", () => {
    // The two are separate events and must stay separate: a cache is a warm
    // start `xcodebuild` rebuilds on demand, and a Result Bundle is evidence
    // nothing can regenerate. Convergence reached by evicting the second is
    // not the same outcome wearing a different name.
    withSandbox((box) => {
      const { run } = pinnedTree(box)
      const report = retain(box, { userWideBytes: 30 * GIB, nothingIsRunning: true })

      expect(report.evicted).toEqual([])
      expect(report.cacheBytesReclaimed).toBeGreaterThan(0)
      expect(existsSync(join(box.storage.runsDir, "a".repeat(32)))).toBe(true)
      expect(existsSync(join(box.storage.runsDir, run))).toBe(true)
    })
  })

  test("still evicts evidence that has expired, which is a different rule", () => {
    // Age is hard and pre-existing: a run past its retention age goes whether
    // or not anything else converged. Saying so here keeps the previous test
    // from reading as "eviction never happens".
    withSandbox((box) => {
      completedRun(box, "b".repeat(32), 1024, 30)
      const report = retain(box, { nothingIsRunning: true })

      expect(report.evicted).toEqual(["b".repeat(32)])
      expect(report.reasons["b".repeat(32)]).toBe("age")
    })
  })
})
