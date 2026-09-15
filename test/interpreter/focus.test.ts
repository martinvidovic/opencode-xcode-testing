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
  STACK_FRAME_TEXT_CHAR_CAP,
} from "../../src/domain/limits.ts"
import type { ActivityNode, DiagnosticSummary } from "../../src/domain/inspection.ts"
import { extractFrames } from "../../src/interpreter/frames.ts"
import { focusedDiagnostic, type LazyDetail } from "../../src/interpreter/focus.ts"
import { type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { syntheticIndex } from "./harness.ts"

const ROOT = "/workspace/example"

const DIAGNOSTIC: DiagnosticSummary = {
  id: "diag-1",
  kind: "testFailure",
  message: "XCTAssertEqual failed",
  inspectionAvailable: true,
}

function indexWith(fullMessage: string): NormalizedIndex {
  return syntheticIndex({ testFailures: [DIAGNOSTIC], fullMessages: { "diag-1": fullMessage } })
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

  test("reports which kind of truncation it actually did", () => {
    // Saying a collection was cut when a string was shortened is not a smaller
    // inaccuracy than saying nothing: a caller deciding whether to ask again
    // reads one, and a caller deciding whether the record is faithful reads
    // the other.
    const { truncation } = focus("x".repeat(FOCUSED_MESSAGE_CHAR_CAP), oversized)

    expect(truncation.responseTruncated).toBe(true)
    expect(truncation.collectionTruncated).toBe(true)

    // Nothing was shed here, and the message did not have to shrink, so
    // neither fact may be claimed.
    const modest = focus("short message", { activities: [], attachments: [] })
    expect(modest.truncation.fieldTruncated).toBe(false)
    expect(modest.truncation.responseTruncated).toBe(false)
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

describe("a stack frame whose path is longer than the display budget", () => {
  /** A trace whose one source frame names a pathologically deep file. */
  function traceWithPath(path: string): string {
    return ["XCTAssertEqual failed", `    at ${path}:42:9`].join("\n")
  }

  // Inside the trusted root, because a path outside it is reduced to its
  // basename before this rule is ever reached — the long ones that survive
  // are repository paths, which is exactly the case that matters.
  const ENORMOUS = `${ROOT}/Sources/${"Nested/".repeat(400)}Login.swift`

  test("is dropped rather than cut into a different file", () => {
    // A path cut to a length names nothing. The reader who follows it learns
    // only that this tool is wrong about where things are — and unlike a
    // missing frame, they have no way to tell that is what happened.
    //
    // The whole frame goes, not just its location. A source-line frame is
    // *only* a location, so stripping one leaves an object with no fields —
    // a slot in a bounded collection and bytes in a bounded response, saying
    // nothing.
    const view = focusedDiagnostic(indexWith(traceWithPath(ENORMOUS)), DIAGNOSTIC, ROOT, undefined)

    expect(view.focused?.stackFrames).toEqual([])
  })

  test("says a collection was cut, which is exactly what happened", () => {
    // The flag has to match the loss. A frame removed is a collection that
    // lost an element; reporting a field truncation would be describing a
    // different event, and this contract has a word for each.
    const view = focusedDiagnostic(indexWith(traceWithPath(ENORMOUS)), DIAGNOSTIC, ROOT, undefined)

    expect(view.truncation.collectionTruncated).toBe(true)
    expect(view.truncation.fieldTruncated).toBe(false)
  })

  test("keeps a path that fits exactly as it was recorded", () => {
    // The other direction, so the rule above cannot be satisfied by dropping
    // every location: an ordinary path comes back whole, numbers and all.
    const view = focusedDiagnostic(
      indexWith(traceWithPath(`${ROOT}/Sources/App/Login.swift`)),
      DIAGNOSTIC,
      ROOT,
      undefined,
    )

    expect(view.focused?.stackFrames[0]?.location).toEqual({
      path: "Sources/App/Login.swift",
      line: 42,
      column: 9,
    })
  })

  test("stays within the response cap however many oversized paths there are", () => {
    // Each frame is now either whole or absent, so no number of pathological
    // paths can push a response past the one bound the contract fixes. This
    // measures what the code produced rather than a response shape the test
    // wrote for itself.
    const lines = ["XCTAssertEqual failed"]
    for (let index = 0; index < 50; index += 1) lines.push(`    at ${ENORMOUS}${index}:1`)

    const view = focusedDiagnostic(indexWith(lines.join("\n")), DIAGNOSTIC, ROOT, undefined)

    expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(RESPONSE_BYTE_CAP)
    expect(view.focused?.stackFrames).toEqual([])
    expect(view.truncation.collectionTruncated).toBe(true)
  })

  test("reports a symbol cut to its bound, rather than cutting it quietly", () => {
    // Display text is shortened, which is allowed — and said. A symbol at
    // exactly the cap is not the symbol that was recorded, and a caller
    // comparing it against a build log needs to know that.
    const long = "s".repeat(STACK_FRAME_TEXT_CHAR_CAP * 2)
    const trace = ["XCTAssertEqual failed", `0   AppTests    0x0000000104a2b1c4 ${long} + 132`].join(
      "\n",
    )

    const view = focusedDiagnostic(indexWith(trace), DIAGNOSTIC, ROOT, undefined)

    expect(view.truncation.fieldTruncated).toBe(true)
  })

  test("still returns the symbol and module a frame carries", () => {
    // Those are display text: shortened, they are the same symbol and the
    // same module. Only the path has the property that cutting it changes
    // what it names.
    const long = "s".repeat(STACK_FRAME_TEXT_CHAR_CAP * 2)
    const trace = ["XCTAssertEqual failed", `0   AppTests    0x0000000104a2b1c4 ${long} + 132`].join(
      "\n",
    )

    const view = focusedDiagnostic(indexWith(trace), DIAGNOSTIC, ROOT, undefined)
    const frame = view.focused?.stackFrames[0]

    expect(frame?.module).toBe("AppTests")
    expect(frame?.symbol?.length).toBe(STACK_FRAME_TEXT_CHAR_CAP)
  })
})
