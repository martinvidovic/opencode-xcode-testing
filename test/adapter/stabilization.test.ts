/**
 * Result Bundle stabilization and digest verification (#8, issue #23).
 *
 * The digest exists so a later read can say whether it is looking at the same
 * bytes. A mismatch never invalidates what was already read and normalized —
 * that happened, and the index records it — but it does mean bundle-backed
 * detail can no longer be trusted to describe the same thing.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { bundleDigest, finalizeRecovered } from "../../src/adapter/service.ts"
import { createRunDirectory, runDirectory } from "../../src/runner/paths.ts"
import { writeQueue } from "../../src/runner/queue.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { identityFor, loadFixture, RESOLVED } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"
import type { XcresultTool } from "../../src/interpreter/ports.ts"
import type { XcresultCommand } from "../../src/interpreter/anomalies.ts"
import type { ServiceEnvironment } from "../../src/adapter/service.ts"

function fixtureReader(name: string): XcresultTool {
  const fixture = loadFixture(name)
  return {
    identity: identityFor(fixture),
    async run(command: XcresultCommand) {
      if (!(command in fixture.payloads)) {
        return { ok: false as const, failure: "commandFailed" as const, message: "no payload" }
      }
      return { ok: true as const, payload: fixture.payloads[command] }
    },
  }
}

function environmentFor(box: Sandbox): ServiceEnvironment {
  return {
    storage: box.storage,
    trustedRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtimePath: "/opt/bun",
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    now: () => 0,
    timestamp: () => "2026-09-13T12:00:00.000Z",
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 3),
    xcresultToolFor: () => fixtureReader("passed"),
  }
}

function seedWithBundle(box: Sandbox, runId: string, contents: string, digest?: string) {
  createRunDirectory(box.storage, runId)
  const bundle = join(runDirectory(box.storage, runId), "result.xcresult")
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, "Info.plist"), contents)

  seedRun(box.storage, {
    runId,
    state: "executionCompleted",
    supervisor: { pid: 100, startedAt: "s" },
    resolved: RESOLVED,
    requestedScope: { kind: "all" },
    execObserved: "yes",
    exitCode: 0,
    ...(digest === undefined ? {} : { bundleDigest: digest }),
  })
  writeQueue(box.storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: runId })
  return bundle
}

describe("the bundle digest", () => {
  test("is deterministic over the same content", async () => {
    await withSandbox((box) => {
      const a = seedWithBundle(box, "run-a", "same")
      const b = seedWithBundle(box, "run-b", "same")
      expect(bundleDigest(a)).toBe(bundleDigest(b))
    })
  })

  test("changes when the content does", async () => {
    await withSandbox((box) => {
      const a = seedWithBundle(box, "run-a", "one")
      const b = seedWithBundle(box, "run-b", "two")
      expect(bundleDigest(a)).not.toBe(bundleDigest(b))
    })
  })
})

describe("re-verification before a later read", () => {
  test("confirms a bundle that has not changed", async () => {
    await withSandbox(async (box) => {
      const bundle = seedWithBundle(box, "run-same", "stable")
      seedRun(box.storage, {
        ...(readRunRecord(box.storage, "run-same") as NonNullable<
          ReturnType<typeof readRunRecord>
        >),
        bundleDigest: bundleDigest(bundle),
      })

      await finalizeRecovered(environmentFor(box), "run-same")
      expect(readRunRecord(box.storage, "run-same")?.state).toBe("completed")
    })
  })

  test("surfaces a mismatch without invalidating what was already read", async () => {
    await withSandbox(async (box) => {
      // A digest recorded at stabilization that no longer matches the bytes.
      seedWithBundle(box, "run-changed", "mutated", "0".repeat(64))

      await finalizeRecovered(environmentFor(box), "run-changed")

      const index = JSON.parse(
        require("node:fs").readFileSync(
          join(runDirectory(box.storage, "run-changed"), "index.json"),
          "utf8",
        ),
      ) as { bundleDigestVerified: string; occurrences: unknown[] }

      expect(index.bundleDigestVerified).toBe("no")
      // The evidence that was read is still published; only later bundle-backed
      // detail is affected.
      expect(index.occurrences.length).toBeGreaterThan(0)
    })
  })

  test("is `unknown` when nothing was ever recorded to compare against", async () => {
    await withSandbox(async (box) => {
      seedWithBundle(box, "run-unrecorded", "whatever")

      await finalizeRecovered(environmentFor(box), "run-unrecorded")

      const index = JSON.parse(
        require("node:fs").readFileSync(
          join(runDirectory(box.storage, "run-unrecorded"), "index.json"),
          "utf8",
        ),
      ) as { bundleDigestVerified: string }
      expect(index.bundleDigestVerified).toBe("unknown")
    })
  })
})
