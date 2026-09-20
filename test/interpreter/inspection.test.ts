/**
 * Failure caps, facet paging, and cursor semantics (#7, #8).
 */

import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"

import type { InspectRunRequest } from "../../src/domain/inspection.ts"
import { INSPECTION_PAGE_MAX } from "../../src/domain/limits.ts"
import { CURSOR_ORDERING_VERSION, decodeCursor, encodeCursor } from "../../src/interpreter/cursor.ts"
import type { NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { inspectIndex } from "../../src/interpreter/paging.ts"
import {
  FAILED_EXIT,
  CONTAINMENT_ROOT,
  interpretFixture,
  recordsOf,
} from "./harness.ts"

const SECRET = Buffer.alloc(32, 7)

async function manyFailures(): Promise<NormalizedIndex> {
  const { index } = await interpretFixture("many-failures", { request: { execution: FAILED_EXIT } })
  return index
}

function inspect(index: NormalizedIndex, request: Partial<InspectRunRequest>) {
  return inspectIndex(
    index,
    { runId: index.runId, facet: "failures", ...request } as InspectRunRequest,
    SECRET,
    CONTAINMENT_ROOT,
  )
}

describe("summary caps", () => {
  test("hold aggregate counts uncapped while the shown records are bounded", async () => {
    const { summary } = await interpretFixture("many-failures", {
      request: { execution: FAILED_EXIT },
    })
    expect(summary.tests.counts?.failed).toBe(25)
    expect(summary.diagnostics.testFailureSection).toEqual({
      total: 25,
      shown: 20,
      truncated: true,
    })
    expect(summary.diagnostics.testFailures).toHaveLength(20)
    expect(summary.diagnostics.observedTestSection).toEqual({
      total: 25,
      shown: 20,
      truncated: true,
    })
  })
})

describe("facet paging", () => {
  test("walks the whole facet through cursors without repeating a record", async () => {
    const index = await manyFailures()
    const seen: string[] = []
    let cursor: string | undefined

    for (let page = 0; page < 10; page += 1) {
      const response = inspect(index, { limit: 10, ...(cursor === undefined ? {} : { cursor }) })
      expect(response.status).toBe("available")
      if (response.status !== "available") break
      seen.push(...recordsOf(response.data).map((record) => record.id))
      cursor = response.truncation.nextCursor
      if (cursor === undefined) break
    }

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
    expect(seen).toEqual(index.testFailures.map((record) => record.id))
  })

  test("reports hasMore and stops offering a cursor on the last page", async () => {
    const index = await manyFailures()
    const first = inspect(index, { limit: 20 })
    expect(first.status === "available" && first.truncation.hasMore).toBe(true)

    const cursor = first.status === "available" ? first.truncation.nextCursor : undefined
    const last = inspect(index, { limit: 20, ...(cursor === undefined ? {} : { cursor }) })
    expect(last.status === "available" && last.truncation.hasMore).toBe(false)
    expect(last.status === "available" && last.truncation.nextCursor).toBeUndefined()
  })

  test("defaults to twenty records and refuses more than a hundred", async () => {
    const index = await manyFailures()
    const defaulted = inspect(index, {})
    expect(defaulted.status === "available" && recordsOf(defaulted.data)).toHaveLength(20)
    expect(inspect(index, { limit: INSPECTION_PAGE_MAX + 1 })).toMatchObject({ status: "invalid" })
    expect(inspect(index, { limit: 0 })).toMatchObject({ status: "invalid" })
  })

  test("answers an empty facet authoritatively when the evidence is complete", async () => {
    const { index } = await interpretFixture("passed")
    const response = inspect(index, { facet: "failures" })
    expect(response).toMatchObject({ status: "available", completeness: "complete" })
    expect(response.status === "available" && recordsOf(response.data)).toEqual([])
  })

  test("reports an incomplete facet as incomplete, so an empty page proves nothing", async () => {
    const { index } = await interpretFixture("missing-status", {
      request: { execution: FAILED_EXIT },
    })
    expect(inspect(index, { facet: "tests" })).toMatchObject({ status: "incomplete" })
  })

  test("reports a facet that was never produced as unsupported", async () => {
    const { index } = await interpretFixture("build-failed", {
      request: { execution: FAILED_EXIT },
    })
    expect(inspect(index, { facet: "tests" })).toMatchObject({ status: "unsupported" })
  })

  test("never serves log content from the index", async () => {
    // The log lives on disk under the retention contract. Index paging is by
    // record position and the log is read by byte range: a caller that reached
    // here asked the wrong question, and is told so rather than handed a page.
    const index = await manyFailures()
    expect(inspect(index, { facet: "log" })).toMatchObject({ status: "invalid" })
  })
})

describe("focused records", () => {
  test("resolve a diagnostic by id, as the expanded view rather than the page record", async () => {
    const index = await manyFailures()
    const summary = index.testFailures[3]
    const response = inspect(index, { diagnosticId: summary?.id ?? "" })

    // The point of focusing is to see past the caps a page applies, so the
    // answer is a different shape, not a one-record page.
    if (response.status !== "incomplete") throw new Error("expected an incomplete Focused Detail")
    expect(response.data).toMatchObject({
      facet: "failures",
      focused: { id: summary?.id, kind: "testFailure", message: summary?.message },
    })
    expect("records" in (response.data ?? {})).toBe(false)
  })

  test("carry the identity the diagnostic belongs to", async () => {
    const index = await manyFailures()
    const summary = index.testFailures[3]
    const response = inspect(index, { diagnosticId: summary?.id ?? "" })

    if (response.status !== "incomplete") throw new Error("expected an incomplete Focused Detail")
    const focused = (response.data as { focused: { identity?: { canonical: string } } }).focused
    expect(focused.identity?.canonical).toBe(
      index.occurrences.find((o) => o.id === summary?.testId)?.identity.canonical,
    )
  })

  test("resolve a test by id, with every attempt it made", async () => {
    const index = await manyFailures()
    const occurrence = index.occurrences[0]
    const response = inspect(index, { facet: "tests", testId: occurrence?.id ?? "" })

    // `incomplete` without a lazy read: the attempts and diagnostics come
    // from the index and are here, but the activity hierarchy is
    // bundle-backed, so an empty one means nobody looked.
    if (response.status !== "incomplete") throw new Error("expected a Focused Detail")
    expect(response.data).toMatchObject({
      facet: "tests",
      focused: { id: occurrence?.id, status: occurrence?.status, activities: [] },
    })
    // The diagnostics this test produced travel with it, so a caller need not
    // page the whole failures facet looking for them.
    const focused = (response.data as { focused: { diagnostics: Array<{ testId?: string }> } }).focused
    expect(focused.diagnostics.every((entry) => entry.testId === occurrence?.id)).toBe(true)
  })

  test("report notFound without revealing which run holds the id", async () => {
    const index = await manyFailures()
    expect(inspect(index, { diagnosticId: "nope" })).toEqual({
      status: "notFound",
      subject: "diagnostic",
    })
    expect(inspect(index, { facet: "tests", testId: "nope" })).toEqual({
      status: "notFound",
      subject: "test",
    })
  })

  test("reject being combined with a cursor", async () => {
    const index = await manyFailures()
    const first = inspect(index, { limit: 10 })
    const cursor = first.status === "available" ? (first.truncation.nextCursor ?? "") : ""
    expect(inspect(index, { cursor, diagnosticId: "x" })).toMatchObject({ status: "invalid" })
  })
})

describe("cursors", () => {
  test("round-trip under the issuing secret", () => {
    const payload = {
      runId: "run-0000",
      facet: "failures" as const,
      orderingVersion: CURSOR_ORDERING_VERSION,
      position: 40,
    }
    expect(decodeCursor(SECRET, encodeCursor(SECRET, payload))).toEqual({ ok: true, payload })
  })

  test("are deterministic, so recovery re-derives the same token", () => {
    const payload = {
      runId: "run-0000",
      facet: "tests" as const,
      orderingVersion: CURSOR_ORDERING_VERSION,
      position: 20,
    }
    expect(encodeCursor(SECRET, payload)).toBe(encodeCursor(SECRET, payload))
  })

  test("disclose nothing about the run or the position", () => {
    const token = encodeCursor(SECRET, {
      runId: "run-0000",
      facet: "failures",
      orderingVersion: CURSOR_ORDERING_VERSION,
      position: 40,
    })
    expect(token).not.toContain("run-0000")
    expect(token).not.toContain("failures")
  })

  test("fail authentication under a different secret", () => {
    const token = encodeCursor(SECRET, {
      runId: "run-0000",
      facet: "failures",
      orderingVersion: CURSOR_ORDERING_VERSION,
      position: 1,
    })
    expect(decodeCursor(randomBytes(32), token)).toEqual({ ok: false, reason: "invalid" })
  })

  test("are invalid against another run or another facet", async () => {
    const index = await manyFailures()
    const otherRun = encodeCursor(SECRET, {
      runId: "run-9999",
      facet: "failures",
      orderingVersion: CURSOR_ORDERING_VERSION,
      position: 1,
    })
    const otherFacet = encodeCursor(SECRET, {
      runId: index.runId,
      facet: "tests",
      orderingVersion: CURSOR_ORDERING_VERSION,
      position: 1,
    })
    expect(inspect(index, { cursor: otherRun })).toMatchObject({ status: "invalid" })
    expect(inspect(index, { cursor: otherFacet })).toMatchObject({ status: "invalid" })
  })

  test("are invalid under an unsupported ordering version", async () => {
    const index = await manyFailures()
    const stale = encodeCursor(SECRET, {
      runId: index.runId,
      facet: "failures",
      orderingVersion: CURSOR_ORDERING_VERSION + 1,
      position: 1,
    })
    expect(inspect(index, { cursor: stale })).toMatchObject({ status: "invalid" })
  })

  test("reject a garbage token rather than silently restarting the page", async () => {
    const index = await manyFailures()
    expect(inspect(index, { cursor: "not-a-cursor" })).toMatchObject({ status: "invalid" })
  })
})

describe("an inspection for another run", () => {
  test("is notFound, not an empty page", async () => {
    const index = await manyFailures()
    expect(
      inspectIndex(index, { runId: "run-9999", facet: "failures" }, SECRET, CONTAINMENT_ROOT),
    ).toEqual({ status: "notFound", subject: "run" })
  })
})
