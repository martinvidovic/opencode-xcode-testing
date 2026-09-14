/**
 * Focused detail, its caps, and what it says about them (#7, #8, issue #24).
 *
 * The subject here is not "does the detail come back" but "does the response
 * tell the truth about what it had to leave out". A silently shortened message
 * is indistinguishable from a short one, and an empty stack that nobody could
 * read is indistinguishable from a failure that had none — in both cases a
 * caller draws a conclusion the evidence does not support.
 */

import { describe, expect, test } from "bun:test"

import {
  ATTACHMENT_METADATA_CAP,
  FOCUSED_ACTIVITY_DEPTH_CAP,
  FOCUSED_ACTIVITY_NODE_CAP,
  FOCUSED_MESSAGE_CHAR_CAP,
  RESPONSE_BYTE_CAP,
} from "../../src/domain/limits.ts"
import type { ActivityNode, DiagnosticSummary } from "../../src/domain/inspection.ts"
import { extractFrames } from "../../src/interpreter/frames.ts"
import { focusedDiagnostic, type LazyDetail } from "../../src/interpreter/focus.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../../src/interpreter/index-model.ts"

const ROOT = "/workspace/example"

const DIAGNOSTIC: DiagnosticSummary = {
  id: "diag-1",
  kind: "testFailure",
  message: "XCTAssertEqual failed",
  inspectionAvailable: true,
}

function indexWith(fullMessage: string): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId: "run-1",
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [],
    testFailures: [DIAGNOSTIC],
    buildErrors: [],
    attestations: [],
    scopeVerdict: "unverifiable",
    scopeDigest: "d",
    requestedSelectionCount: 0,
    observedOutsideScope: 0,
    build: { completeness: "complete" },
    tests: { completeness: "complete" },
    diagnostics: { completeness: "complete" },
    fullMessages: { "diag-1": fullMessage },
    toolchain: {
      developerDirectory: "/x",
      xcodeVersion: "26.4.1",
      xcodeBuild: "17E202",
      xcresulttoolPath: "/x/t",
      xcresulttoolVersion: "24757",
      xcresulttoolDigest: "digest",
      schemaVersion: "0.1.0",
    },
    log: { availability: "unavailable", retainedBytesExact: false },
    bundleDigestVerified: "yes",
  }
}

const TRACE = [
  "XCTAssertEqual failed",
  "0   AppTests    0x0000000104a2b1c4 LoginTests.testSignsIn() + 132",
  "1   XCTest      0x00000001049f0000 XCTestCase.invokeTest() + 44",
].join("\n")

function focus(fullMessage: string, lazy?: LazyDetail) {
  return focusedDiagnostic(indexWith(fullMessage), DIAGNOSTIC, ROOT, lazy)
}

describe("the full message", () => {
  test("is the one the index retained, not the summary's capped copy", () => {
    const full = `XCTAssertEqual failed${" with a great deal more to say".repeat(50)}`
    expect(focus(full).focused.message).toBe(full)
    expect(focus(full).truncation.fieldTruncated).toBe(false)
  })

  test("says so when it had to be cut", () => {
    const { focused, truncation } = focus("x".repeat(FOCUSED_MESSAGE_CHAR_CAP + 1))

    expect(focused.message).toHaveLength(FOCUSED_MESSAGE_CHAR_CAP)
    // Without this a caller cannot tell a shortened message from a short one.
    expect(truncation.fieldTruncated).toBe(true)
  })

  test("keeps its start, never its end", () => {
    const { focused } = focus(`BEGIN ${"x".repeat(FOCUSED_MESSAGE_CHAR_CAP)} END`)
    expect(focused.message.startsWith("BEGIN ")).toBe(true)
    expect(focused.message.endsWith("END")).toBe(false)
  })
})

describe("stack frames", () => {
  test("are read from the failure text where a trace format is recognizable", () => {
    const { focused } = focus(TRACE)
    expect(focused.stackFrames).toEqual([
      { symbol: "LoginTests.testSignsIn()", module: "AppTests" },
      { symbol: "XCTestCase.invokeTest()", module: "XCTest" },
    ])
  })

  test("never carry a raw address", () => {
    const { focused } = focus(TRACE)
    expect(JSON.stringify(focused.stackFrames)).not.toContain("0x")
  })

  test("report a source line relative to the repository", () => {
    const { focused } = focus(`failed\n  at ${ROOT}/Sources/App/Login.swift:42:9`)
    expect(focused.stackFrames).toEqual([
      { location: { path: "Sources/App/Login.swift", line: 42, column: 9 } },
    ])
  })

  test("are absent, and said to be absent, when no trace is recognizable", () => {
    const { focused, truncation } = focus("XCTAssertEqual failed: no trace here at all")

    // "There were none" and "none could be read" are different facts, and #8
    // requires the second to be reported rather than presented as the first.
    expect(focused.stackFrames).toEqual([])
    expect(truncation.collectionTruncated).toBe(true)
  })

  test("are never synthesized from the diagnostic's own location", () => {
    const located = focusedDiagnostic(
      indexWith("no trace"),
      { ...DIAGNOSTIC, location: { path: "Sources/App/Login.swift", line: 42 } },
      ROOT,
      undefined,
    )
    // A frame claims the failure passed through somewhere. A location alone
    // does not support that claim, whatever else it is good for.
    expect(located.focused.stackFrames).toEqual([])
    expect(located.focused.location).toEqual({ path: "Sources/App/Login.swift", line: 42 })
  })

  test("read nothing out of ordinary prose that merely mentions a symbol", () => {
    expect(extractFrames("expected LoginTests.testSignsIn() to pass", ROOT).recognized).toBe(false)
  })
})

