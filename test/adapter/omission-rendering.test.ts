/**
 * What a model is told when a record will not fit (issue #126).
 *
 * Two different things arrive as `incomplete` and mean opposite things to the
 * caller. A paged read has moved past a record that was too large: asking
 * again gets the next page, and that record is gone. A Focused Detail read has
 * a record it can see and cannot send — the detail exists, and no amount of
 * asking differently will produce it.
 *
 * The second answer is only useful if it says *what* would have had to be cut.
 * "It does not fit" is equally true of a two-hundred-kilobyte test name and a
 * path with twenty thousand directories in it, and those are different things
 * to go and look at — one is a test named by something generated, the other is
 * a build laying files somewhere pathological.
 *
 * The responses here are built by the paging code itself and rendered by the
 * adapter's own renderer, so what is asserted is what a caller would receive.
 * The sentences, though, are written out in full: they are the contract this
 * issue is about, and a test that derived them from the code it is checking
 * would agree with any wording at all — including none.
 */

import { describe, expect, test } from "bun:test"

import type { InspectionResponse } from "../../src/domain/inspection.ts"
import { renderInspection } from "../../src/adapter/tools.ts"
import { blockingFields } from "../../src/interpreter/cap.ts"
import { BLOCKED_FIELD_CAP, omittedResponse } from "../../src/interpreter/paging.ts"
import { RESPONSE_BYTE_CAP, RESPONSE_ENVELOPE_BYTES } from "../../src/domain/limits.ts"

const REQUEST = { runId: "a".repeat(32), facet: "failures" as const }

const UNTRUNCATED = {
  fieldTruncated: false,
  collectionTruncated: false,
  responseTruncated: false,
  hasMore: false,
}

/** What the model sees, as one string. */
function rendered(response: InspectionResponse<unknown>): string {
  return renderInspection(REQUEST, response)
    .map((entry) => entry.lines.join("\n"))
    .join("\n")
}

/**
 * The response the paging code itself builds for these blocked fields.
 *
 * Built by the production function rather than assembled here. A test that
 * hand-writes the envelope asserts that the renderer handles the envelope the
 * test imagines, and stays green on the day the real one changes shape.
 */
function omitted(blockedBy: string[]): InspectionResponse<unknown> {
  return omittedResponse(
    "failures",
    { ...UNTRUNCATED, responseTruncated: true, recordsOmitted: 1 },
    blockedBy,
  ) as InspectionResponse<unknown>
}

describe("a focused detail that cannot be sent", () => {
  test("names the fields that would have had to be shortened", () => {
    // The names are the whole of what makes this answer actionable. Without
    // them a caller knows only that something was too big, which is the one
    // thing they could already tell from the status.
    const text = rendered(omitted(["identity.canonical", "testId"]))

    expect(text).toContain("identity.canonical")
    expect(text).toContain("testId")
  })

  test("never includes what those fields contained", () => {
    // Driven from a record that is genuinely oversized, so the fields named
    // are the ones the real analysis picks — and the value that made it
    // oversized is a real value, present to be leaked. Quoting it to explain
    // why it could not be sent would send it, breaking the cap with the
    // sentence about the cap.
    const enormous = "Z".repeat(RESPONSE_BYTE_CAP)
    const record = { id: "d1", kind: "testFailure", identity: { canonical: enormous } }
    const blockedBy = blockingFields(record, RESPONSE_BYTE_CAP - RESPONSE_ENVELOPE_BYTES)

    expect(blockedBy).toContain("identity.canonical")

    const text = rendered(omitted(blockedBy))

    expect(text).not.toContain(enormous.slice(0, 200))
    expect(text.length).toBeLessThan(RESPONSE_BYTE_CAP)
  })
})

describe("the kind of field that blocked it", () => {
  test("an oversized identifier is described as one", () => {
    const text = rendered(omitted(["identity.canonical"]))

    expect(text).toContain("a shortened identifier addresses nothing")
    expect(text).not.toContain("names a file that does not exist")
  })

  test("an oversized safe location is described as one", () => {
    // The different failure: half a path is somewhere, and a reader who
    // follows it learns only that this tool is wrong about where things are.
    const text = rendered(omitted(["location.path"]))

    expect(text).toContain("names a file that does not exist")
    expect(text).not.toContain("a shortened identifier addresses nothing,")
  })

  test("both, when both are implicated", () => {
    const fields = ["identity.canonical", "location.path"]

    const text = rendered(omitted(fields))

    expect(text).toContain("a shortened identifier addresses nothing")
    expect(text).toContain("names a file that does not exist")
  })
})

describe("a long list of blocked fields", () => {
  test("is bounded, and says how many it did not name", () => {
    const fields = Array.from({ length: BLOCKED_FIELD_CAP + 3 }, (_, index) => `field${index}`)

    const text = rendered(omitted(fields))

    expect(text).toContain("and 3 more")
    expect(text).not.toContain(`field${BLOCKED_FIELD_CAP + 2}`)
  })
})

describe("a paged omission", () => {
  test("stays a different answer, and promises no later page", () => {
    // The cursor has already moved past the record. A sentence that invited a
    // retry would send a caller round a loop that cannot produce it.
    const text = rendered({
      status: "available",
      completeness: "complete",
      data: { view: "records", facet: "failures", records: [] },
      truncation: { ...UNTRUNCATED, responseTruncated: true, recordsOmitted: 2 },
    } as unknown as InspectionResponse<unknown>)

    expect(text).toContain("2 record(s) too large to return")
    expect(text).not.toContain("withheld")
    expect(text).not.toMatch(/try again|later page|retry/i)
  })
})
