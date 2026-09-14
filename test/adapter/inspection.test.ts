/**
 * Progressive inspection end to end (#7, issue #24).
 *
 * These drive the real service against real retained artifacts on disk,
 * because that is where the parts of the contract that matter live: the log
 * is a file, the cap is about serialized bytes, and bundle-backed detail is
 * gated on facts recorded when the run finished.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, INDEX_ARTIFACT, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { RESPONSE_BYTE_CAP, RESPONSE_ENVELOPE_BYTES } from "../../src/domain/limits.ts"
import type { InspectRunRequest, InspectionResponse } from "../../src/domain/inspection.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { RUN_ARTIFACTS, createRunDirectory, runDirectory } from "../../src/runner/paths.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"

const RUN = "run-inspect"

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
    cursorSecret: Buffer.alloc(32, 7),
  }
}

function indexWith(overrides: Partial<NormalizedIndex> = {}): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId: RUN,
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [],
    testFailures: [],
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
    ...overrides,
  }
}

/** A retained run with the given index and, optionally, a raw log. */
async function retained<T>(
  index: NormalizedIndex,
  work: (inspect: (request: Partial<InspectRunRequest>) => Promise<InspectionResponse<unknown>>) => T,
  log?: Buffer,
): Promise<T> {
  return withSandbox(async (box) => {
    createRunDirectory(box.storage, RUN)
    seedRun(box.storage, { runId: RUN, state: "completed" })
    writeFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), JSON.stringify(index), {
      mode: 0o600,
    })
    if (log !== undefined) {
      writeFileSync(join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.rawLog), log, { mode: 0o600 })
    }

    const service = createTestToolService(environmentFor(box))
    return work((request) => service.inspect({ runId: RUN, facet: "scope", ...request }))
  })
}

function chunkOf(response: InspectionResponse<unknown>) {
  if (response.status !== "available" && response.status !== "incomplete") {
    throw new Error(`expected a page, got ${response.status}`)
  }
  return (response.data as { chunk: { text: string; byteOffset: number; byteLength: number; lossyDecoding: boolean } }).chunk
}

describe("the log facet", () => {
  const log = Buffer.from("built ✓\ntested ✓\ndone\n", "utf8")

  test("reads the retained log from disk, not from the index", async () => {
    await retained(
      indexWith({ log: { availability: "available", retainedBytes: log.length, retainedBytesExact: true } }),
      async (inspect) => {
        const chunk = chunkOf(await inspect({ facet: "log" }))
        expect(chunk.text).toBe(log.toString("utf8"))
        expect(chunk.byteOffset).toBe(0)
        expect(chunk.byteLength).toBe(log.length)
        expect(chunk.lossyDecoding).toBe(false)
      },
      log,
    )
  })

  test("pages with an opaque cursor that resumes exactly where it stopped", async () => {
    await retained(
      indexWith({ log: { availability: "available", retainedBytes: log.length, retainedBytesExact: true } }),
      async (inspect) => {
        const first = await inspect({ facet: "log", maxBytes: 8 })
        if (first.status !== "available") throw new Error("expected a page")

        const cursor = first.truncation.nextCursor
        expect(cursor).toBeDefined()
        // Opaque: it discloses neither the offset nor the run it belongs to.
        expect(cursor).not.toContain("8")
        expect(cursor).not.toContain(RUN)

        const second = chunkOf(await inspect({ facet: "log", maxBytes: 8, cursor }))
        expect(second.byteOffset).toBe(chunkOf(first).byteLength)
        expect(chunkOf(first).text + second.text).toBe(
          log.subarray(0, chunkOf(first).byteLength + second.byteLength).toString("utf8"),
        )
      },
      log,
    )
  })

  test("refuses a cursor issued for another facet", async () => {
    await retained(
      indexWith({ log: { availability: "available", retainedBytes: log.length, retainedBytesExact: true } }),
      async (inspect) => {
        const page = await inspect({ facet: "log", maxBytes: 8 })
        const cursor = page.status === "available" ? page.truncation.nextCursor : undefined
        expect(await inspect({ facet: "tests", cursor })).toMatchObject({ status: "invalid" })
      },
      log,
    )
  })

  test("is unsupported when no log was ever retained", async () => {
    await retained(
      indexWith({ log: { availability: "unavailable", retainedBytesExact: false } }),
      async (inspect) => {
        expect(await inspect({ facet: "log" })).toMatchObject({ status: "unsupported", facet: "log" })
      },
    )
  })

  test("is expired when the index says a log was retained and it is gone", async () => {
    // Retention deleted it between the index being published and this read.
    // "Unsupported" would claim the run never produced one, which is false.
    await retained(
      indexWith({ log: { availability: "available", retainedBytes: 10, retainedBytesExact: true } }),
      async (inspect) => {
        expect(await inspect({ facet: "log" })).toMatchObject({ status: "expired" })
      },
    )
  })

  test("says an empty page does not prove there was no output", async () => {
    await retained(
      indexWith({ log: { availability: "incomplete", retainedBytes: log.length, retainedBytesExact: false } }),
      async (inspect) => {
        expect(await inspect({ facet: "log" })).toMatchObject({ status: "incomplete" })
      },
      log,
    )
  })

  test("has no diagnostics or tests to focus on", async () => {
    await retained(indexWith(), async (inspect) => {
      expect(await inspect({ facet: "log", diagnosticId: "x" })).toMatchObject({ status: "invalid" })
    })
  })
})

