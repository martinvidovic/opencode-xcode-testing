/**
 * Stack frames survive normalization (issue #75).
 *
 * A frame is a line, and `normalizeMessage` collapsed newlines along with
 * every other run of whitespace — rightly, for display and deduplication. The
 * only text Focused Detail had left to read frames out of was that collapsed
 * text, so `extractFrames` recognized nothing, ever, for any real failure.
 *
 * What made it invisible is that it reported honestly. Zero frames because
 * none could be read is a distinct, correct answer, and it is exactly what a
 * caller was told — for the reason that the trace had been destroyed on the
 * way in rather than absent from the bundle.
 *
 * Driven end to end from a committed payload, because the defect lived in the
 * gap between two layers that each tested fine: `focus.test.ts` puts multiline
 * text straight into `fullMessages` and gets frames back, and production never
 * put multiline text there.
 */

import { describe, expect, test } from "bun:test"

import {
  DETAIL_MESSAGE_CHAR_CAP,
  FOCUSED_STACK_FRAME_CAP,
  RESPONSE_BYTE_CAP,
  STACK_FRAME_TEXT_CHAR_CAP,
} from "../../src/domain/limits.ts"
import type { DiagnosticSummary } from "../../src/domain/inspection.ts"
import { buildBuildErrors } from "../../src/interpreter/diagnostics.ts"
import { focusedDiagnostic } from "../../src/interpreter/focus.ts"
import { isNormalizedIndex, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { FAILED_EXIT, TRUSTED_ROOT, interpretFixture, present, syntheticIndex } from "./harness.ts"

/**
 * Interpret the fixture and read it back the way an inspection does.
 *
 * Through JSON, because that is the journey the index actually makes: it is
 * written to disk when the evidence is fresh and read back on every later
 * inspection. A field that only exists in memory is a field Focused Detail
 * never sees.
 */
async function retained(name: string): Promise<NormalizedIndex> {
  const interpreted = await interpretFixture(name, { request: { execution: FAILED_EXIT } })
  const published = JSON.parse(JSON.stringify(interpreted.index)) as unknown

  // The decoder refuses anything it cannot vouch for, and an index carrying a
  // field it does not know about would be refused wholesale.
  expect(isNormalizedIndex(published)).toBe(true)
  return published as NormalizedIndex
}

// Interpreted once, at module scope, as the other fixture-driven files here
// do. Three interpretations would buy isolation the harness already gives.
const MULTILINE = await retained("multiline-diagnostics")

/**
 * The failure the fixture kept lines for.
 *
 * Chosen by that fact rather than by position: the fixture also produces a
 * single-line supplemental failure from the Result Summary, and which of them
 * sorts first is a property of the contract's ordering rather than of this
 * test.
 */
const WITH_LINES = Object.keys(MULTILINE.detailMessages ?? {})
const FAILURE = MULTILINE.testFailures.find((entry) => WITH_LINES.includes(entry.id))
const BUILD_ERROR = MULTILINE.buildErrors[0]

describe("a multiline diagnostic, from payload to Focused Detail", () => {
  test("the fixture produced the two diagnostics everything below is about", () => {
    // Stated rather than assumed. Without it, a fixture that stopped producing
    // a multiline failure would make every test below skip its subject and
    // pass on nothing.
    expect(FAILURE).toBeDefined()
    expect(BUILD_ERROR).toBeDefined()
  })

  test("returns the failure's frames", () => {
    const focused = focusedDiagnostic(MULTILINE, FAILURE as DiagnosticSummary, TRUSTED_ROOT, undefined)

    expect(present(focused).stackFrames).toEqual([
      { symbol: "LoginTests.testRejectsBadPassword()", module: "AppTests" },
      { symbol: "XCTestCase.invokeTest()", module: "XCTestCore" },
      // Absolute in the payload, as XCTest emits it, and reduced here to a
      // path inside the trusted root — the safe-location rule doing its job on
      // a frame rather than on a summary location.
      { location: { path: "Sources/App/Login.swift", line: 42, column: 9 } },
      // Absolute and *outside* the trusted root. Reduced to a bare basename,
      // because a frame must never tell a model where someone else's code
      // lives. This is the case the rule exists for.
      { location: { path: "Secret.swift", line: 7, column: 1 } },
    ])
  })

  test("returns the build error's frames, which nothing else could recover", () => {
    // A build error has no occurrence at all, which is why its message is kept
    // in the index rather than recovered later — and why its frames would have
    // been unrecoverable by any other route.
    const focused = focusedDiagnostic(
      MULTILINE,
      BUILD_ERROR as DiagnosticSummary,
      TRUSTED_ROOT,
      undefined,
    )

    expect(present(focused).stackFrames).toEqual([
      { symbol: "Driver.run()", module: "SwiftDriver" },
      // Repository-relative in the payload, so containment cannot be shown
      // lexically and it reduces to a bare basename too. Lossy, and the safe
      // answer: `safeDisplayPath` will not display a path it cannot place.
      { location: { path: "Login.swift", line: 17, column: 5 } },
    ])
  })

  test("shows a message with its whitespace still collapsed", () => {
    // The summary's contract is unchanged. What is kept for frames is private
    // and never displayed, so nothing a caller reads gained a newline.
    const focused = focusedDiagnostic(MULTILINE, FAILURE as DiagnosticSummary, TRUSTED_ROOT, undefined)

    expect((FAILURE as DiagnosticSummary).message).not.toContain("\n")
    expect(present(focused).message).not.toContain("\n")
  })

  test("exposes no raw address, and no path it could not place", () => {
    // The guarantees frames already had, now that there are frames to have
    // them. An address is what #7 forbids exposing.
    const focused = focusedDiagnostic(MULTILINE, FAILURE as DiagnosticSummary, TRUSTED_ROOT, undefined)

    expect(JSON.stringify(present(focused).stackFrames)).not.toContain("0x")
    for (const frame of present(focused).stackFrames) {
      expect(frame.location?.path.startsWith("/")).not.toBe(true)
    }
  })
})

describe("a single-line failure", () => {
  test("invents no trace, and does not claim one was withheld", async () => {
    // End to end, through ingestion, retained indexing, decoding and Focused
    // Detail (issue #99). A plain assertion failure carries no trace because
    // there was none to carry: prose that happens to contain a symbol-like
    // word is not a frame, and an empty stack here is the complete answer
    // rather than a collection somebody could not fill.
    const index = await retained("test-failed")
    const diagnostic = index.testFailures[0]
    if (diagnostic === undefined) throw new Error("the fixture produced no test failure")

    const focused = focusedDiagnostic(index, diagnostic, TRUSTED_ROOT, undefined)

    expect(present(focused).stackFrames).toEqual([])
    expect(focused.truncation.collectionTruncated).toBe(false)
  })

  test("is not carried twice in the index", async () => {
    // Most failures are one line, and an index that stored a second identical
    // copy of every one of them would be read back from disk on every
    // inspection for nothing.
    const interpreted = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })

    expect(interpreted.index.detailMessages).toEqual({})
  })
})

