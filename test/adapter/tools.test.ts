/**
 * Tool execution: throw semantics, cancellation edges, and metadata
 * (ADR 0002, layer (a)).
 *
 * The throw rule is not stylistic. A thrown error becomes an `output-error`
 * part in which the model sees only the message — title, metadata and
 * attachments are discarded and `tool.execute.after` never fires — so throwing
 * a domain outcome would destroy exactly the evidence the result contract
 * exists to deliver.
 */

import { describe, expect, test } from "bun:test"

import type { TestToolResult } from "../../src/domain/result.ts"
import { SCHEMA_VERSION } from "../../src/domain/result.ts"
import {
  ABORT_WAIT_MS,
  executeInspect,
  executeRecover,
  executeTest,
  pendingCancellation,
  PROTOCOL_STATES,
  type AdmittedRun,
  type TestToolService,
  type ToolContext,
  type ToolDeps,
} from "../../src/adapter/tools.ts"
import { RESOLVED } from "../interpreter/harness.ts"
import { FAILED_EXIT, interpretFixture } from "../interpreter/harness.ts"

import type { TestArguments } from "../../src/adapter/args.ts"

/** The arguments a model supplies, not the domain request they map onto. */
const ARGS: TestArguments = { scope: { kind: "all" } }

const ADMITTED: AdmittedRun = {
  runId: "0f8a2c",
  resolved: RESOLVED,
  admittedAt: "2026-09-13T10:00:00.000Z",
  queueDurationMs: 12,
}

function deps(service: Partial<TestToolService>, overrides: Partial<ToolDeps> = {}): ToolDeps {
  let clock = 0
  return {
    service: {
      start: () => ({ admitted: Promise.resolve(ADMITTED), result: new Promise(() => {}) }),
      inspect: async () => ({ status: "notFound", subject: "run" }),
      recover: async () => ({ status: "alreadyHealthy" }),
      ...service,
    },
    now: () => (clock += 10),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timestamp: () => "2026-09-13T10:00:00.000Z",
    ...overrides,
  }
}

function settledService(result: TestToolResult, hooks: { states?: string[] } = {}): Partial<TestToolService> {
  return {
    start(_request, callbacks) {
      for (const state of PROTOCOL_STATES) {
        callbacks.onState(state)
        hooks.states?.push(state)
      }
      return { admitted: Promise.resolve(ADMITTED), result: Promise.resolve(result) }
    },
  }
}

describe("throw semantics", () => {
  test("renders `invalid` as ordinary output rather than throwing", async () => {
    const rejected: TestToolResult = {
      schemaVersion: SCHEMA_VERSION,
      outcome: "invalid",
      errors: [{ field: "destination", code: "required", message: "a destination is required" }],
      errorSection: { total: 1, shown: 1, truncated: false },
    }
    const output = await executeTest(ARGS, {}, deps(settledService(rejected)))
    expect(output).toContain("Test Run invalid")
  })

  test("renders `infrastructureFailed` as ordinary output", async () => {
    const { summary } = await interpretFixture("unknown-status")
    const output = await executeTest(ARGS, {}, deps(settledService(summary)))
    expect(output).toContain("infrastructureFailed")
    expect(output).toContain("unknownTestStatus")
  })

  test("renders a queued failure as ordinary output", async () => {
    const queued: TestToolResult = {
      schemaVersion: SCHEMA_VERSION,
      outcome: "infrastructureFailed",
      phase: "queued",
      reason: "executionSlotQuarantined",
      message: "the execution slot is quarantined until recovery clears it",
    }
    const output = await executeTest(ARGS, {}, deps(settledService(queued)))
    expect(output).toContain("executionSlotQuarantined")
  })

  test("renders `timedOut` as ordinary output", async () => {
    const { summary } = await interpretFixture("passed", {
      request: {
        terminationTrigger: "processDeadline",
        deadlineCrossedPhase: "testing",
        execution: FAILED_EXIT,
      },
    })
    const output = await executeTest(ARGS, {}, deps(settledService(summary)))
    expect(output).toContain("timedOut")
  })
})

describe("running metadata", () => {
  test("reports durable protocol states and never an inferred phase", async () => {
    const seen: Array<Record<string, unknown>> = []
    const context: ToolContext = {
      metadata: (update) => {
        if (update.metadata !== undefined) seen.push(update.metadata)
      },
    }

    const { summary } = await interpretFixture("passed")
    await executeTest(ARGS, context, deps(settledService(summary)))

    const states = seen.map((entry) => entry["state"])
    expect(states).toEqual(expect.arrayContaining([...PROTOCOL_STATES]))
    // No phase is inferred from elapsed time or partial output.
    expect(states).not.toContain("building")
    expect(states).not.toContain("testing")
  })

  test("mirrors the run id, the one fact deliberately duplicated there", async () => {
    const seen: Array<Record<string, unknown>> = []
    const { summary } = await interpretFixture("passed")
    await executeTest(
      ARGS,
      { metadata: (update) => update.metadata !== undefined && seen.push(update.metadata) },
      deps(settledService(summary)),
    )
    expect(seen.some((entry) => entry["runId"] === ADMITTED.runId)).toBe(true)
  })

  test("carries elapsed time, which is durable rather than inferred", async () => {
    const seen: Array<Record<string, unknown>> = []
    const { summary } = await interpretFixture("passed")
    await executeTest(
      ARGS,
      { metadata: (update) => update.metadata !== undefined && seen.push(update.metadata) },
      deps(settledService(summary)),
    )
    for (const entry of seen) expect(typeof entry["elapsedMs"]).toBe("number")
  })
})

