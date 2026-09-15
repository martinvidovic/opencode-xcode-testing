/**
 * Why a response is incomplete, said out loud (issue #76).
 *
 * The adapter computed a typed cause for every incomplete inspection — an
 * expired lazy deadline, a Result Bundle deleted by retention, one that no
 * longer matches its digest, an association that could not be made or was
 * ambiguous, a record too large to return — and then threw it away at the
 * rendering boundary. What reached the model was one sentence, the same one,
 * for all of them.
 *
 * They ask different things of a caller. A deadline means try again; a deleted
 * bundle means it is gone for good and no amount of asking will help; a record
 * over the cap means ask for less. Collapsing them tells a caller only that
 * something is missing, which is the part they had already worked out.
 *
 * Rendered rather than sanitized, and that distinction is the safety argument:
 * every annotation in this tool is a literal written in this repository — not
 * a failure message from `xcresulttool`, not a field value from a payload — so
 * there is nothing in one to redact.
 */

import { describe, expect, test } from "bun:test"

import type { InspectionResponse } from "../../src/domain/inspection.ts"
import { renderInspection } from "../../src/adapter/tools.ts"
import { RESPONSE_BYTE_CAP } from "../../src/domain/limits.ts"
import { decodeTestDetails } from "../../src/interpreter/decode.ts"
import { TIMED_OUT } from "../../src/interpreter/ports.ts"

const REQUEST = { runId: "a".repeat(32), facet: "failures" as const }

const UNTRUNCATED = {
  fieldTruncated: false,
  collectionTruncated: false,
  responseTruncated: false,
  hasMore: false,
}

function rendered(annotation?: string): string {
  const response: InspectionResponse<unknown> = {
    status: "incomplete",
    data: undefined,
    truncation: UNTRUNCATED,
    ...(annotation === undefined ? {} : { annotation }),
  }
  return renderInspection(REQUEST, response)
    .map((entry) => entry.lines.join("\n"))
    .join("\n")
}

/**
 * The typed causes, as the adapter and the interpreter word them.
 *
 * Copied here on purpose. This is the one place that asserts a reader can tell
 * them apart, so a test that imported them would pass just as happily if every
 * one of them were changed to the same string.
 */
const CAUSES = [
  "the lazy detail deadline expired before the detail could be read",
  "the Result Bundle is no longer retained, so no further detail can be read from it",
  "no bundle digest was recorded for this Test Run, so detail cannot be trusted to describe it",
  "the Result Bundle no longer matches the digest recorded for this Test Run",
  "this diagnostic is not associated with a retained test occurrence",
  "the retained evidence for this Test Run could not be read",
  "the retained evidence for this Test Run is not trustworthy",
  "2 record(s) could not be returned within the response cap",
]

describe("an incomplete inspection", () => {
  test("carries its reason to the caller", () => {
    for (const cause of CAUSES) {
      expect(rendered(cause)).toContain(cause)
    }
  })

  test("still says what incompleteness means, alongside the reason", () => {
    // The general warning is what stops a caller reading an empty page as
    // proof; the reason is what tells them whether to ask again. Neither
    // replaces the other.
    const text = rendered(CAUSES[0])

    expect(text).toContain("an empty page does not prove there are zero records")
    expect(text).toContain(CAUSES[0])
  })

  test("says the general thing when there is no particular reason", () => {
    // Not every incomplete response has a typed cause, and one that does not
    // must not render an empty line where a reason would be.
    const text = rendered()

    expect(text).toContain("an empty page does not prove there are zero records")
    expect(text).not.toContain("\n\n\n")
  })

  test("keeps the reason when the budget starts dropping things", () => {
    // In the envelope block, not beside the records: a budget that dropped
    // facts would otherwise drop the explanation for there being fewer of
    // them first.
    const blocks = renderInspection(REQUEST, {
      status: "incomplete",
      data: undefined,
      truncation: UNTRUNCATED,
      annotation: CAUSES[0] as string,
    })

    const envelope = blocks[0]
    expect(envelope?.lines.join("\n")).toContain(CAUSES[0] as string)
  })
})

describe("the text an annotation may carry", () => {
  test("never comes from a payload, even when the payload is a path", () => {
    // Two of the annotations are passed through from a read that failed rather
    // than written at the point of rendering, which is what makes this worth
    // checking rather than reading. They have to stay authored text: a message
    // that echoed what it was handed would print someone's home directory to a
    // model the first time a bundle was odd.
    const planted = "/Users/someone/private/checkout/Secret.swift"
    const decoded = decodeTestDetails(planted as unknown)

    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.message).not.toContain(planted)
    expect(decoded.message).not.toContain("/")
  })

  test("is short enough that the reason is never what breaks the budget", () => {
    // The annotations are one sentence each by construction. Asserted rather
    // than assumed, because this one is printed in the envelope block — the
    // part the budget protects rather than trims.
    for (const cause of [...CAUSES, TIMED_OUT.message]) {
      expect(Buffer.byteLength(cause, "utf8")).toBeLessThan(RESPONSE_BYTE_CAP / 100)
    }
  })
})
