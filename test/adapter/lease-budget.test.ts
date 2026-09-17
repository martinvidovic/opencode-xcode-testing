/**
 * A lease has to outlive the read it covers (issue #124).
 *
 * The lease and the lazy-detail deadline were both sixty seconds, chosen
 * independently and equal by coincidence. A bundle read that used its whole
 * budget therefore finished at the exact moment its lease stopped being
 * believed — and everything before and after it, the index read and the page
 * assembled from it, was outside the lease altogether.
 *
 * What that costs is not an error. An expired lease does not fail: it stops
 * being seen by the housekeeping pass that then deletes the run being read.
 * The reader meets an `ENOENT` in the middle of evidence it was told existed,
 * and nothing anywhere connects the two events.
 *
 * So the relationship is the thing under test, not either number. Time is
 * advanced rather than waited out, and housekeeping is asked at the moments
 * that matter: while a near-deadline read is still going, and after the
 * inspection has let go.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, INDEX_ARTIFACT, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { LAZY_DEADLINE_MS, LEASE_LIFETIME_MS, LEASE_MARGIN_MS } from "../../src/domain/limits.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import type { XcresultTool } from "../../src/interpreter/ports.ts"
import { noteRootSeen, runHousekeeping } from "../../src/runner/housekeeping.ts"
import { createRunDirectory, runDirectory, RUN_ARTIFACTS, storageForRootKey } from "../../src/runner/paths.ts"
import { RETENTION } from "../../src/runner/retention.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"
import { recordedDigest } from "./scenarios.ts"

const RUN = "run-lease-budget"

const OCCURRENCE = {
  id: "occ-1",
  identity: {
    bundle: "AppTests",
    suite: "LoginTests",
    test: "testSignsIn()",
    canonical: "AppTests/LoginTests/testSignsIn()",
  },
  identityComplete: true,
  status: "failed" as const,
  position: "0",
  attempts: [],
  failures: [],
}

function indexFor(): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId: RUN,
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [OCCURRENCE] as NormalizedIndex["occurrences"],
    testFailures: [
      { id: "d1", kind: "testFailure" as const, message: "expected true", testId: "occ-1", inspectionAvailable: true },
    ],
    buildErrors: [],
    attestations: [],
    scopeVerdict: "unverifiable",
    scopeDigest: "digest",
    requestedSelectionCount: 0,
    observedOutsideScope: 0,
    build: { completeness: "complete" },
    tests: { completeness: "complete" },
    diagnostics: { completeness: "complete" },
    fullMessages: {},
    toolchain: identityFor(loadFixture("passed")),
    log: { availability: "available", retainedBytes: 0, retainedBytesExact: true },
    bundleDigestVerified: "unknown",
  }
}

/**
 * A completed run old enough that age alone evicts it, with a bundle present.
 *
 * Old on purpose: the lease has to be the only thing keeping it, or the test
 * would pass against no lease at all.
 */
function ancientRun(box: Sandbox, completedAtMs: number): void {
  createRunDirectory(box.storage, RUN)

  const bundle = join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.resultBundle)
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, "Data"), "bytes")

  seedRun(box.storage, {
    runId: RUN,
    state: "completed",
    completedAt: new Date(completedAtMs - RETENTION.maxAgeMs - 60_000).toISOString(),
    ...recordedDigest(bundle),
  })
  writeFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), JSON.stringify(indexFor()), {
    mode: 0o600,
  })
}

/**
 * How long the index read is taken to have cost before the bundle read began.
 *
 * The lease is published before it; the lazy deadline starts after it. That
 * gap is exactly what a lifetime equal to the deadline leaves uncovered, so a
 * test that did not model it would pass against the defect.
 */
const INDEX_READ_MS = 5_000

/** A housekeeping pass as it would run at `nowMs`, in another process. */
function housekeepAt(box: Sandbox, nowMs: number): void {
  noteRootSeen(box.storage, nowMs)
  runHousekeeping({
    storage: box.storage,
    now: () => nowMs,
    storageForRootKey: (rootKey) => storageForRootKey(box.homeDir, rootKey),
  })
}

function environmentFor(
  box: Sandbox,
  clock: () => number,
  tool: XcresultTool,
): ServiceEnvironment {
  return {
    storage: box.storage,
    trustedRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: "/opt/bun" },
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    // Monotonic, which is what the lazy deadline is measured on.
    now: clock,
    timestamp: () => new Date().toISOString(),
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 7),
    xcresultToolFor: () => tool,
  }
}

describe("the budget relationship", () => {
  test("gives a lease more life than the read it protects", () => {
    // Stated once, as itself. Every other test here depends on it, and an
    // equality would make all of them pass while protecting nothing.
    expect(LEASE_LIFETIME_MS).toBeGreaterThan(LAZY_DEADLINE_MS)
    expect(LEASE_LIFETIME_MS - LAZY_DEADLINE_MS).toBe(LEASE_MARGIN_MS)
  })

  test("still expires, so a crashed inspector cannot pin evidence", () => {
    // The other side of the same number. A margin large enough to be safe and
    // small enough that nobody has to wait for it.
    expect(LEASE_LIFETIME_MS).toBeLessThanOrEqual(120_000)
  })
})

describe("a lazy read that uses nearly its whole deadline", () => {
  test("keeps its run through a housekeeping pass running beside it", async () => {
    // Time is advanced, not waited out: the index read is taken to have cost
    // five seconds, and the bundle read is then one millisecond inside a
    // deadline that started after it. That is the latest instant an
    // inspection can still legitimately be reading — and with a lease no
    // longer than the deadline it is an instant the lease no longer covers,
    // so the pass deletes the run under a reader that was told it existed.
    await withSandbox(async (box) => {
      ancientRun(box, Date.now())

      let elapsed = 0
      let survivedDuringRead: boolean | undefined
      // Read from the clock, not derived from a constant: computing when the
      // lease was published by subtracting the lifetime this test believes in
      // would make the test agree with itself rather than with the publisher.
      const beforeInspection = Date.now()

      const slow: XcresultTool = {
        identity: identityFor(loadFixture("passed")),
        async run() {
          elapsed = INDEX_READ_MS + LAZY_DEADLINE_MS - 1
          housekeepAt(box, beforeInspection + elapsed)
          survivedDuringRead = existsSync(runDirectory(box.storage, RUN))
          return { ok: true as const, payload: { testRuns: [] } }
        },
      } as unknown as XcresultTool

      // The clock the deadline is measured on. `INDEX_READ_MS` has already
      // gone by when `lazyDetailFor` reads it, which is what puts the end of
      // the read past the end of a lease that only matched the deadline.
      const service = createTestToolService(
        environmentFor(box, () => (elapsed === 0 ? INDEX_READ_MS : elapsed), slow),
      )
      await service.inspect({ runId: RUN, facet: "failures", diagnosticId: "d1" })

      expect(survivedDuringRead).toBe(true)
    })
  })
})

describe("once the inspection has let go", () => {
  test("the same run is evictable again", async () => {
    // Without this the two above would pass against a lease that never
    // expires, which is the failure this issue's other half is about.
    await withSandbox(async (box) => {
      const started = Date.now()
      ancientRun(box, started)

      const service = createTestToolService(
        environmentFor(box, () => 0, {
          identity: identityFor(loadFixture("passed")),
          async run() {
            return { ok: true as const, payload: { testRuns: [] } }
          },
        } as unknown as XcresultTool),
      )
      await service.inspect({ runId: RUN, facet: "failures", diagnosticId: "d1" })

      housekeepAt(box, started + 1)

      expect(existsSync(runDirectory(box.storage, RUN))).toBe(false)
    })
  })
})
