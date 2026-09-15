/**
 * Result Bundle stabilization and digest verification (#8, issue #23).
 *
 * The digest exists so a later read can say whether it is looking at the same
 * bytes. A mismatch never invalidates what was already read and normalized —
 * that happened, and the index records it — but it does mean bundle-backed
 * detail can no longer be trusted to describe the same thing.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
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

/**
 * The digest, or `undefined` when the walk did not finish.
 *
 * The typed outcome is what the production callers act on — a deadline and an
 * unreadable tree ask different things — but a test comparing two digests for
 * equality is not about that distinction, and spelling it out at every call
 * site would bury what each of these is checking.
 */
function digestOf(path: string, budgetMs?: number): string | undefined {
  const outcome = budgetMs === undefined ? bundleDigest(path) : bundleDigest(path, budgetMs)
  return outcome.status === "digested" ? outcome.digest : undefined
}


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
    runtime: { path: "/opt/bun" },
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
      expect(digestOf(a)).toBe(digestOf(b))
    })
  })

  test("changes when the content does", async () => {
    await withSandbox((box) => {
      const a = seedWithBundle(box, "run-a", "one")
      const b = seedWithBundle(box, "run-b", "two")
      expect(digestOf(a)).not.toBe(digestOf(b))
    })
  })

  test("never depends on bytes outside the bundle", async () => {
    await withSandbox((box) => {
      const outside = join(box.storage.rootDir, "outside")
      writeFileSync(outside, "first")

      const bundle = seedWithBundle(box, "run-a", "same")
      symlinkSync(outside, join(bundle, "link"))
      const before = digestOf(bundle)

      // A digest that followed the link would change here, and a Test Run's
      // identity would then be editable by anything that can write this file.
      writeFileSync(outside, "second, and much longer than the first")
      expect(digestOf(bundle)).toBe(before)
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
        bundleDigest: digestOf(bundle),
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
        readFileSync(
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

  test("records a digest for a run that crashed before stabilization", async () => {
    // Nothing to compare against is not a reason to leave the run unverifiable
    // forever: recording one now is what lets any later read say whether the
    // bytes changed.
    await withSandbox(async (box) => {
      seedWithBundle(box, "run-unrecorded", "whatever")
      expect(readRunRecord(box.storage, "run-unrecorded")?.bundleDigest).toBeUndefined()

      await finalizeRecovered(environmentFor(box), "run-unrecorded")

      expect(readRunRecord(box.storage, "run-unrecorded")?.bundleDigest).toMatch(/^[0-9a-f]{64}$/)
      const index = JSON.parse(
        readFileSync(join(runDirectory(box.storage, "run-unrecorded"), "index.json"), "utf8"),
      ) as { bundleDigestVerified: string }
      expect(index.bundleDigestVerified).toBe("yes")
    })
  })

  test("is `unknown` when the bundle is not there to digest", async () => {
    await withSandbox(async (box) => {
      createRunDirectory(box.storage, "run-nobundle")
      seedRun(box.storage, {
        runId: "run-nobundle",
        state: "executionCompleted",
        resolved: RESOLVED,
        requestedScope: { kind: "all" },
      })

      await finalizeRecovered(environmentFor(box), "run-nobundle")

      const index = JSON.parse(
        readFileSync(join(runDirectory(box.storage, "run-nobundle"), "index.json"), "utf8"),
      ) as { bundleDigestVerified: string }
      expect(index.bundleDigestVerified).toBe("unknown")
    })
  })

  test("is `unknown` when the digest could not finish inside its budget", async () => {
    // Verification is never skipped, but it is bounded — an unfinished check
    // reaches the caller as unfinished rather than as a guess.
    await withSandbox((box) => {
      const bundle = seedWithBundle(box, "run-slow", "bytes")
      expect(digestOf(bundle, 0)).toBeUndefined()
    })
  })
})
