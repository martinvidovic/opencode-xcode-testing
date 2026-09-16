/**
 * The output budget invariant (ADR 0002).
 *
 * Host truncation must be unreachable. When the host truncates it replaces the
 * output with a pointer to a truncation directory, and the model has no file
 * access — so that pointer is strictly worse than a shorter answer. These tests
 * pin the arithmetic that keeps us clear of it, and prove the last-resort path
 * still produces something a caller can act on.
 */

import { describe, expect, test } from "bun:test"

import {
  DEFAULT_BUDGET,
  HOST_DEFAULT_MAX_BYTES,
  HOST_DEFAULT_MAX_LINES,
  SAFETY_MARGIN_BYTES,
  SAFETY_MARGIN_LINES,
  SELF_CAP_BYTES,
  SELF_CAP_LINES,
  UNREADABLE_MAX_BYTES,
  UNREADABLE_MAX_LINES,
  byteLength,
  lineCount,
  readOutputLimits,
  resolveBudget,
  serialize,
  truncateToBytes,
} from "../../src/adapter/budget.ts"
import { block, PRIORITY } from "../../src/adapter/document.ts"
import { renderTestToolResult } from "../../src/adapter/output.ts"
import { FAILED_EXIT, interpretFixture } from "../interpreter/harness.ts"

describe("reading the host's limits", () => {
  const clientReturning = (data: unknown) => ({ config: { get: async () => data as never } })

  test("takes the effective limits the host reports", async () => {
    const limits = await readOutputLimits(
      clientReturning({ data: { tool_output: { max_lines: 100, max_bytes: 4_096 } } }),
    )
    expect(limits).toEqual({ status: "configured", maxLines: 100, maxBytes: 4_096 })
  })

  test("tells a host with nothing configured from one that could not be asked", async () => {
    // These were the same answer, and they are not the same situation (issue
    // #82). A host with no `tool_output` block will apply the documented
    // defaults, so assuming them is exactly right. A host that could not be
    // asked has told us nothing — including whether its owner configured
    // something *lower* than the defaults this adapter would then help itself
    // to, which is how the one invariant gets broken.
    expect(await readOutputLimits(clientReturning({ data: {} }))).toEqual({ status: "absent" })

    const throwing = { config: { get: () => Promise.reject(new Error("no config route")) } }
    expect((await readOutputLimits(throwing)).status).toBe("unreadable")
    expect((await readOutputLimits(clientReturning({}))).status).toBe("unreadable")
  })

  test("says a block it cannot read is unreadable, rather than absent", async () => {
    // A `tool_output` that is there and unusable is not a host with nothing
    // configured. Reading it as one would substitute the defaults for a
    // configuration that exists and says something else.
    const cases = [
      { tool_output: "loud" },
      { tool_output: { max_lines: "many" } },
      { tool_output: { max_bytes: -1 } },
      { tool_output: { max_lines: Number.NaN } },
    ]

    for (const config of cases) {
      expect((await readOutputLimits(clientReturning({ data: config }))).status).toBe("unreadable")
    }
  })

  test("says nothing about the machine when it says why", async () => {
    // The detail reaches a startup diagnostic, and a config route's error
    // routinely quotes a path under the user's home.
    const throwing = {
      config: {
        get: () => Promise.reject(new Error("ENOENT: open '/Users/someone/.config/opencode'")),
      },
    }
    const limits = await readOutputLimits(throwing)

    expect(limits.status).toBe("unreadable")
    expect(limits.status === "unreadable" ? limits.detail : "").not.toContain("/Users")
  })
})

describe("a budget built from limits nobody could read", () => {
  test("is smaller than the documented defaults, not equal to them", () => {
    // The defect. A read that failed produced a budget built from 2,000 lines
    // on a machine whose owner may have set 200 — and a response over the
    // host's limit is replaced by a pointer to a directory the model cannot
    // open, which is worse than a short answer.
    const unreadable = resolveBudget({ status: "unreadable", detail: "no route" })
    const absent = resolveBudget({ status: "absent" })

    expect(unreadable.maxLines).toBeLessThan(absent.maxLines)
    expect(unreadable.maxBytes).toBeLessThan(absent.maxBytes)
  })

  test("stays under every lowering anyone is likely to have configured", () => {
    // A policy, not a measurement, and it cannot cover a host set to 10 — no
    // fallback can, which is why ADR 0002 records the guarantee as conditional
    // here and why an unreadable read is announced rather than absorbed.
    const unreadable = resolveBudget({ status: "unreadable", detail: "no route" })

    expect(unreadable.maxLines).toBeLessThanOrEqual(UNREADABLE_MAX_LINES)
    expect(unreadable.maxBytes).toBeLessThanOrEqual(UNREADABLE_MAX_BYTES)
  })
})

