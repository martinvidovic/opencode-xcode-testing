/**
 * The window an inspection's read lease has to cover (issue #116).
 *
 * Publishing a lease and releasing it before the reading starts would be a
 * lease over nothing. The window that matters runs from before the first byte
 * is read to after the last — and the last is the awkward one, because a
 * bundle-backed detail read reopens the Result Bundle and runs `xcresulttool`
 * against it, which is by far the longest read here and the one whose
 * disappearance half-way through is hardest to describe to a caller.
 *
 * So the lease is observed from inside that read, which is the only place that
 * can tell a lease held throughout from one held at the start.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, INDEX_ARTIFACT, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { anyLeaseHeld, reconcileLeases } from "../../src/runner/leases.ts"
import { createRunDirectory, runDirectory, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import type { XcresultTool } from "../../src/interpreter/ports.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"
import { recordedDigest } from "./scenarios.ts"

/** One failed occurrence, which is what a bundle-backed detail read needs. */
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

const RUN = "run-leased-inspection"
const NOW = Date.parse("2026-09-13T12:00:00.000Z")

function indexFor(): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId: RUN,
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [OCCURRENCE] as NormalizedIndex["occurrences"],
    testFailures: [
      {
        id: "d1",
        kind: "testFailure" as const,
        message: "expected true",
        testId: "occ-1",
        inspectionAvailable: true,
      },
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

function environmentFor(box: Sandbox, overrides: Partial<ServiceEnvironment> = {}): ServiceEnvironment {
  return {
    storage: box.storage,
    containmentRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: "/opt/bun" },
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    now: () => 0,
    timestamp: () => new Date(NOW).toISOString(),
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 7),
    ...overrides,
  }
}

/** A retained run whose bundle is present and whose digest will verify. */
function retained(box: Sandbox): void {
  createRunDirectory(box.storage, RUN)

  const bundle = join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.resultBundle)
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, "Data"), "bytes")

  seedRun(box.storage, {
    runId: RUN,
    state: "completed",
    completedAt: new Date(NOW).toISOString(),
    ...recordedDigest(bundle),
  })
  writeFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), JSON.stringify(indexFor()), {
    mode: 0o600,
  })
}

describe("an inspection in progress", () => {
  test("holds a lease naming the run it is reading", async () => {
    // Observed from inside the bundle read, because that is the read the
    // lease exists for. Asserting it before or after the call would prove
    // only that a file was created and removed.
    await withSandbox(async (box) => {
      retained(box)
      let leasedDuringRead: ReadonlySet<string> | undefined

      const watching: XcresultTool = {
        identity: identityFor(loadFixture("passed")),
        async run() {
          leasedDuringRead = reconcileLeases(box.storage, NOW).runs
          return { ok: true as const, payload: { testRuns: [] } }
        },
      } as unknown as XcresultTool

      const service = createTestToolService(
        environmentFor(box, { xcresultToolFor: () => watching }),
      )
      await service.inspect({ runId: RUN, facet: "failures", diagnosticId: "d1" })

      expect(leasedDuringRead).toEqual(new Set([RUN]))
    })
  })

  test("lets it go when the inspection is over", async () => {
    await withSandbox(async (box) => {
      retained(box)
      const service = createTestToolService(environmentFor(box))

      await service.inspect({ runId: RUN, facet: "failures" })

      expect(anyLeaseHeld(reconcileLeases(box.storage, NOW))).toBe(false)
    })
  })

  test("lets it go when the inspection fails part-way through", async () => {
    // A lease released only on the happy path is a lease that leaks on
    // exactly the runs whose reading went wrong — which is to say, on the
    // evidence most worth keeping.
    await withSandbox(async (box) => {
      retained(box)
      const exploding: XcresultTool = {
        identity: identityFor(loadFixture("passed")),
        run() {
          throw new Error("the bundle could not be read")
        },
      } as unknown as XcresultTool

      const service = createTestToolService(
        environmentFor(box, { xcresultToolFor: () => exploding }),
      )
      await service
        .inspect({ runId: RUN, facet: "failures", diagnosticId: "d1" })
        .catch(() => undefined)

      expect(anyLeaseHeld(reconcileLeases(box.storage, NOW))).toBe(false)
    })
  })

  test("takes no lease for a run id that could never address storage", async () => {
    // Nothing is going to be read, so there is nothing to hold — and a lease
    // file named after an unusable identifier is a file nothing will ever
    // release deliberately.
    await withSandbox(async (box) => {
      const service = createTestToolService(environmentFor(box))

      await service.inspect({ runId: "../escape", facet: "failures" })

      expect(anyLeaseHeld(reconcileLeases(box.storage, NOW))).toBe(false)
    })
  })
})