describe("the response cap", () => {
  /** Attestations big enough that a full page of them would blow the cap. */
  function bulkyAttestations(count: number) {
    return Array.from({ length: count }, (_, n) => ({
      selection: { bundle: "AppTests", suite: `Suite${n}`, test: `test${"x".repeat(2_000)}()` },
      verdict: "matched" as const,
      matchedTestCount: 1,
    }))
  }

  test("holds for a structured page, and the cursor matches what was returned", async () => {
    await retained(
      indexWith({ attestations: bulkyAttestations(100) as NormalizedIndex["attestations"] }),
      async (inspect) => {
        const response = await inspect({ facet: "scope", limit: 100 })
        if (response.status !== "available") throw new Error("expected a page")

        const records = (response.data as { records: unknown[] }).records
        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect(records.length).toBeLessThan(100)

        // The cap cut this page and more records exist: both are true, and a
        // caller needs each for a different decision.
        expect(response.truncation.responseTruncated).toBe(true)
        expect(response.truncation.hasMore).toBe(true)

        // The cursor must point at the first record that was *not* returned.
        // Pointing past the dropped ones would skip evidence silently.
        const next = await inspect({ facet: "scope", cursor: response.truncation.nextCursor })
        if (next.status !== "available") throw new Error("expected a page")
        expect((next.data as { records: unknown[] }).records[0]).toEqual(
          bulkyAttestations(100)[records.length] as never,
        )
      },
    )
  })

  test("holds for a log chunk, whose escaping expands it well past its byte count", async () => {
    // Every byte becomes six in JSON, so a window sized against the cap in raw
    // bytes would overshoot it by a factor of six.
    const log = Buffer.alloc(65_536, 0x01)
    await retained(
      indexWith({ log: { availability: "available", retainedBytes: log.length, retainedBytesExact: true } }),
      async (inspect) => {
        const response = await inspect({ facet: "log", maxBytes: 65_536 })
        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        if (response.status !== "available") throw new Error("expected a page")
        expect(response.truncation.responseTruncated).toBe(true)
        expect(response.truncation.hasMore).toBe(true)
      },
      log,
    )
  })

  test("always makes progress, even when one record is larger than the cap", async () => {
    // Oversized in its *message*, which is display text: it shortens, and the
    // record is still returned. Returning nothing here would freeze the cursor
    // at this position forever, and the caller could never reach anything
    // beyond it.
    const enormous = [
      {
        id: "diag-1",
        kind: "testFailure" as const,
        message: `XCTAssertEqual failed${" and more".repeat(30_000)}`,
        testId: "occ-1",
        inspectionAvailable: true,
      },
    ]
    await retained(
      indexWith({ testFailures: enormous as NormalizedIndex["testFailures"] }),
      async (inspect) => {
        const response = await inspect({ facet: "failures" })
        if (response.status !== "available") throw new Error("expected a page")

        const records = (response.data as { records: Array<Record<string, unknown>> }).records
        expect(records).toHaveLength(1)

        // And it still fits: a mandatory record that cannot be dropped is
        // shortened instead, never returned over the cap.
        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect(response.truncation.fieldTruncated).toBe(true)

        // What survives is what a caller acts on. A truncated id addresses
        // nothing, and a truncated kind is a different kind.
        expect(records[0]?.["id"]).toBe("diag-1")
        expect(records[0]?.["kind"]).toBe("testFailure")
        expect(records[0]?.["testId"]).toBe("occ-1")
      },
    )
  })

  test("never shortens a nested test name, cheap though it is to cut", async () => {
    // Being nested is what made these the first strings to go: one level down
    // inside a selection, they were simply the longest thing available. A
    // halved test name is an `-only-testing` filter that runs nothing, which
    // makes depth exactly the wrong basis for the decision.
    const enormous = [
      {
        selection: { bundle: "AppTests", suite: "S", test: `test${"x".repeat(200_000)}()` },
        verdict: "matched" as const,
        matchedTestCount: 1,
      },
    ]
    await retained(
      indexWith({ attestations: enormous as NormalizedIndex["attestations"] }),
      async (inspect) => {
        const response = await inspect({ facet: "scope" })
        if (response.status !== "incomplete") throw new Error("expected an incomplete page")

        expect((response.data as { records: unknown[] }).records).toHaveLength(0)
        expect(response.truncation.recordsOmitted).toBe(1)

        // Progress is still made: the cursor accounts for it, so a caller
        // asking again reaches what comes after rather than this page forever.
        expect(response.truncation.hasMore).toBe(false)
      },
    )
  })

  test("omits a record rather than shortening the identifier that makes it oversized", async () => {
    // The cap is not a preference, and neither is an identifier. A halved
    // canonical name still looks like a name: a caller would ask about a test
    // that does not exist and be told, correctly and uselessly, that it is not
    // there. Absence is the honest answer, and the page says so.
    const occurrence = {
      id: "occ-1",
      identity: {
        bundle: "AppTests",
        suite: "Suite",
        test: `test${"x".repeat(200_000)}()`,
        canonical: `AppTests/Suite/test${"x".repeat(200_000)}()`,
      },
      identityComplete: true,
      status: "passed" as const,
      position: "0",
      attempts: [],
      failures: [],
    }

    await retained(
      indexWith({ occurrences: [occurrence] as NormalizedIndex["occurrences"] }),
      async (inspect) => {
        const response = await inspect({ facet: "tests" })

        // Never `available`: that status promises an empty page means zero
        // records, and here it would mean one the caller cannot be shown.
        if (response.status !== "incomplete") throw new Error("expected an incomplete page")

        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect((response.data as { records: unknown[] }).records).toHaveLength(0)
        expect(response.truncation.recordsOmitted).toBe(1)
        expect(response.truncation.responseTruncated).toBe(true)

        // And the cursor has moved past it: there is nothing after it here, so
        // the page is the last one rather than an empty one repeating forever.
        expect(response.truncation.hasMore).toBe(false)
      },
    )
  })

  test("never shortens a source identifier, which is how a reader finds the test in Xcode", async () => {
    // Retained only when the Result Bundle spells the test differently from
    // the canonical form, which makes it the one string that gets a reader
    // from this tool's output back to Xcode's. Half of it gets them nowhere.
    const occurrence = {
      id: "occ-1",
      identity: {
        bundle: "AppTests",
        suite: "LoginTests",
        test: "testSignsIn()",
        canonical: "AppTests/LoginTests/testSignsIn()",
        sourceIdentifier: `AppTests/LoginTests/testSignsIn${"x".repeat(200_000)}`,
      },
      identityComplete: true,
      status: "passed" as const,
      position: "0",
      attempts: [],
      failures: [],
    }

    await retained(
      indexWith({ occurrences: [occurrence] as NormalizedIndex["occurrences"] }),
      async (inspect) => {
        const response = await inspect({ facet: "tests" })
        if (response.status !== "incomplete") throw new Error("expected an incomplete page")

        expect((response.data as { records: unknown[] }).records).toHaveLength(0)
        expect(response.truncation.recordsOmitted).toBe(1)
        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
      },
    )
  })

  test("omits an attestation whose selection is what makes it oversized", async () => {
    // The same rule for the other record shape. A bundle name is what a
    // verdict is *about*; halving it would attribute a verdict to a selection
    // nobody made.
    const attestation = {
      selection: { bundle: `AppTests${"x".repeat(200_000)}` },
      verdict: "matched" as const,
    }

    await retained(
      indexWith({ attestations: [attestation] as NormalizedIndex["attestations"] }),
      async (inspect) => {
        const response = await inspect({ facet: "scope" })
        if (response.status !== "incomplete") throw new Error("expected an incomplete page")

        expect((response.data as { records: unknown[] }).records).toHaveLength(0)
        expect(response.truncation.recordsOmitted).toBe(1)
      },
    )
  })

  test("does not claim a field was truncated when none was", async () => {
    await retained(
      indexWith({ attestations: bulkyAttestations(3) as NormalizedIndex["attestations"] }),
      async (inspect) => {
        const response = await inspect({ facet: "scope" })
        if (response.status !== "available") throw new Error("expected a page")

        // An ordinary page reports nothing truncated, because nothing was.
        expect(response.truncation.fieldTruncated).toBe(false)
        expect(response.truncation.responseTruncated).toBe(false)
      },
    )
  })

  test("shortens the same oversized record the same way every time", async () => {
    const enormous = [
      {
        selection: { bundle: "AppTests", suite: "S", test: `test${"x".repeat(200_000)}()` },
        verdict: "matched" as const,
        matchedTestCount: 1,
      },
    ]
    const page = async () =>
      retained(
        indexWith({ attestations: enormous as NormalizedIndex["attestations"] }),
        async (inspect) => JSON.stringify(await inspect({ facet: "scope" })),
      )

    // Determinism is the difference between a caller that can compare two
    // reads and one that cannot.
    expect(await page()).toBe(await page())
  })
})

