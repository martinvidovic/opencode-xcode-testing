/**
 * The synthetic domain outputs layer (a) renders.
 *
 * Every Test Run scenario comes from #10's committed fixtures, driven through
 * the real interpreter — so a golden is a picture of what the model would
 * actually see, not of what a hand-written literal says it would see. The
 * pre-execution results have no fixture, because no Result Bundle exists for
 * them; those are constructed here.
 */

import type {
  RequestCancelled,
  RequestRejected,
  RequestResolutionFailed,
  TestRunSummary,
  TestToolResult,
} from "../../src/domain/result.ts"
import { isTestRunSummary, SCHEMA_VERSION } from "../../src/domain/result.ts"
import { FAILED_EXIT, interpretFixture, type ScenarioOverrides } from "../interpreter/harness.ts"
import { bundleDigest } from "../../src/adapter/service.ts"

export type Scenario = {
  name: string
  build(): Promise<TestToolResult>
}

function fromFixture(name: string, fixture: string, overrides: ScenarioOverrides = {}): Scenario {
  return {
    name,
    async build() {
      const { summary } = await interpretFixture(fixture, overrides)
      return summary
    },
  }
}

function fixed(name: string, result: TestToolResult): Scenario {
  return { name, build: () => Promise.resolve(result) }
}

const rejected: RequestRejected = {
  schemaVersion: SCHEMA_VERSION,
  outcome: "invalid",
  errors: [
    {
      field: "destination",
      code: "required",
      message: "a destination must be requested or configured",
    },
    {
      field: "scheme",
      code: "ambiguous",
      message: "more than one shared scheme was discovered; name one explicitly",
      candidates: ["App", "Demo"],
    },
  ],
  errorSection: { total: 2, shown: 2, truncated: false },
}

const queueCancelled: RequestCancelled = {
  schemaVersion: SCHEMA_VERSION,
  outcome: "cancelled",
  phase: "queued",
  queuedAt: "2026-09-13T10:00:00.000Z",
  queueDurationMs: 1_250,
}

const resolutionFailed: RequestResolutionFailed = {
  schemaVersion: SCHEMA_VERSION,
  outcome: "infrastructureFailed",
  phase: "queued",
  reason: "executionSlotQuarantined",
  message: "the execution slot is quarantined until recovery clears it",
  queuedAt: "2026-09-13T10:00:00.000Z",
  queueDurationMs: 40,
}

/** One scenario per outcome the model can be shown, plus the edges worth pinning. */
export const SCENARIOS: Scenario[] = [
  fromFixture("passed", "passed"),
  fromFixture("test-failed", "test-failed", { request: { execution: FAILED_EXIT } }),
  fromFixture("build-failed", "build-failed", {
    scope: { kind: "selected", tests: [{ bundle: "AppTests", suite: "LoginTests" }] },
    request: { execution: FAILED_EXIT },
  }),
  fromFixture("infrastructure-failed-scope-mismatch", "zero-match", {
    scope: { kind: "selected", tests: [{ bundle: "AppTests", suite: "MissingTests" }] },
  }),
  fromFixture("infrastructure-failed-unknown-status", "unknown-status"),
  fromFixture("cancelled", "passed", {
    request: {
      terminationTrigger: "callerCancellation",
      interruptionPhase: "testing",
      execution: FAILED_EXIT,
    },
  }),
  fromFixture("timed-out", "passed", {
    request: {
      terminationTrigger: "processDeadline",
      deadlineCrossedPhase: "testing",
      execution: FAILED_EXIT,
    },
  }),
  fromFixture("capped-failures", "many-failures", { request: { execution: FAILED_EXIT } }),
  fixed("request-invalid", rejected),
  fixed("request-cancelled-queued", queueCancelled),
  fixed("request-resolution-failed", resolutionFailed),
]

/**
 * The digest, or `undefined` when the walk did not finish.
 *
 * The typed outcome is what the production callers act on — a deadline and an
 * unreadable tree ask different things of them — but a test comparing two
 * digests for equality is not about that distinction, and spelling it out at
 * every call site would bury what each of those is checking. The tests that
 * *are* about it discriminate on the union directly.
 */
/**
 * `{ bundleDigest }`, or nothing when the walk did not finish.
 *
 * Spread into a seeded record rather than assigned, because a record field
 * that is present and `undefined` is a different shape from one that is
 * absent — and only the absent one survives a round trip through JSON, which
 * is the journey every one of these records makes.
 */
export function recordedDigest(path: string): { bundleDigest?: string } {
  const digest = digestOf(path)
  return digest === undefined ? {} : { bundleDigest: digest }
}

export function digestOf(path: string, budgetMs?: number): string | undefined {
  const outcome = budgetMs === undefined ? bundleDigest(path) : bundleDigest(path, budgetMs)
  return outcome.status === "digested" ? outcome.digest : undefined
}

/**
 * The run's infrastructure-failure reason, asserted rather than assumed.
 *
 * `TestRunSummary` is a union and `reason` lives only on the arm that has one.
 * A test reading it after checking `outcome` with `expect` is reading a field
 * the type does not offer — `expect` is a runtime assertion, and nothing about
 * it narrows the value for the line below (issue #74).
 */
export function infrastructureReason(result: TestToolResult): string {
  if (!isTestRunSummary(result)) throw new Error(`expected a Test Run, got ${result.outcome}`)
  if (result.outcome !== "infrastructureFailed") {
    throw new Error(`expected infrastructureFailed, got ${result.outcome}`)
  }
  return result.reason
}

/** The summary, asserted to be one, so its Test Run fields are readable. */
export function summaryOf(result: TestToolResult): TestRunSummary {
  if (!isTestRunSummary(result)) throw new Error(`expected a Test Run, got ${result.outcome}`)
  return result
}

/** The phase an interruption was reported in, on a run that reports one. */
export function interruption(result: TestToolResult): string | undefined {
  if (!isTestRunSummary(result)) throw new Error(`expected a Test Run, got ${result.outcome}`)
  return result.outcome === "cancelled" ? result.interruptionPhase : undefined
}
