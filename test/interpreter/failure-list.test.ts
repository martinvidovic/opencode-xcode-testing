/**
 * Listing which tests failed, without asking about each one (issue #163).
 *
 * The reported run had thousands of tests and a handful of failures, and the
 * caller wanted only the list of failing identifiers. The summary showed
 * failure messages and handles — skip messages among them — but not which
 * test each belonged to, and the `tests` facet could only be paged whole. So
 * the list cost one Focused Detail per failing test.
 *
 * The shape here is that run's, anonymized: many passing tests, a few failed
 * ones of which some fail several assertions, and skipped tests whose skip
 * reason arrives as a message node exactly like a failure's.
 */

import { describe, expect, test } from "bun:test"

import type { InspectRunRequest, TestRecord } from "../../src/domain/inspection.ts"
import type { InterpretedRun } from "../../src/interpreter/interpret.ts"
import { inspectIndex } from "../../src/interpreter/paging.ts"
import { CONTAINMENT_ROOT, FAILED_EXIT, interpretFixture, loadFixture } from "./harness.ts"

const SECRET = Buffer.alloc(32, 11)
const PASSING = 300
/** Failed tests, and how many assertions each one failed. */
const FAILING: Array<[string, number]> = [
  ["testRejectsExpiredToken()", 3],
  ["testRefreshesSession()", 1],
  ["testRetriesOnTimeout()", 2],
  ["testParsesEmptyBody()", 1],
  ["testRoundsCurrency()", 3],
  ["testSortsByDate()", 1],
  ["testFormatsAddress()", 1],
  ["testValidatesEmail()", 3],
  ["testDecodesLegacyPayload()", 1],
]
const SKIPPED = ["testRunsOnlyOnDevice()", "testNeedsNetwork()", "testRequiresCamera()", "testBetaFeature()"]

function testCase(name: string, result: string, children: unknown[] = []) {
  return {
    nodeType: "Test Case",
    name,
    nodeIdentifier: `ServiceTests/${name}`,
    result,
    durationInSeconds: 0.01,
    nodeIdentifierURL: `test://com.apple.xcode/App/AppTests/ServiceTests/${name.replace(/\(\)$/, "")}`,
    ...(children.length === 0 ? {} : { children }),
  }
}

function message(text: string, line: number) {
  return {
    nodeType: "Failure Message",
    name: text,
    children: [
      {
        nodeType: "Source Code Reference",
        name: `file:///workspace/Sources/App/Service.swift#StartingLineNumber=${line}&StartingColumnNumber=9`,
      },
    ],
  }
}

/** The reported shape, as a Result Bundle a reader can serve. */
async function manyTestsFewFailures(): Promise<InterpretedRun> {
  const fixture = loadFixture("test-failed")
  const cases = [
    ...Array.from({ length: PASSING }, (_, index) => testCase(`testPasses${index}()`, "Passed")),
    ...FAILING.map(([name, assertions], index) =>
      testCase(
        name,
        "Failed",
        Array.from({ length: assertions }, (_, assertion) =>
          message(`XCTAssertEqual failed in assertion ${assertion}`, 100 + index * 10 + assertion),
        ),
      ),
    ),
    ...SKIPPED.map((name, index) => testCase(name, "Skipped", [message(`Test skipped - reason ${index}`, 500 + index)])),
  ]
  const tests = structuredClone(fixture.payloads["get test-results tests"]) as {
    testNodes: Array<{ children: Array<{ children: unknown[] }> }>
  }
  const bundle = tests.testNodes[0]?.children[0]
  if (bundle === undefined) throw new Error("the base fixture has no test bundle")
  bundle.children = [{ nodeType: "Test Suite", name: "ServiceTests", children: cases }]

  return interpretFixture("test-failed", {
    request: { execution: FAILED_EXIT },
    reader: {
      payloads: {
        "get test-results tests": tests,
        "get test-results summary": {
          result: "Failed",
          totalTestCount: cases.length,
          passedTests: PASSING,
          failedTests: FAILING.length,
          skippedTests: SKIPPED.length,
          expectedFailures: 0,
          testFailures: [],
        },
      },
    },
  })
}

function inspectTests(run: InterpretedRun, request: Partial<InspectRunRequest>) {
  return inspectIndex(
    run.index,
    { runId: run.index.runId, facet: "tests", ...request } as InspectRunRequest,
    SECRET,
    CONTAINMENT_ROOT,
  )
}