describe("bundle-backed detail", () => {
  const diagnostic = {
    id: "diag-1",
    kind: "testFailure" as const,
    message: "XCTAssertEqual failed",
    testId: "occ-1",
    location: { path: "Sources/App/Login.swift", line: 42, column: 9 },
    inspectionAvailable: true,
  }

  const occurrence = {
    id: "occ-1",
    identity: {
      bundle: "AppTests",
      suite: "LoginTests",
      test: "testSignsIn()",
      canonical: "AppTests/LoginTests/testSignsIn()",
    },
    identityComplete: true,
    status: "failed" as const,
    position: "0/0/0",
    attempts: [{ ordinal: 1, status: "failed" as const }],
    failures: [
      {
        message: `XCTAssertEqual failed${" and here is a great deal more detail".repeat(40)}`,
        location: { path: "Sources/App/Login.swift", line: 42, column: 9 },
        position: "0",
      },
    ],
  }

  const focusedIndex = (digest: NormalizedIndex["bundleDigestVerified"]) =>
    indexWith({
      bundleDigestVerified: digest,
      testFailures: [diagnostic],
      occurrences: [occurrence] as NormalizedIndex["occurrences"],
      // Retained when the evidence was fresh, which is what a focused view
      // exists to show past the summary's cap.
      fullMessages: { "diag-1": occurrence.failures[0]?.message ?? "" },
    })

  test("degrades to the indexed view when the bundle is not the one that was read", async () => {
    await retained(focusedIndex("no"), async (inspect) => {
      const response = await inspect({ facet: "failures", diagnosticId: "diag-1" })

      // `incomplete` is the load-bearing word: on an available response an
      // empty activities list means there were none, and here it means
      // nobody could look.
      expect(response.status).toBe("incomplete")
      const focused = (response.data as { focused: { activities: unknown[]; message: string } }).focused
      expect(focused.activities).toEqual([])

      // The indexed part does not degrade with it: the full message was
      // retained when the evidence was fresh, and is still here.
      expect(focused.message.length).toBeGreaterThan(diagnostic.message.length)
    })
  })

  test("still pages the index immutably while detail is degraded", async () => {
    await retained(focusedIndex("no"), async (inspect) => {
      // Ordinary paging never reopens the bundle, so a digest mismatch cannot
      // reach it.
      expect(await inspect({ facet: "failures" })).toMatchObject({ status: "available" })
    })
  })

  test("carries the identity and the safe location the diagnostic belongs to", async () => {
    await retained(focusedIndex("unknown"), async (inspect) => {
      const response = await inspect({ facet: "failures", diagnosticId: "diag-1" })
      if (response.status !== "incomplete") throw new Error("expected a focused view")

      const focused = (response.data as {
        focused: { identity?: { canonical: string }; location?: { path: string } }
      }).focused
      expect(focused.identity?.canonical).toBe(occurrence.identity.canonical)
      // Repository-relative, never an absolute path on this machine.
      expect(focused.location?.path).toBe("Sources/App/Login.swift")
      expect(focused.location?.path.startsWith("/")).toBe(false)
    })
  })

  test("reports notFound for an identifier no retained run holds", async () => {
    await retained(focusedIndex("yes"), async (inspect) => {
      expect(await inspect({ facet: "failures", diagnosticId: "nope" })).toEqual({
        status: "notFound",
        subject: "diagnostic",
      })
    })
  })

  test("says why it is incomplete, rather than leaving a caller to guess", async () => {
    await retained(focusedIndex("yes"), async (inspect) => {
      const response = await inspect({ facet: "failures", diagnosticId: "diag-1" })
      if (response.status !== "incomplete") throw new Error("expected a focused view")

      // The bundle is gone. "Ran out of time" and "the evidence is no longer
      // there" ask different things of a caller, so the response says which.
      expect(response.annotation).toContain("no longer retained")
    })
  })

  test("is unsupported when the recorded installation is not the one reading", async () => {
    const index = focusedIndex("yes")
    index.toolchain = { ...index.toolchain, xcresulttoolDigest: "a-different-binary" }

    await withSandbox(async (box) => {
      createRunDirectory(box.storage, RUN)
      seedRun(box.storage, { runId: RUN, state: "completed", bundleDigest: "d" })
      writeFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), JSON.stringify(index), {
        mode: 0o600,
      })
      // A bundle exists, so the gate that fires is the toolchain one.
      mkdirSync(join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.resultBundle))

      const service = createTestToolService(environmentFor(box))
      const response = await service.inspect({ runId: RUN, facet: "failures", diagnosticId: "diag-1" })

      // #8: a path-and-version match without the binary digest is not enough,
      // because an Xcode replaced in place keeps both and changes neither.
      expect(response).toMatchObject({ status: "unsupported" })
    })
  })

  test("refuses to attach detail it cannot associate to exactly one occurrence", async () => {
    // The same test on two devices is two occurrences with one canonical
    // identity. Attaching a sibling's detail here would be a quiet fabrication.
    const index = focusedIndex("yes")
    index.occurrences = [
      { ...occurrence, id: "occ-1", deviceId: "D1" },
      { ...occurrence, id: "occ-2", deviceId: "D1" },
    ] as NormalizedIndex["occurrences"]

    await withSandbox(async (box) => {
      createRunDirectory(box.storage, RUN)
      seedRun(box.storage, { runId: RUN, state: "completed", bundleDigest: "d" })
      writeFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), JSON.stringify(index), {
        mode: 0o600,
      })
      mkdirSync(join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.resultBundle))

      const service = createTestToolService(environmentFor(box))
      const response = await service.inspect({ runId: RUN, facet: "failures", diagnosticId: "diag-1" })

      if (response.status !== "incomplete") throw new Error("expected a focused view")
      expect(response.annotation).toContain("more than one retained occurrence")
    })
  })
})

