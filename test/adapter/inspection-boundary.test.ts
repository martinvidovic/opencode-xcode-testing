/**
 * The inspection boundary (#26).
 *
 * Inspection is the one place a model hands the tool something that addresses
 * storage. Everything it can hand over is either an opaque handle this tool
 * issued or it is nothing at all, and the difference must be an answer rather
 * than an exception — a Test Tool that throws at its own boundary tells a
 * caller nothing it can act on.
 */

import { describe, expect, test } from "bun:test"
import { writeFileSync, symlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, INDEX_ARTIFACT, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { createRunDirectory, runDirectory } from "../../src/runner/paths.ts"
import { INDEX_VERSION } from "../../src/interpreter/index-model.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"

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
  }
}

/** Inspect `runId`, with `index.json` written exactly as `body` says. */
async function inspectWith(runId: string, body?: string) {
  return withSandbox(async (box) => {
    const service = createTestToolService(environmentFor(box))
    if (body !== undefined) {
      createRunDirectory(box.storage, "run-real")
      seedRun(box.storage, { runId: "run-real", state: "completed" })
      writeFileSync(join(runDirectory(box.storage, "run-real"), INDEX_ARTIFACT), body, {
        mode: 0o600,
      })
    }
    return service.inspect({ runId, facet: "scope" })
  })
}

const HOSTILE = ["..", "../../etc/passwd", "run/../../queue.json", "/etc/passwd", "", "run id"]

describe("an inspection handle that could address storage", () => {
  test("is answered as an unknown run, not raised as an error", async () => {
    for (const runId of HOSTILE) {
      // `notFound` is the honest answer: within this root's namespace the
      // handle names nothing, and saying anything more would confirm what the
      // filesystem does and does not contain.
      expect(await inspectWith(runId)).toEqual({ status: "notFound", subject: "run" })
    }
  })

  test("never reveals whether the path it named exists", async () => {
    const forGone = await inspectWith("0f8a2c91b4e7d6538a1c0b2e4f6a8d31")
    expect(await inspectWith("../../etc/passwd")).toEqual(forGone)
  })
})

describe("a retained index that cannot be trusted", () => {
  test("is invalid rather than parsed for whatever it happens to say", async () => {
    // The file is present, so it is not "not found": the evidence exists and
    // cannot be trusted, which is a different thing to tell a caller.
    expect(await inspectWith("run-real", "not json at all")).toMatchObject({
      status: "invalid",
    })
    expect(await inspectWith("run-real", "{}")).toMatchObject({ status: "invalid" })
  })

  test("is invalid when it was published by a different index version", async () => {
    const index = JSON.stringify({ indexVersion: INDEX_VERSION + 1, runId: "run-real" })
    expect(await inspectWith("run-real", index)).toMatchObject({ status: "invalid" })
  })

  test("is invalid when it names a different run", async () => {
    // A well-formed index found in the wrong directory is not this run's
    // evidence, however complete it looks.
    const index = JSON.stringify({
      indexVersion: INDEX_VERSION,
      runId: "run-other",
      decoderVersion: 1,
      schemaVersion: "0.1.0",
      occurrences: [],
      testFailures: [],
      buildErrors: [],
      attestations: [],
      scopeVerdict: "unverifiable",
      scopeDigest: "d",
      requestedSelectionCount: 0,
      observedOutsideScope: 0,
      build: { completeness: "unavailable" },
      tests: { completeness: "unavailable" },
      log: { availability: "unavailable", retainedBytesExact: false },
      bundleDigestVerified: "unknown",
    })
    expect(await inspectWith("run-real", index)).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("does not belong"),
    })
  })

  test("is refused outright when it is a symbolic link", async () => {
    const response = await withSandbox(async (box) => {
      const service = createTestToolService(environmentFor(box))
      createRunDirectory(box.storage, "run-real")
      seedRun(box.storage, { runId: "run-real", state: "completed" })

      // Anything on the machine that can create this link could otherwise
      // decide what a Test Run is reported to have found.
      const planted = join(box.storage.rootDir, "planted.json")
      writeFileSync(planted, "{}\n")
      symlinkSync(planted, join(runDirectory(box.storage, "run-real"), INDEX_ARTIFACT))

      return service.inspect({ runId: "run-real", facet: "scope" })
    })

    expect(response).toMatchObject({
      status: "invalid",
      message: expect.stringContaining("not trustworthy"),
    })
  })

  test("is not confused by a directory standing where the index should be", async () => {
    const response = await withSandbox(async (box) => {
      const service = createTestToolService(environmentFor(box))
      createRunDirectory(box.storage, "run-real")
      seedRun(box.storage, { runId: "run-real", state: "completed" })
      mkdirSync(join(runDirectory(box.storage, "run-real"), INDEX_ARTIFACT))

      return service.inspect({ runId: "run-real", facet: "scope" })
    })

    expect(response).toMatchObject({ status: "invalid" })
  })
})