function recordsIn(response: ReturnType<typeof inspectTests>): TestRecord[] {
  if (response.status !== "available" && response.status !== "incomplete") return []
  const page = response.data as { view: string; records?: TestRecord[] } | undefined
  return page?.view === "records" ? (page.records ?? []) : []
}

const canonical = (name: string) => `AppTests/ServiceTests/${name}`

describe("the summary of a run with many tests and a few failures", () => {
  test("names every failed test once, with how many assertions it failed", async () => {
    const { summary } = await manyTestsFewFailures()

    expect(summary.diagnostics.failedTests.map((entry) => [entry.identity.canonical, entry.failureCount])).toEqual(
      FAILING.map(([name, assertions]) => [canonical(name), assertions]),
    )
    expect(summary.diagnostics.failedTestSection).toEqual({ total: 9, shown: 9, truncated: false })
  })

  test("counts a failed test's assertions as failures, and a skip reason as none", async () => {
    const { summary } = await manyTestsFewFailures()
    const assertions = FAILING.reduce((total, [, count]) => total + count, 0)

    expect(summary.tests.counts?.failed).toBe(FAILING.length)
    expect(summary.diagnostics.testFailureSection.total).toBe(assertions)
    expect(summary.diagnostics.testFailures.some((entry) => entry.message.startsWith("Test skipped"))).toBe(false)
  })
})

describe("the tests facet, filtered by status", () => {
  test("returns every failed test in one reasonably sized read", async () => {
    const run = await manyTestsFewFailures()

    const response = inspectTests(run, { status: "failed", limit: 100 })

    expect(response.status).toBe("available")
    if (response.status !== "available") return
    expect(response.completeness).toBe("complete")
    expect(response.truncation.hasMore).toBe(false)
    expect(recordsIn(response).map((record) => [record.identity.canonical, record.failureCount])).toEqual(
      FAILING.map(([name, assertions]) => [canonical(name), assertions]),
    )
  })

  test("keeps skipped tests apart from failed ones", async () => {
    const run = await manyTestsFewFailures()

    const skipped = recordsIn(inspectTests(run, { status: "skipped", limit: 100 }))

    expect(skipped.map((record) => record.identity.canonical)).toEqual(SKIPPED.map(canonical))
    expect(skipped.every((record) => record.status === "skipped")).toBe(true)
  })

  test("pages within the filter, and a cursor stays bound to it", async () => {
    const run = await manyTestsFewFailures()

    const first = inspectTests(run, { status: "failed", limit: 5 })
    if (first.status !== "available" || first.truncation.nextCursor === undefined) {
      throw new Error("expected a first page with a cursor")
    }
    const rest = inspectTests(run, { status: "failed", limit: 5, cursor: first.truncation.nextCursor })
    const unfiltered = inspectTests(run, { limit: 5, cursor: first.truncation.nextCursor })
    const other = inspectTests(run, { status: "passed", limit: 5, cursor: first.truncation.nextCursor })

    expect([...recordsIn(first), ...recordsIn(rest)].map((record) => record.identity.canonical)).toEqual(
      FAILING.map(([name]) => canonical(name)),
    )
    // Positions in a filtered list mean nothing in another one.
    expect(unfiltered.status).toBe("invalid")
    expect(other.status).toBe("invalid")
  })

  test("is refused where it cannot mean anything", async () => {
    const run = await manyTestsFewFailures()
    const failures = inspectIndex(
      run.index,
      { runId: run.index.runId, facet: "failures", status: "failed" } as InspectRunRequest,
      SECRET,
      CONTAINMENT_ROOT,
    )
    const focused = inspectTests(run, { status: "failed", testId: run.index.occurrences[0]?.id ?? "" })
    const unknown = inspectTests(run, { status: "flaky" as never })

    expect(failures.status).toBe("invalid")
    expect(focused.status).toBe("invalid")
    expect(unknown.status).toBe("invalid")
  })
})

describe("a skipped test's reason", () => {
  test("is still there when that test is read in detail", async () => {
    const run = await manyTestsFewFailures()
    const skipped = run.index.occurrences.find((occurrence) => occurrence.status === "skipped")
    if (skipped === undefined) throw new Error("no skipped test")

    const response = inspectTests(run, { testId: skipped.id })

    expect(JSON.stringify(response)).toContain("Test skipped - reason")
  })
})
