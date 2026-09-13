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
  TestToolResult,
} from "../../src/domain/result.ts"
import { SCHEMA_VERSION } from "../../src/domain/result.ts"
import { FAILED_EXIT, interpretFixture, type ScenarioOverrides } from "../interpreter/harness.ts"

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
