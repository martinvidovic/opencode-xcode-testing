/**
 * Extraction sequence, evidence authority, and the eager interpretation budget
 * (#8).
 */

import { describe, expect, test } from "bun:test"

import type { XcresultCommand } from "../../src/interpreter/anomalies.ts"
import { EAGER_DEADLINE_MS } from "../../src/interpreter/schema.ts"
import { FAILED_EXIT, fixtureNames, interpretFixture, loadFixture } from "./harness.ts"

describe("evidence authority", () => {
  test("classifies only from the Result Bundle — raw logs are never read", async () => {
    const commands: XcresultCommand[] = []
    await interpretFixture("passed", { reader: { onRun: (command) => commands.push(command) } })
    expect(commands).toEqual([
      "metadata get",
      "get content-availability",
      "get build-results",
      "get test-results tests",
      "get test-results summary",
    ])
  })

  test("reports only log availability and retained size, never log content", async () => {
    const { summary, index } = await interpretFixture("passed")
    expect(summary.inspection.log).toBe("available")
    expect(index.log).toEqual({ availability: "available", retainedBytes: 4096, retainedBytesExact: true })
  })

  test("marks the log facet unavailable when nothing was retained", async () => {
    const { summary } = await interpretFixture("passed", {
      facts: { log: { retainedBytesExact: false } },
    })
    expect(summary.inspection.log).toBe("unavailable")
  })

  test("establishes readability by opening the bundle, not by reading stderr", async () => {
    const commands: XcresultCommand[] = []
    await interpretFixture("passed", {
      request: { execution: FAILED_EXIT },
      reader: {
        failures: { "metadata get": "bundleUnreadable" },
        onRun: (command) => commands.push(command),
      },
    })
    // Preflight failed, so nothing further was decoded.
    expect(commands).toEqual(["metadata get"])
  })
})

describe("a provable build failure", () => {
  test("does not short-circuit the remaining extraction", async () => {
    const commands: XcresultCommand[] = []
    const { summary } = await interpretFixture("build-failed-with-tests", {
      request: { execution: FAILED_EXIT },
      reader: { onRun: (command) => commands.push(command) },
    })
    expect(summary.outcome).toBe("buildFailed")
    expect(commands).toContain("get test-results tests")
    expect(summary.tests.completeness).toBe("complete")
    expect(summary.tests.counts?.total).toBe(1)
  })
})

describe("the test command", () => {
  test("is skipped only when availability authoritatively reports no test results", async () => {
    const commands: XcresultCommand[] = []
    await interpretFixture("build-failed", {
      request: { execution: FAILED_EXIT },
      reader: { onRun: (command) => commands.push(command) },
    })
    expect(commands).not.toContain("get test-results tests")
  })
})

describe("the eager budget", () => {
  test("defaults to a fixed 120 seconds", () => {
    expect(EAGER_DEADLINE_MS).toBe(120_000)
  })

  test("gives each operation only the remaining budget", async () => {
    const budgets: number[] = []
    const clock = advancingOnDemand()
    await interpretFixture("passed", {
      request: { clock, deadlineMs: 10_000 },
      reader: {
        onRun: (_command, budgetMs) => {
          budgets.push(budgetMs)
          clock.advance(1_000)
        },
      },
    })
    expect(budgets).toEqual([10_000, 9_000, 8_000, 7_000, 6_000])
  })

  test("publishes completed facets and discards the rest when it expires", async () => {
    const clock = advancingOnDemand()
    const { summary } = await interpretFixture("passed", {
      request: { clock, deadlineMs: 150, execution: FAILED_EXIT },
      reader: { onRun: () => clock.advance(60) },
    })

    expect(summary).toMatchObject({
      outcome: "infrastructureFailed",
      reason: "interpretationTimedOut",
    })
    // Build results completed before the deadline and are published as complete.
    expect(summary.build).toEqual({ completeness: "complete", errorCount: 0 })
    // The test hierarchy never ran, so it is unavailable rather than zero.
    expect(summary.tests).toEqual({ completeness: "unavailable" })
    expect(summary.tests.counts).toBeUndefined()
  })

  test("is measured on the clock it was given, and reported in the timing", async () => {
    const clock = advancingOnDemand()
    const { summary } = await interpretFixture("passed", {
      request: { clock },
      reader: { onRun: () => clock.advance(200) },
    })
    expect(summary.timing.interpretationDurationMs).toBe(1_000)
    expect(summary.timing.totalDurationMs).toBe(4_100 + 1_000)
  })
})

describe("a bundle digest mismatch", () => {
  test("leaves the published summary and indexed evidence valid", async () => {
    const { summary, index } = await interpretFixture("passed", {
      facts: { bundleDigestVerified: "no" },
    })
    expect(summary.outcome).toBe("passed")
    expect(index.occurrences).toHaveLength(2)
  })

  test("is recorded as a private stability anomaly, never a public warning", async () => {
    const { anomalies } = await interpretFixture("passed", {
      facts: { bundleDigestVerified: "no" },
    })
    expect(anomalies).toEqual([
      expect.objectContaining({ fieldPath: "result.xcresult", lossy: true }),
    ])
  })

  test("is carried on the index so lazy bundle-backed detail can degrade", async () => {
    const { index } = await interpretFixture("passed", { facts: { bundleDigestVerified: "no" } })
    expect(index.bundleDigestVerified).toBe("no")
  })
})

describe("every committed fixture", () => {
  test("carries structured provenance keyed to the pinned schema and decoder pair", () => {
    const names = fixtureNames()
    expect(names.length).toBeGreaterThan(0)

    for (const name of names) {
      const { provenance } = loadFixture(name)
      expect({ name, ...provenance }).toMatchObject({
        name,
        scenario: name,
        schemaVersion: "0.1.0",
        decoderVersion: 1,
        xcresulttoolVersion: "24757",
        legacyCommandsFormatVersion: "3.58",
        xcodeVersion: "26.0",
        xcodeBuild: "17A400",
      })
      expect(typeof provenance.observedShape).toBe("string")
      expect(provenance.observedShape.length).toBeGreaterThan(0)
    }
  })
})

/** A monotonic clock the test advances explicitly, so budgets are exact. */
function advancingOnDemand() {
  let now = 0
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}