describe("the activity hierarchy", () => {
  function chain(depth: number): ActivityNode[] {
    return depth === 0 ? [] : [{ title: `level ${depth}`, children: chain(depth - 1) }]
  }

  function deepest(nodes: ActivityNode[]): number {
    return nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((node) => deepest(node.children)))
  }

  test("is bounded by depth and by total nodes, and neither implies the other", () => {
    const deep = focus("failed", {
      activities: chain(FOCUSED_ACTIVITY_DEPTH_CAP + 10),
      attachments: [],
    })
    expect(deepest(deep.focused.activities)).toBe(FOCUSED_ACTIVITY_DEPTH_CAP)
    expect(deep.truncation.collectionTruncated).toBe(true)

    const wide = focus("failed", {
      activities: Array.from({ length: FOCUSED_ACTIVITY_NODE_CAP + 10 }, (_, n) => ({
        title: `activity ${n}`,
        children: [],
      })),
      attachments: [],
    })
    expect(wide.focused.activities).toHaveLength(FOCUSED_ACTIVITY_NODE_CAP)
    expect(wide.truncation.collectionTruncated).toBe(true)
  })

  test("keeps parents before children when it has to cut", () => {
    const { focused } = focus("failed", {
      activities: [{ title: "parent", children: chain(FOCUSED_ACTIVITY_NODE_CAP + 5) }],
      attachments: [],
    })
    expect(focused.activities[0]?.title).toBe("parent")
  })
})

describe("attachments", () => {
  test("are metadata only, and say so", () => {
    const { focused } = focus("failed", {
      activities: [],
      attachments: [{ name: "screenshot.png", mediaType: "public.png", byteSize: 1, contentAccessible: false }],
    })
    expect(focused.attachments[0]).toEqual({
      name: "screenshot.png",
      mediaType: "public.png",
      byteSize: 1,
      contentAccessible: false,
    })
  })

  test("are bounded, and report being bounded", () => {
    const many = Array.from({ length: ATTACHMENT_METADATA_CAP + 5 }, (_, n) => ({
      name: `file-${n}`,
      contentAccessible: false as const,
    }))
    const { focused, truncation } = focus("failed", { activities: [], attachments: many })

    expect(focused.attachments).toHaveLength(ATTACHMENT_METADATA_CAP)
    expect(truncation.collectionTruncated).toBe(true)
  })
})

describe("the response cap", () => {
  /** Every collection at its own cap, which together far exceed the response cap. */
  const oversized: LazyDetail = {
    activities: Array.from({ length: FOCUSED_ACTIVITY_NODE_CAP }, (_, n) => ({
      title: `activity ${n} ${"x".repeat(2_000)}`,
      children: [],
    })),
    attachments: Array.from({ length: ATTACHMENT_METADATA_CAP }, (_, n) => ({
      name: `attachment ${n} ${"x".repeat(500)}`,
      contentAccessible: false as const,
    })),
  }

  test("holds even when every collection is individually within its own cap", () => {
    const { focused, truncation } = focus("x".repeat(FOCUSED_MESSAGE_CHAR_CAP), oversized)

    expect(Buffer.byteLength(JSON.stringify(focused), "utf8")).toBeLessThanOrEqual(RESPONSE_BYTE_CAP)
    expect(truncation.responseTruncated).toBe(true)
  })

  test("sheds in reverse priority, so identity and message outlive attachments", () => {
    const { focused } = focus("x".repeat(FOCUSED_MESSAGE_CHAR_CAP), oversized)

    // #7 fixes the order: envelope and identity, then the message, then
    // frames, then activities, then attachments. Attachments go first.
    expect(focused.attachments.length).toBeLessThan(oversized.attachments.length)
    expect(focused.id).toBe("diag-1")
    expect(focused.message.length).toBeGreaterThan(0)
  })
})