describe("resolving the budget", () => {
  test("applies the documented defaults, because the host does not materialize them", () => {
    // An unset `tool_output` block arrives as undefined, not as the defaults.
    expect(resolveBudget({ status: "absent" })).toEqual({
      maxLines: Math.min(SELF_CAP_LINES, HOST_DEFAULT_MAX_LINES - SAFETY_MARGIN_LINES),
      maxBytes: Math.min(SELF_CAP_BYTES, HOST_DEFAULT_MAX_BYTES - SAFETY_MARGIN_BYTES),
    })
  })

  test("takes the host's limit when it is lower than our own cap", () => {
    const budget = resolveBudget({ status: "configured", maxLines: 100, maxBytes: 4_096 })
    expect(budget.maxLines).toBe(100 - SAFETY_MARGIN_LINES)
    expect(budget.maxBytes).toBe(4_096 - SAFETY_MARGIN_BYTES)
  })

  test("never exceeds our own cap, however generous the host is", () => {
    const budget = resolveBudget({ status: "configured", maxLines: 1_000_000, maxBytes: 10_000_000 })
    expect(budget.maxLines).toBe(SELF_CAP_LINES)
    expect(budget.maxBytes).toBe(SELF_CAP_BYTES)
  })

  test("stays clear of the host limit by a margin", () => {
    const budget = resolveBudget({ status: "configured", maxLines: 500, maxBytes: 20_000 })
    expect(budget.maxLines).toBeLessThan(500)
    expect(budget.maxBytes).toBeLessThan(20_000)
  })

  test("degrades to something usable rather than to zero", () => {
    const budget = resolveBudget({ status: "configured", maxLines: 1, maxBytes: 1 })
    expect(budget.maxLines).toBeGreaterThan(0)
    expect(budget.maxBytes).toBeGreaterThan(0)
  })

  test("stays under an absurdly small host limit rather than over it", () => {
    // The whole point of the budget is that host truncation is unreachable.
    // A floor that sat *above* the host's limit would reach it — and the host
    // replaces truncated output with a path the model cannot open.
    for (const bytes of [1, 16, 63, 64, 100]) {
      expect(resolveBudget({ status: "configured", maxBytes: bytes }).maxBytes).toBeLessThanOrEqual(bytes)
    }
    expect(resolveBudget({ status: "configured", maxLines: 1 }).maxLines).toBeLessThanOrEqual(1)
  })
})

describe("an ordinary response", () => {
  test("fits with room to spare and drops nothing", async () => {
    const { summary } = await interpretFixture("test-failed", { request: { execution: FAILED_EXIT } })
    const rendered = renderTestToolResult(summary)

    expect(rendered.droppedBlocks).toBe(0)
    expect(rendered.hardTruncated).toBe(false)
    expect(lineCount(rendered.text)).toBeLessThan(DEFAULT_BUDGET.maxLines)
    expect(byteLength(rendered.text)).toBeLessThan(DEFAULT_BUDGET.maxBytes)
  })
})

describe("a deliberately over-budget payload", () => {
  const oversized = () => [
    block(PRIORITY.envelope, "Test Run passed: 1 test, 0 failed"),
    block(PRIORITY.facts, "tests          1 total, 1 passed (complete)"),
    block(PRIORITY.diagnostics, ...Array.from({ length: 400 }, (_, i) => `failure ${i}`)),
    block(PRIORITY.sample, ...Array.from({ length: 400 }, (_, i) => `observed ${i}`)),
  ]

  test("drops whole low-priority sections rather than shredding every one", () => {
    const result = serialize(oversized(), { maxLines: 20, maxBytes: 64_000 })

    expect(result.hardTruncated).toBe(false)
    expect(result.droppedBlocks).toBeGreaterThan(0)
    // The envelope and the classification facts are what survive.
    expect(result.text).toContain("Test Run passed")
    expect(result.text).toContain("1 total, 1 passed")
    expect(result.text).not.toContain("observed 399")
  })

  test("says how many sections it dropped, so the omission is not silent", () => {
    const result = serialize(oversized(), { maxLines: 20, maxBytes: 64_000 })
    expect(result.text).toMatch(/\[\d+ sections? omitted to stay within the output budget\]/)
  })

  test("stays within both caps whatever it is given", () => {
    for (const budget of [
      { maxLines: 5, maxBytes: 64_000 },
      { maxLines: 2_000, maxBytes: 200 },
      { maxLines: 3, maxBytes: 120 },
    ]) {
      const result = serialize(oversized(), budget)
      expect(lineCount(result.text)).toBeLessThanOrEqual(budget.maxLines)
      expect(byteLength(result.text)).toBeLessThanOrEqual(budget.maxBytes)
    }
  })

  test("never reduces a response to nothing but a note about omissions", () => {
    // The envelope is never dropped: a response that says only "sections were
    // omitted" tells the caller nothing they can act on.
    const result = serialize(oversized(), { maxLines: 2, maxBytes: 200 })
    expect(result.text).toContain("Test Run passed")
  })

  test("cuts the envelope rather than removing it when even that will not fit", () => {
    const result = serialize(oversized(), { maxLines: 1, maxBytes: 64 })
    expect(result.hardTruncated).toBe(true)
    expect(result.text.startsWith("Test Run passed")).toBe(true)
    expect(byteLength(result.text)).toBeLessThanOrEqual(64)
  })

  test("says it was cut whenever there is room to say so", () => {
    const result = serialize(oversized(), { maxLines: 3, maxBytes: 60 })
    expect(result.hardTruncated).toBe(true)
    expect(result.text).toContain("[output truncated to stay within the output budget]")
    expect(byteLength(result.text)).toBeLessThanOrEqual(60)
  })
})

describe("byte truncation", () => {
  test("never splits a multi-byte sequence", () => {
    const text = "ünïcödé".repeat(20)
    for (let limit = 1; limit < 40; limit += 1) {
      const cut = truncateToBytes(text, limit)
      expect(byteLength(cut)).toBeLessThanOrEqual(limit)
      // A split sequence would decode to the replacement character.
      expect(cut).not.toContain("�")
    }
  })

  test("counts bytes, not characters", () => {
    expect(byteLength("é")).toBe(2)
    expect(lineCount("a\nb\n")).toBe(2)
    expect(lineCount("")).toBe(0)
  })
})