describe("a focused view that cannot fit the cap", () => {
  /** An occurrence whose identity alone is larger than any response may be. */
  const enormousIdentity = {
    id: "occ-1",
    identity: {
      bundle: "AppTests",
      suite: "LoginTests",
      test: `testSignsIn${"x".repeat(200_000)}()`,
      canonical: `AppTests/LoginTests/testSignsIn${"x".repeat(200_000)}()`,
    },
    identityComplete: true,
    status: "failed" as const,
    position: "0",
    attempts: [],
    failures: [],
  }

  /** A diagnostic whose *location* is what makes it oversized. */
  const enormousLocation = {
    id: "diag-1",
    kind: "testFailure" as const,
    message: "XCTAssertEqual failed",
    testId: "occ-1",
    location: { path: `Sources/App/${"Nested/".repeat(20_000)}Login.swift`, line: 42 },
    inspectionAvailable: true,
  }

  test("is omitted rather than returned over the cap, when the identity is what is oversized", async () => {
    // Shedding runs out: attachments, activities, frames, attempts and the
    // message are all gone, and what is left is the identity — which a caller
    // acts on and which is never shortened.
    await retained(
      indexWith({ occurrences: [enormousIdentity] as NormalizedIndex["occurrences"] }),
      async (inspect) => {
        const response = await inspect({ facet: "tests", testId: "occ-1" })

        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect(response.status).toBe("incomplete")
        if (response.status !== "incomplete") return
        expect((response.data as { view: string }).view).toBe("omitted")
        expect(response.truncation.recordsOmitted).toBe(1)
      },
    )
  })

  test("is omitted rather than returned over the cap, when the location is what is oversized", async () => {
    // A safe location is somewhere to go and look. Halving the path names a
    // file that does not exist, which is worse than saying nothing.
    await retained(
      indexWith({
        testFailures: [enormousLocation] as NormalizedIndex["testFailures"],
        occurrences: [
          {
            ...enormousIdentity,
            identity: {
              bundle: "AppTests",
              suite: "LoginTests",
              test: "testSignsIn()",
              canonical: "AppTests/LoginTests/testSignsIn()",
            },
          },
        ] as NormalizedIndex["occurrences"],
      }),
      async (inspect) => {
        const response = await inspect({ facet: "failures", diagnosticId: "diag-1" })

        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect(response.status).toBe("incomplete")
        if (response.status !== "incomplete") return
        expect((response.data as { view: string }).view).toBe("omitted")
      },
    )
  })

  test("says the record exists and will not fit, not that it has no detail", async () => {
    // The distinction the view exists for. An empty focused body says the
    // test recorded nothing; this says it recorded plenty and none of it can
    // be sent without altering something a caller addresses it by.
    await retained(
      indexWith({ occurrences: [enormousIdentity] as NormalizedIndex["occurrences"] }),
      async (inspect) => {
        const response = await inspect({ facet: "tests", testId: "occ-1" })
        if (response.status !== "incomplete") throw new Error("expected an incomplete response")

        expect(response.annotation).toContain("cannot be returned within the response cap")
        expect((response.data as { reason: string }).reason).toContain("identifier")
      },
    )
  })

  test("still returns a focused view that does fit", async () => {
    // The other direction, so the tests above cannot pass by refusing
    // everything: an ordinary record comes back focused.
    await retained(
      indexWith({
        occurrences: [
          {
            ...enormousIdentity,
            identity: {
              bundle: "AppTests",
              suite: "LoginTests",
              test: "testSignsIn()",
              canonical: "AppTests/LoginTests/testSignsIn()",
            },
          },
        ] as NormalizedIndex["occurrences"],
      }),
      async (inspect) => {
        const response = await inspect({ facet: "tests", testId: "occ-1" })
        const data = response.status === "available" || response.status === "incomplete"
          ? (response.data as { view: string })
          : undefined

        expect(data?.view).toBe("focused")
      },
    )
  })
})

