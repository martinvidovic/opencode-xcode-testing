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
    containmentRoot: "/workspace",
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
  test("is incomplete rather than parsed for whatever it happens to say", async () => {
    // The file is present, so it is not "not found": the run happened and its
    // index was published. #8 calls damaged evidence `incomplete` — the caller
    // is told the evidence is partial, not that their request was malformed.
    expect(await inspectWith("run-real", "not json at all")).toMatchObject({
      status: "incomplete",
    })
    expect(await inspectWith("run-real", "{}")).toMatchObject({ status: "incomplete" })
  })

  test("says nothing about the contents it could not read", async () => {
    // It is describing a file this tool did not write and cannot vouch for.
    const response = await inspectWith("run-real", '{"secret": "/Users/someone/thing"}')
    expect(JSON.stringify(response)).not.toContain("/Users/someone")
  })

  test("is unsupported when it was published by a later index version", async () => {
    // Nothing is wrong with it, and nothing here can read it. Retained indexes
    // outlive decoders within the retention window, so that is a different
    // answer from "damaged".
    const index = JSON.stringify({ indexVersion: INDEX_VERSION + 1, runId: "run-real" })
    expect(await inspectWith("run-real", index)).toMatchObject({ status: "unsupported" })
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
      diagnostics: { completeness: "unavailable" },
      fullMessages: {},
      toolchain: { developerDirectory: "/x", xcodeVersion: "26.4.1", xcodeBuild: "17E202", xcresulttoolPath: "/x/t", xcresulttoolVersion: "24757", xcresulttoolDigest: "d", schemaVersion: "0.1.0" },
      log: { availability: "unavailable", retainedBytesExact: false },
      bundleDigestVerified: "unknown",
    })
    // Evidence, not request: the run id asked for is a good one, and what is
    // wrong is the file found under it. A caller told `invalid` would go and
    // change what they asked, and nothing they can ask would help.
    expect(await inspectWith("run-real", index)).toMatchObject({
      status: "incomplete",
      annotation: expect.stringContaining("not trustworthy"),
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
      status: "incomplete",
      annotation: expect.stringContaining("not trustworthy"),
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

    expect(response).toMatchObject({
      status: "incomplete",
      annotation: expect.stringContaining("not trustworthy"),
    })
  })

  test("is refused when a location in it names somewhere on this machine", async () => {
    // The index is the last thing between a planted file and a model. A
    // location it carries is rendered as a place to go and look.
    const index = JSON.stringify({
      indexVersion: INDEX_VERSION,
      runId: "run-real",
      decoderVersion: 1,
      schemaVersion: "0.1.0",
      occurrences: [],
      testFailures: [
        {
          id: "diag-1",
          kind: "testFailure",
          message: "it failed",
          inspectionAvailable: true,
          location: { path: "/Users/someone/Secret/Login.swift" },
        },
      ],
      buildErrors: [],
      attestations: [],
      scopeVerdict: "matched",
      scopeDigest: "d",
      requestedSelectionCount: 0,
      observedOutsideScope: 0,
      build: { completeness: "complete" },
      tests: { completeness: "complete" },
      diagnostics: { completeness: "complete" },
      fullMessages: {},
      toolchain: {
        developerDirectory: "/x",
        xcodeVersion: "26.4.1",
        xcodeBuild: "17E202",
        xcresulttoolPath: "/x/t",
        xcresulttoolVersion: "24757",
        xcresulttoolDigest: "d",
        schemaVersion: "0.1.0",
      },
      log: { availability: "unavailable", retainedBytesExact: false },
      bundleDigestVerified: "yes",
    })

    const response = await inspectWith("run-real", index)
    expect(response).toMatchObject({ status: "incomplete" })
    // And the refusal says nothing about what it refused.
    expect(JSON.stringify(response)).not.toContain("/Users/someone")
  })
})

