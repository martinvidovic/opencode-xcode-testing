/**
 * The summary and the facet agree about what an empty page means (issue #76).
 *
 * `inspection.failures` is the summary's advertisement of a facet, and the
 * facet is what a caller gets when they act on it. They were derived from
 * different things: the advertisement from the *test counts*, the facet from
 * the *diagnostic record*. A run that counted every test correctly and lost
 * its failure detail therefore advertised `available` — which carries the
 * strong promise that an empty page authoritatively means zero failures — and
 * then returned `incomplete` when asked.
 *
 * The direction matters. Over-warning is discounted; this under-warned, and a
 * caller reading "no failures" from a run that had them cannot tell.
 *
 * Both halves of the defect are here, because either alone re-arms it: the
 * advertisement has to answer to the diagnostic record, and a supplemental
 * read that *failed* has to degrade that record rather than leaving it whole.
 */

import { describe, expect, test } from "bun:test"

import { inspectIndex, UNREADABLE_BY_THIS_TOOLCHAIN } from "../../src/interpreter/paging.ts"
import { FAILED_EXIT, interpretFixture, TRUSTED_ROOT } from "./harness.ts"

const SECRET = Buffer.alloc(32, 7)

/** What the failures facet actually answers, for the same run. */
function facetStatus(index: Parameters<typeof inspectIndex>[0]): string {
  return inspectIndex(
    index,
    { runId: index.runId, facet: "failures" },
    SECRET,
    TRUSTED_ROOT,
  ).status
}

/** A run whose counts are fine and whose supplemental failure read is not. */
function withoutTheSummary() {
  return interpretFixture("test-failed", {
    request: { execution: FAILED_EXIT },
    reader: { failures: { "get test-results summary": "commandFailed" } },
  })
}

describe("a run whose supplemental failure read failed", () => {
  test("still counts its tests, and says its diagnostics are partial", async () => {
    const { index } = await withoutTheSummary()

    // The two facts this separation exists to keep apart. Folding them
    // together is what made an empty failures page look authoritative on the
    // strength of the counts being fine.
    expect(index.tests.completeness).toBe("complete")
    expect(index.diagnostics.completeness).toBe("partial")
  })

  test("advertises its failures facet as incomplete, not available", async () => {
    const { summary } = await withoutTheSummary()

    expect(summary.inspection.failures).toBe("incomplete")
    // And only that facet. The counts really were complete, and a summary that
    // warned about everything would be a summary nobody reads.
    expect(summary.inspection.tests).toBe("available")
    expect(summary.inspection.scope).toBe("available")
  })

  test("records why, rather than degrading silently", async () => {
    const { anomalies } = await withoutTheSummary()

    // A lossy step nobody wrote down is one nothing can explain afterwards.
    expect(anomalies.some((entry) => entry.command === "get test-results summary" && entry.lossy))
      .toBe(true)
  })
})

describe("a run whose evidence is whole", () => {
  test("advertises its failures facet as available", async () => {
    // The negative control. Without it, every assertion above would pass on an
    // implementation that called every facet incomplete.
    const { summary } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })

    expect(summary.inspection.failures).toBe("available")
  })
})

describe("the advertisement and the facet", () => {
  test("agree when the evidence is whole", async () => {
    const { summary, index } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })

    expect(summary.inspection.failures).toBe("available")
    expect(facetStatus(index)).toBe("available")
  })

  test("agree when it is not", async () => {
    // The disagreement itself, which is the defect rather than a symptom of
    // it: a caller who read the summary and acted on it was contradicted by
    // the thing they acted on.
    const { summary, index } = await withoutTheSummary()

    expect(summary.inspection.failures).toBe("incomplete")
    expect(facetStatus(index)).toBe("incomplete")
  })
})

describe("what a facet says about itself", () => {
  test("names the evidence it is short of, rather than only warning", async () => {
    // Driven through the real producer, because the defect was that the
    // producer had nothing to say. A list of strings fed to the renderer
    // would have passed against a page that carried no annotation at all.
    const degraded = await withoutTheSummary()

    const response = inspectIndex(
      degraded.index,
      { runId: degraded.index.runId, facet: "failures" },
      SECRET,
      TRUSTED_ROOT,
    )

    expect(response.status).toBe("incomplete")
    if (response.status !== "incomplete") return
    expect(response.annotation).toContain("diagnostic record")
  })

  test("distinguishes a bundle nothing can read from a facet never produced", async () => {
    // `unsupported` covered both, and rendered the second: "this facet was
    // never produced for this run" is a claim about the run, and a caller
    // told it about a bundle whose Xcode is merely gone would stop looking.
    const { index } = await interpretFixture("test-failed", {
      request: { execution: FAILED_EXIT },
    })

    const response = inspectIndex(
      index,
      { runId: index.runId, facet: "failures", diagnosticId: index.testFailures[0]?.id ?? "" },
      SECRET,
      TRUSTED_ROOT,
      { status: "unsupported" },
    )

    expect(response.status).toBe("unsupported")
    if (response.status !== "unsupported") return
    expect(response.annotation).toBe(UNREADABLE_BY_THIS_TOOLCHAIN)
  })
})
