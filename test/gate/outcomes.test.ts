/**
 * What a supplied-project run may report and still pass (issue #37).
 *
 * `--project` exists to find out whether this tool works against a repository
 * nobody generated. That makes the distinction here the whole point of the
 * mode: outcomes that describe the *project* are none of the gate's business,
 * and outcomes that describe the *tool* failing are exactly its business.
 *
 * Getting it the other way round is the expensive mistake. A run that came
 * back `infrastructureFailed` reached a classified outcome, so a gate that
 * asked only "did it classify?" would report green on the single result that
 * proves it did not work.
 */

import { describe, expect, test } from "bun:test"

import { TEST_TOOL_OUTCOMES, type TestToolOutcome } from "../../src/domain/outcome.ts"
import { isHealthyOutcome } from "../../scripts/gate/layer4.ts"

/** Outcomes that say the tool did its job, whatever the project's code did. */
const HEALTHY: TestToolOutcome[] = ["passed", "testFailed", "buildFailed"]

/** Outcomes that say this tool could not produce an answer at all. */
const UNHEALTHY: TestToolOutcome[] = ["infrastructureFailed", "timedOut", "cancelled", "invalid"]

describe("an outcome that describes the project", () => {
  test("passes, because the project's code is not under test here", () => {
    // The tool ran the tests and said what happened. That it happened to be
    // bad news about the repository is the repository's business.
    for (const outcome of HEALTHY) expect(isHealthyOutcome(outcome)).toBe(true)
  })
})

describe("an outcome that describes the tool", () => {
  test("fails, even though it is a classified outcome", () => {
    // Each of these is a well-formed answer meaning "no answer": the tool
    // could not produce one. Counting them as passes is how a gate reports
    // green on the finding it exists to surface.
    for (const outcome of UNHEALTHY) expect(isHealthyOutcome(outcome)).toBe(false)
  })

  test("covers every outcome the contract defines, so a new one cannot slip through", () => {
    // The list is closed in the domain — "adding a member is a schema change"
    // — so the compiler, not a runtime string check, is what stops a new
    // outcome being silently treated as healthy. This asserts the two lists
    // together account for all of it.
    const judged = [...HEALTHY, ...UNHEALTHY].sort()
    expect(judged).toEqual([...TEST_TOOL_OUTCOMES].sort())
  })
})