describe("damaged retained evidence", () => {
  test("is an evidence outcome, never a complaint about the request", async () => {
    // The distinction the contract turns on. `invalid` means "fix what you
    // asked"; nothing a caller can ask will repair a file on this machine, so
    // telling them that sends them to work on the one thing that is fine.
    const response = await withSandbox(async (box) => {
      const service = createTestToolService(environmentFor(box))
      createRunDirectory(box.storage, "run-real")
      seedRun(box.storage, { runId: "run-real", state: "completed" })
      writeFileSync(join(runDirectory(box.storage, "run-real"), INDEX_ARTIFACT), "{ not json")

      return service.inspect({ runId: "run-real", facet: "failures" })
    })

    expect(response.status).toBe("incomplete")
  })

  test("is an evidence outcome when the index decodes but does not validate", async () => {
    // Structurally a JSON object of the right version, and its contents are
    // not what this tool writes. It is the evidence that is wrong, not the
    // request — and it is `incomplete` for the same reason.
    const index = JSON.stringify({
      indexVersion: INDEX_VERSION,
      runId: "run-real",
      decoderVersion: 1,
      schemaVersion: "0.1.0",
      occurrences: [],
      testFailures: [],
      buildErrors: [],
      attestations: [{ verdict: "matched", selection: { bundle: 42 } }],
      scopeVerdict: "matched",
      scopeDigest: "d",
      requestedSelectionCount: 0,
      observedOutsideScope: 0,
      build: { completeness: "unavailable" },
      tests: { completeness: "unavailable" },
      diagnostics: { completeness: "unavailable" },
      fullMessages: {},
      toolchain: {
        developerDirectory: "/x",
        xcodeVersion: "26.4.1",
        xcodeBuild: "17E202",
        xcresulttoolPath: "/x/t",
        xcresulttoolVersion: "24757",
        xcresulttoolDigest: "d",
        schemaVersion: "0.1.0",
      },
      log: { availability: "unavailable", retainedBytesExact: false },
      bundleDigestVerified: "unknown",
    })

    expect(await inspectWith("run-real", index)).toMatchObject({ status: "incomplete" })
  })
})

describe("a retained index carrying an identity that names nothing", () => {
  /** A published index whose single occurrence has the given identity. */
  function indexWithIdentity(identity: unknown, identityComplete: boolean): string {
    return JSON.stringify({
      indexVersion: INDEX_VERSION,
      runId: "run-real",
      decoderVersion: 1,
      schemaVersion: "0.1.0",
      occurrences: [
        {
          id: "occ-1",
          identity,
          identityComplete,
          status: "passed",
          position: "0",
          failures: [],
          attempts: [],
        },
      ],
      testFailures: [],
      buildErrors: [],
      attestations: [],
      scopeVerdict: "matched",
      scopeDigest: "d",
      requestedSelectionCount: 0,
      observedOutsideScope: 0,
      build: { completeness: "complete" },
      tests: { completeness: "complete" },
      diagnostics: { completeness: "complete" },
      fullMessages: {},
      toolchain: {
        developerDirectory: "/x",
        xcodeVersion: "26.4.1",
        xcodeBuild: "17E202",
        xcresulttoolPath: "/x/t",
        xcresulttoolVersion: "24757",
        xcresulttoolDigest: "d",
        schemaVersion: "0.1.0",
      },
      log: { availability: "unavailable", retainedBytesExact: false },
      bundleDigestVerified: "unknown",
    })
  }

  const WHOLE = {
    bundle: "AppTests",
    suite: "LoginTests",
    test: "testSignsIn()",
    canonical: "AppTests/LoginTests/testSignsIn()",
  }

  for (const complete of [true, false]) {
    const claim = complete ? "claiming completeness" : "admitting incompleteness"

    test(`is damaged evidence, not a page of malformed records — blank bundle, ${claim}`, async () => {
      // The outcome is what matters here, not the predicate. A caller must be
      // told the evidence cannot be read, never handed a record whose bundle
      // is `""` — which reads as a name that matches nothing and looks like
      // it should.
      const response = await inspectWith("run-real", indexWithIdentity({ ...WHOLE, bundle: "" }, complete))

      expect(response.status).toBe("incomplete")
      expect(JSON.stringify(response)).not.toContain("LoginTests")
    })

    test(`is damaged evidence — missing canonical form, ${claim}`, async () => {
      // `canonical` is the field a Focused Detail prints, so a leak here is the
      // one a reader would actually see.
      const { canonical: _dropped, ...nameless } = WHOLE
      const response = await inspectWith("run-real", indexWithIdentity(nameless, complete))

      expect(response.status).toBe("incomplete")
      expect(JSON.stringify(response)).not.toContain("LoginTests")
    })

    test(`is damaged evidence — blank optional part, ${claim}`, async () => {
      const response = await inspectWith("run-real", indexWithIdentity({ ...WHOLE, suite: "" }, complete))

      expect(response.status).toBe("incomplete")
      expect(JSON.stringify(response)).not.toContain("testSignsIn")
    })

    test(`reads normally when the optional parts are simply absent, ${claim}`, async () => {
      // Absent is not blank. An identity with no suite is one Xcode did not
      // give a suite for, and refusing it would reject evidence this tool
      // legitimately publishes.
      const response = await inspectWith(
        "run-real",
        indexWithIdentity({ bundle: "AppTests", canonical: "AppTests" }, complete),
      )

      expect(response.status).toBe("available")
    })
  }

  test("reads normally when every part of the identity names something", async () => {
    // The other direction, so the cases above cannot pass by refusing
    // everything a test hands them.
    const response = await inspectWith("run-real", indexWithIdentity(WHOLE, true))

    expect(response.status).toBe("available")
  })
})
