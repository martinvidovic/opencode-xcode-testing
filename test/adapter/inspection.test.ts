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
import { RESPONSE_BYTE_CAP } from "../../src/domain/limits.ts"
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
        if (response.status !== "available") throw new Error("expected a page")

        // Returning nothing would freeze the cursor at this position forever,
        // and the caller could never reach anything beyond it.
        const records = (response.data as { records: Array<Record<string, unknown>> }).records
        expect(records).toHaveLength(1)

        // And it still fits: a mandatory record that cannot be dropped is
        // shortened instead, never returned over the cap.
        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect(response.truncation.fieldTruncated).toBe(true)

        // What survives is what a caller acts on. A truncated verdict would be
        // a different verdict.
        expect(records[0]?.["verdict"]).toBe("matched")
        expect(records[0]?.["matchedTestCount"]).toBe(1)
      },
    )
  })

  test("holds even when the oversized field is one a caller acts on", async () => {
    // A canonical identity is an identifier, and identifiers are the last
    // thing to give — but the cap is not a preference. A record whose
    // *identifier* is what makes it oversized has to give somewhere, or the
    // response goes over the one bound that exists to never be crossed.
    const occurrence = {
      id: "occ-1",
      identity: { canonical: `AppTests/Suite/test${"x".repeat(200_000)}()` },
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
        if (response.status !== "available") throw new Error("expected a page")

        expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(
          RESPONSE_BYTE_CAP,
        )
        expect((response.data as { records: unknown[] }).records).toHaveLength(1)
        expect(response.truncation.fieldTruncated).toBe(true)
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
    identity: { canonical: "AppTests/LoginTests/testSignsIn()", test: "testSignsIn()" },
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