describe("cancellation", () => {
  test("returns the real summary when publication lands inside the wait", async () => {
    const { summary } = await interpretFixture("passed", {
      request: {
        terminationTrigger: "callerCancellation",
        interruptionPhase: "testing",
        execution: FAILED_EXIT,
      },
    })

    let settle: (value: TestToolResult) => void = () => {}
    const result = new Promise<TestToolResult>((resolve) => {
      settle = resolve
    })
    const context: ToolContext = { abort: { aborted: true } }

    const output = executeTest(
      ARGS,
      context,
      deps({ start: () => ({ admitted: Promise.resolve(ADMITTED), result }) }),
    )
    setTimeout(() => settle(summary), 20)

    expect(await output).toContain("Test Run cancelled while testing")
  })

  test("returns `cancelled` with unknown evidence and the run id when it does not", async () => {
    const output = await executeTest(
      ARGS,
      { abort: { aborted: true } },
      deps({}, { abortWaitMs: 30 }),
    )

    expect(output).toContain("Test Run cancelled")
    expect(output).toContain(ADMITTED.runId)
    expect(output).toContain("exec unknown")
    expect(output).toContain("descendants exited unknown")
  })

  test("never abandons the run: the run id is there to inspect afterwards", async () => {
    const output = await executeTest(
      ARGS,
      { abort: { aborted: true } },
      deps({}, { abortWaitMs: 30 }),
    )
    expect(output).toMatch(new RegExp(`run\\s+${ADMITTED.runId}`))
  })

  test("reports a queued cancellation with no run id, since there is nothing to inspect", async () => {
    const output = await executeTest(
      ARGS,
      { abort: { aborted: true } },
      deps(
        { start: () => ({ admitted: Promise.reject(new Error("never admitted")), result: new Promise(() => {}) }) },
        { abortWaitMs: 30 },
      ),
    )
    expect(output).toContain("Test Run cancelled while queued")
    expect(output).toContain("No Test Run was started")
  })

  test("waits the bounded window that covers termination, not the whole budget", () => {
    expect(ABORT_WAIT_MS).toBe(30_000)
  })
})

describe("the pending-cancellation summary", () => {
  test("says `unknown` where facts are still pending, never zero", () => {
    const summary = pendingCancellation(ADMITTED, { kind: "all" }, 4_000)

    expect(summary.execution).toEqual({ execObserved: "unknown", successfulExit: "unknown" })
    expect(summary.tests.counts).toBeUndefined()
    expect(summary.build).toEqual({ completeness: "unavailable" })
    expect(summary.termination.descendantsConfirmedExited).toBe("unknown")
  })

  test("keeps the run id and a real scope digest, so it correlates", () => {
    const summary = pendingCancellation(ADMITTED, { kind: "all" }, 4_000)
    expect(summary.runId).toBe(ADMITTED.runId)
    expect(summary.scope.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(summary.scope.verdict).toBe("unverifiable")
  })
})

describe("inspection", () => {
  test("ignores abort, because a completed bounded read is worth keeping", async () => {
    // The result lands in session history either way, so discarding it would
    // throw away work that is already done.
    const output = await executeInspect(
      { runId: "0f8a2c", facet: "failures" },
      { abort: { aborted: true } },
      deps({
        inspect: async () => ({
          status: "available",
          completeness: "complete",
          data: { records: [] },
          truncation: {
            fieldTruncated: false,
            collectionTruncated: false,
            responseTruncated: false,
            hasMore: false,
          },
        }),
      }),
    )
    expect(output).toContain("available")
  })

  test("renders a typed not-found as output rather than throwing", async () => {
    const output = await executeInspect({ runId: "nope", facet: "tests" }, {}, deps({}))
    expect(output).toContain("notFound")
    expect(output).toContain("run")
  })

  test("says plainly that an expired run cannot be recovered", async () => {
    const output = await executeInspect(
      { runId: "0f8a2c", facet: "log" },
      {},
      deps({ inspect: async () => ({ status: "expired" }) }),
    )
    expect(output).toContain("expired")
    expect(output).toContain("cannot be recovered")
  })

  test("offers the cursor when there is more to read", async () => {
    const output = await executeInspect(
      { runId: "0f8a2c", facet: "tests" },
      {},
      deps({
        inspect: async () => ({
          status: "available",
          completeness: "complete",
          data: { records: [{ id: "a" }] },
          truncation: {
            fieldTruncated: false,
            collectionTruncated: true,
            responseTruncated: false,
            hasMore: true,
            nextCursor: "opaque-cursor",
          },
        }),
      }),
    )
    expect(output).toContain("opaque-cursor")
  })
})

describe("recovery", () => {
  test("renders its status as ordinary output", async () => {
    const output = await executeRecover({}, {}, deps({ recover: async () => ({ status: "recovered" }) }))
    expect(output).toContain("Recovery: recovered")
  })

  test("explains a quarantine that survived, rather than inviting a retry loop", async () => {
    const output = await executeRecover(
      {},
      {},
      deps({
        recover: async () => ({
          status: "stillQuarantined",
          message: "1 run(s) could not be accounted for and still hold the execution slot.",
        }),
      }),
    )
    expect(output).toContain("stillQuarantined")
    expect(output).toContain("could not be accounted for")
  })
})