describe("the room a response reserves for everything but its data", () => {
  test("is enough for the largest envelope this contract can produce", () => {
    // `fits` measures the view and subtracts a flat RESPONSE_ENVELOPE_BYTES
    // for the rest — the status, the facet, the truncation state, the cursor
    // and the annotation. That makes the cap a guarantee only while the rest
    // really does fit in that allowance, and nothing else checks it: the
    // annotation is assembled after the view has been fitted, so a long one
    // would push an already-fitted response over the bound it was fitted to.
    const largest = {
      status: "incomplete",
      completeness: "partial",
      truncation: {
        fieldTruncated: true,
        collectionTruncated: true,
        responseTruncated: true,
        hasMore: true,
        recordsOmitted: 1,
        // A cursor is the longest variable-length thing in an envelope, and
        // this is comfortably longer than one the tool issues.
        nextCursor: "x".repeat(256),
      },
      data: { view: "omitted", facet: "buildErrors", reason: OMITTED_REASON },
      annotation: LONGEST_ANNOTATION,
    }

    expect(Buffer.byteLength(JSON.stringify(largest), "utf8")).toBeLessThanOrEqual(
      RESPONSE_ENVELOPE_BYTES,
    )
  })
})

/** The wording a withheld focused view carries, as `paging.ts` writes it. */
const OMITTED_REASON =
  "this record cannot be returned within the response cap without altering an identifier"

/**
 * The longest annotation any inspection response can carry.
 *
 * Every one is a fixed literal chosen by this repository — no caller text and
 * no message from a tool reaches an annotation — so the longest of them is a
 * fact that can be written down and checked.
 */
const LONGEST_ANNOTATION =
  "the retained evidence for this Test Run is not trustworthy; " +
  "detail could not be associated to exactly one occurrence; " +
  "1 record(s) could not be returned within the response cap"