describe("a trace larger than a response can carry", () => {
  const DIAGNOSTIC: DiagnosticSummary = {
    id: "diag-1",
    kind: "testFailure",
    message: "XCTAssertEqual failed",
    inspectionAvailable: true,
  }

  /** An index whose one diagnostic has `count` frames, each `width` wide. */
  function indexWith(count: number, width: number): NormalizedIndex {
    const frames = Array.from(
      { length: count },
      (_, ordinal) => `  ${ordinal}  AppTests 0x0000000104a2b1c4 ${"s".repeat(width)}() + 4`,
    )

    return syntheticIndex({
      testFailures: [DIAGNOSTIC],
      fullMessages: { "diag-1": "XCTAssertEqual failed" },
      detailMessages: { "diag-1": ["XCTAssertEqual failed", ...frames].join("\n") },
    })
  }

  test("is cut to the frame cap, and says it was", () => {
    // Worth pinning now rather than before: until this change every focused
    // response had zero frames, so no cap on them could ever have bitten.
    const focused = focusedDiagnostic(
      indexWith(FOCUSED_STACK_FRAME_CAP * 4, 20),
      DIAGNOSTIC,
      TRUSTED_ROOT,
      undefined,
    )

    expect(present(focused).stackFrames).toHaveLength(FOCUSED_STACK_FRAME_CAP)
    expect(focused.truncation.collectionTruncated).toBe(true)
  })

  test("stays inside the response byte cap however wide its symbols are", () => {
    const focused = focusedDiagnostic(
      indexWith(FOCUSED_STACK_FRAME_CAP, STACK_FRAME_TEXT_CHAR_CAP + 200),
      DIAGNOSTIC,
      TRUSTED_ROOT,
      undefined,
    )

    expect(Buffer.byteLength(JSON.stringify(focused.focused), "utf8"))
      .toBeLessThanOrEqual(RESPONSE_BYTE_CAP)
    expect(focused.truncation.responseTruncated).toBe(true)
  })
})

