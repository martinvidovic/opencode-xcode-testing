/**
 * Stack frames survive normalization (issue #75).
 *
 * A frame is a line. `normalizeMessage` collapses whitespace — rightly, for
 * display and for deduplication, since two tests that failed the same
 * assertion must dedup whatever the wrapping did to them — and it collapsed
 * newlines along with everything else. The only text Focused Detail had left
 * to read frames out of was that collapsed text, so `extractFrames` recognized
 * nothing, ever, for any real failure.
 *
 * What made it invisible is that it reported honestly. Zero frames because
 * none could be read is a distinct, correct answer — and it is exactly what a
 * caller was told, on every multiline failure, for the reason that the trace
 * had been destroyed on the way in rather than absent from the bundle.
 *
 * Driven end to end from a committed payload, because the defect lived in the
 * gap between two layers that each tested fine. `focus.test.ts` puts multiline
 * text straight into `fullMessages` and gets frames back; production never put
 * multiline text there.
 */

import { describe, expect, test } from "bun:test"

import { focusedDiagnostic } from "../../src/interpreter/focus.ts"
import { isNormalizedIndex, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { FAILED_EXIT, interpretFixture } from "./harness.ts"

const ROOT = "/workspace"

/**
 * The failure the fixture kept lines for.
 *
 * Chosen by that fact rather than by position: the fixture also produces a
 * single-line supplemental failure from the Result Summary, and which of them
 * sorts first is a property of the contract's ordering, not of this test.
 */
function multilineFailure(index: NormalizedIndex) {
  const id = Object.keys(index.detailMessages ?? {})
  const found = index.testFailures.find((entry) => id.includes(entry.id))
  if (found === undefined) throw new Error("the fixture produced no multiline test failure")
  return found
}

/**
 * Interpret the fixture and read it back the way an inspection does.
 *
 * Through JSON, because that is the journey the index actually makes: it is
 * written to disk when the evidence is fresh and read back on every later
 * inspection. A field that only exists in memory is a field Focused Detail
 * never sees.
 */
async function retainedIndex(): Promise<NormalizedIndex> {
  const interpreted = await interpretFixture("multiline-diagnostics", { execution: FAILED_EXIT })
  const published = JSON.parse(JSON.stringify(interpreted.index)) as unknown

  // The decoder refuses anything it cannot vouch for, and an index carrying a
  // field it does not know about would be refused wholesale.
  expect(isNormalizedIndex(published)).toBe(true)
  return published as NormalizedIndex
}

describe("a multiline test failure", () => {
  test("returns its frames through Focused Detail", async () => {
    const index = await retainedIndex()
    const focused = focusedDiagnostic(index, multilineFailure(index), ROOT, undefined)

    expect(focused.focused.stackFrames).toEqual([
      { symbol: "LoginTests.testRejectsBadPassword()", module: "AppTests" },
      { symbol: "XCTestCase.invokeTest()", module: "XCTestCore" },
      // Absolute in the payload, as XCTest emits it, and reduced here to a
      // path inside the trusted root — the safe-location rule doing its job
      // on a frame rather than on a summary location.
      { location: { path: "Sources/App/Login.swift", line: 42, column: 9 } },
    ])
  })

  test("still shows a message with its whitespace collapsed", async () => {
    const index = await retainedIndex()
    const diagnostic = multilineFailure(index)

    // The summary's contract is unchanged. What is kept for frames is private
    // and never displayed, so nothing a caller reads gained a newline.
    expect(diagnostic.message).not.toContain("\n")
    expect(focusedDiagnostic(index, diagnostic, ROOT, undefined).focused.message)
      .not.toContain("\n")
  })

  test("exposes no raw address, and no path outside the trusted root", async () => {
    const index = await retainedIndex()
    const focused = focusedDiagnostic(index, multilineFailure(index), ROOT, undefined)

    // The guarantees frames already had, now that there are frames to have
    // them. An address is what #7 forbids exposing; a path that escaped the
    // trusted root is what `safeDisplayPath` exists to prevent.
    expect(JSON.stringify(focused.focused.stackFrames)).not.toContain("0x")
    for (const frame of focused.focused.stackFrames) {
      expect(frame.location?.path.startsWith("/")).not.toBe(true)
    }
  })
})

describe("a multiline build error", () => {
  test("returns its frames too, having no occurrence to recover them from", async () => {
    // A build error has no occurrence at all, which is why its message is kept
    // in the index rather than recovered later — and why its frames would have
    // been unrecoverable by any other route.
    const index = await retainedIndex()
    const diagnostic = index.buildErrors[0]
    if (diagnostic === undefined) throw new Error("the fixture produced no build error")

    const focused = focusedDiagnostic(index, diagnostic, ROOT, undefined)

    expect(focused.focused.stackFrames).toEqual([
      { symbol: "Driver.run()", module: "SwiftDriver" },
      // Repository-relative in the payload, so containment cannot be shown
      // lexically and it reduces to a bare basename. Lossy, and the safe
      // answer: `safeDisplayPath` will not display a path it cannot place.
      { location: { path: "Login.swift", line: 17, column: 5 } },
    ])
  })
})

describe("a single-line failure", () => {
  test("reports that no trace could be read, rather than inventing one", async () => {
    // Unchanged, and the point of the distinction. "There were none" and "none
    // could be read" are different facts, and prose that happens to contain a
    // symbol-like word is not a frame.
    const interpreted = await interpretFixture("test-failed", { execution: FAILED_EXIT })
    const index = JSON.parse(JSON.stringify(interpreted.index)) as NormalizedIndex
    const diagnostic = index.testFailures[0]
    if (diagnostic === undefined) throw new Error("the fixture produced no test failure")

    const focused = focusedDiagnostic(index, diagnostic, ROOT, undefined)

    expect(focused.focused.stackFrames).toEqual([])
    expect(focused.truncation.collectionTruncated).toBe(true)
  })

  test("is not carried twice in the index", async () => {
    // Most failures are one line, and an index that stored a second identical
    // copy of every one of them would be read back from disk on every
    // inspection for nothing.
    const interpreted = await interpretFixture("test-failed", { execution: FAILED_EXIT })

    expect(interpreted.index.detailMessages).toEqual({})
  })
})
