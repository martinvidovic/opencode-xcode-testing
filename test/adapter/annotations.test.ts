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
import { LAZY_ANNOTATIONS } from "../../src/adapter/service.ts"
import { OMITTED_REASON, UNREADABLE_BY_THIS_TOOLCHAIN } from "../../src/interpreter/paging.ts"

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
 * Every typed cause, from where it is defined.
 *
 * Imported rather than copied. A copy is the one thing that can go stale in
 * exactly the way this file exists to prevent, and it did: the first version
 * of this list left out the ambiguous-association case, which is one of the
 * causes the issue names. What a copy would have caught — every cause
 * collapsing to one string — is caught below by requiring them to be
 * pairwise distinct.
 */
const CAUSES = [
  ...Object.values(LAZY_ANNOTATIONS),
  OMITTED_REASON,
  UNREADABLE_BY_THIS_TOOLCHAIN,
  "the retained evidence for this Test Run could not be read",
  "the retained evidence for this Test Run is not trustworthy",
]

describe("the typed causes themselves", () => {
  test("are distinct, so a caller can act on which one they got", () => {
    // The property a hand-copied list was there to check. Collapsing them to
    // one string would satisfy every "is it rendered" test in this file.
    expect(new Set(CAUSES).size).toBe(CAUSES.length)
  })

  test("include the ones the issue names by name", () => {
    const all = CAUSES.join("\n")

    expect(all).toContain("deadline expired")
    expect(all).toContain("no longer retained")
    expect(all).toContain("no longer matches the digest")
    expect(all).toContain("more than one")
    expect(all).toContain("response cap")
  })
})

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
    const text = rendered(CAUSES[0] as string)

    expect(text).toContain("an empty page does not prove there are zero records")
    expect(text).toContain(CAUSES[0] as string)
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
  test("is short enough that the reason is never what breaks the budget", () => {
    // The annotations are one sentence each by construction. Asserted rather
    // than assumed, because this one is printed in the envelope block — the
    // part the budget protects rather than trims.
    for (const cause of CAUSES) {
      expect(Buffer.byteLength(cause, "utf8")).toBeLessThan(RESPONSE_BYTE_CAP / 100)
    }
  })
})

describe("a facet that cannot be answered", () => {
  function renderedUnsupported(annotation?: string): string {
    return renderInspection(REQUEST, {
      status: "unsupported",
      facet: "failures",
      ...(annotation === undefined ? {} : { annotation }),
    })
      .map((entry) => entry.lines.join("\n"))
      .join("\n")
  }

  test("says it was never produced only when that is what happened", () => {
    expect(renderedUnsupported()).toContain("never produced for this run")
  })

  test("says what is actually wrong when something else is", () => {
    // A Result Bundle whose Xcode is gone was produced perfectly well. Told
    // "never produced", a caller concludes their run had no failures facet
    // and stops looking — a claim about the run drawn from a fact about this
    // machine.
    const text = renderedUnsupported(UNREADABLE_BY_THIS_TOOLCHAIN)

    expect(text).toContain(UNREADABLE_BY_THIS_TOOLCHAIN)
    expect(text).not.toContain("never produced for this run")
  })
})