describe("what the index keeps", () => {
  test("is cut to the most the frame caps could ever read", () => {
    // The index is read whole on every inspection, and this field is the one
    // thing in it that grows with how verbose a failure was. Its bound is
    // derived from what can be read out of it rather than chosen: past
    // `FOCUSED_STACK_FRAME_CAP` frames of `STACK_FRAME_TEXT_CHAR_CAP` each,
    // no further text can reach a caller under any response.
    const line = `  0  AppTests 0x0000000104a2b1c4 ${"s".repeat(200)}() + 4`
    const enormous = Array.from({ length: 2_000 }, () => line).join("\n")
    expect(enormous.length).toBeGreaterThan(DETAIL_MESSAGE_CHAR_CAP)

    const { detailMessages } = buildBuildErrors(
      [{ targetName: "App", message: enormous }],
      { runId: "run-1", trustedRoot: TRUSTED_ROOT },
    )

    const kept = Object.values(detailMessages)[0]
    expect(kept?.length).toBe(DETAIL_MESSAGE_CHAR_CAP)
  })
})

describe("what the text says about its own frames", () => {
  /**
   * Three answers, not two (issue #99).
   *
   * Reading them as two described the commonest failure there is — a plain
   * assertion with no trace — as a collection somebody could not fill, which
   * sent a caller looking for evidence nobody had ever withheld.
   *
   * Driven through `buildBuildErrors` as well as through a test failure,
   * because AC5 asks for one deterministic rule and a rule that behaved
   * differently for the two would not be one.
   */
  function buildErrorFocus(message: string): ReturnType<typeof focusedDiagnostic> {
    const { diagnostics, detailMessages } = buildBuildErrors(
      [{ targetName: "App", message }],
      { runId: "run-1", trustedRoot: TRUSTED_ROOT },
    )
    const diagnostic = diagnostics[0]
    if (diagnostic === undefined) throw new Error("no build error was built")

    const index = syntheticIndex({ buildErrors: [diagnostic], detailMessages })
    return focusedDiagnostic(index, diagnostic, TRUSTED_ROOT, undefined)
  }

  /** A diagnostic of this file's own, since the one above is scoped elsewhere. */
  const SUBJECT: DiagnosticSummary = {
    id: "diag-frames",
    kind: "testFailure",
    message: "XCTAssertEqual failed",
    inspectionAvailable: true,
  }

  const TRACE = [
    "0   App   0x0000000104a2b1c4 App.configure() + 132",
    "1   App   0x0000000104a2b200 App.main() + 44",
  ]

  test("a build error with no trace has a complete, empty stack", () => {
    const focused = buildErrorFocus("cannot find 'foo' in scope")

    expect(present(focused).stackFrames).toEqual([])
    expect(focused.truncation.collectionTruncated).toBe(false)
  })

  test("a build error with a trace keeps its frames and its locations", () => {
    const focused = buildErrorFocus(["cannot find 'foo' in scope", ...TRACE].join("\n"))

    expect(present(focused).stackFrames).toHaveLength(2)
    expect(focused.truncation.collectionTruncated).toBe(false)
  })

  test("a build error whose trace is cut off says so, and invents nothing", () => {
    const focused = buildErrorFocus(
      ["cannot find 'foo' in scope", TRACE[0]!, "2   App   0x0000000104a2b2f0"].join("\n"),
    )

    expect(present(focused).stackFrames).toHaveLength(1)
    expect(focused.truncation.collectionTruncated).toBe(true)
  })

  test("is decided by the text, so the two kinds of diagnostic agree", () => {
    // The determinism AC5 asks for, over all three answers rather than over
    // the empty one: comparing two `false`s would pass against a rule that had
    // not changed at all.
    const cases = [
      { what: "no trace", message: "cannot find 'foo' in scope", truncated: false },
      { what: "a whole trace", message: ["failed", ...TRACE].join("\n"), truncated: false },
      {
        what: "a trace cut off",
        message: ["failed", TRACE[0]!, "2   App   0x0000000104a2b2f0"].join("\n"),
        truncated: true,
      },
    ]

    for (const { what, message, truncated } of cases) {
      const asBuildError = buildErrorFocus(message)
      const asFailure = focusedDiagnostic(
        syntheticIndex({ testFailures: [SUBJECT], detailMessages: { [SUBJECT.id]: message } }),
        SUBJECT,
        TRUSTED_ROOT,
        undefined,
      )

      expect({ what, value: asBuildError.truncation.collectionTruncated }).toEqual({ what, value: truncated })
      expect({ what, value: asFailure.truncation.collectionTruncated }).toEqual({ what, value: truncated })
    }
  })

  test("calls an unsymbolicated frame a trace it could not read", () => {
    // `???` for a module is ordinary in a real backtrace — a frame outside any
    // image this run can name. It is a frame that was there and could not be
    // read, which is what `partial` says, and inventing one to stand in for it
    // is the thing #8 forbids.
    const focused = buildErrorFocus(["failed", "3   ???   0x00000001045a1000"].join("\n"))

    expect(present(focused).stackFrames).toEqual([])
    expect(focused.truncation.collectionTruncated).toBe(true)
  })

  test("does not call a compiler diagnostic a cut-off source line", () => {
    // `at <file>:<line>` is also how `xcodebuild` writes an ordinary error,
    // and nothing in the text tells a truncated source frame from a sentence
    // that begins the same way. Counting those as frame-shaped would put
    // `partial` on complete build errors — this defect, moved from assertions
    // to compiler output.
    for (const message of [
      "at Sources/App/Login.swift:42: error: cannot find 'foo' in scope",
      "at Sources/App/Login.swift:42 (in LoginTests)",
      "  at 10:30 the run began",
    ]) {
      expect(buildErrorFocus(message).truncation.collectionTruncated).toBe(false)
    }
  })

  test("reads a single-line failure as having had no trace, not a lost one", () => {
    // The fallback path. `detailMessages` carries a message only when it had
    // newlines, so no entry means the original was one line — and one line
    // cannot have held a backtrace. An empty stack is the complete answer.
    const focused = focusedDiagnostic(
      syntheticIndex({ testFailures: [SUBJECT], detailMessages: {} }),
      SUBJECT,
      TRUSTED_ROOT,
      undefined,
    )

    expect(present(focused).stackFrames).toEqual([])
    expect(focused.truncation.collectionTruncated).toBe(false)
  })

  test("reports its caps accurately either way", async () => {
    // An empty complete stack must not make the rest of the truncation
    // metadata lie in the other direction.
    const index = await retained("test-failed")
    const diagnostic = index.testFailures[0]
    if (diagnostic === undefined) throw new Error("the fixture produced no test failure")

    const focused = focusedDiagnostic(index, diagnostic, TRUSTED_ROOT, undefined)
    expect(focused.truncation.fieldTruncated).toBe(false)
    expect(focused.truncation.responseTruncated).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(focused.focused), "utf8")).toBeLessThanOrEqual(
      RESPONSE_BYTE_CAP,
    )
  })
})
