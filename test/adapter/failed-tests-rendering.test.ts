/**
 * The failed-tests section of a summary (issue #163).
 *
 * One line per failed test, by full identifier, so a caller asked "which tests
 * failed?" can answer from the result it already has. The two edges worth
 * pinning are the ones the goldens do not reach: a test that failed several
 * assertions, and more failed tests than the section carries.
 */

import { describe, expect, test } from "bun:test"

import { renderTestToolResult } from "../../src/adapter/output.ts"
import { SUMMARY_FAILED_TEST_CAP } from "../../src/domain/limits.ts"
import type { FailedTest, TestRunSummary } from "../../src/domain/result.ts"
import { FAILED_EXIT, interpretFixture } from "../interpreter/harness.ts"

function failedTest(index: number, failureCount = 1): FailedTest {
  const name = `testCase${String(index).padStart(3, "0")}()`
  return {
    identity: { bundle: "AppTests", suite: "ServiceTests", test: name, canonical: `AppTests/ServiceTests/${name}` },
    failureCount,
  }
}

async function renderedWith(failed: FailedTest[], total = failed.length): Promise<string> {
  const { summary } = await interpretFixture("test-failed", { request: { execution: FAILED_EXIT } })
  const withFailures: TestRunSummary = {
    ...summary,
    diagnostics: {
      ...summary.diagnostics,
      failedTests: failed,
      failedTestSection: { total, shown: failed.length, truncated: total > failed.length },
    },
  }
  return renderTestToolResult(withFailures).text
}

describe("the failed-tests section", () => {
  test("names a test that failed several assertions once, with how many it failed", async () => {
    const text = await renderedWith([failedTest(1, 3), failedTest(2)])

    expect(text).toContain("failed tests (2):\n  AppTests/ServiceTests/testCase001()  (3 failures)\n  AppTests/ServiceTests/testCase002()\n")
  })

  test("says how many there are and where the rest are when they do not all fit", async () => {
    const shown = Array.from({ length: SUMMARY_FAILED_TEST_CAP }, (_, index) => failedTest(index))

    const text = await renderedWith(shown, SUMMARY_FAILED_TEST_CAP + 30)

    expect(text).toContain(`failed tests (showing ${SUMMARY_FAILED_TEST_CAP} of ${SUMMARY_FAILED_TEST_CAP + 30}):`)
    expect(text).toContain("the rest: xcode_test_inspect facet tests, status failed")
  })

  test("is absent when nothing failed", async () => {
    expect(await renderedWith([])).not.toContain("failed tests")
  })
})
