/**
 * The three tool implementations (ADR 0002).
 *
 * Two rules govern every path here.
 *
 * **Never throw for a domain outcome.** `invalid`, `cancelled`,
 * `infrastructureFailed`, queued failures and `timedOut` all render as ordinary
 * output. This follows from a host fact rather than taste: a thrown error
 * becomes an `output-error` part in which the model sees only the message —
 * title, metadata and attachments are discarded and `tool.execute.after` never
 * fires — so throwing a domain outcome would destroy exactly the evidence #7
 * exists to deliver. Throwing is reserved for adapter defects, and those
 * messages carry no paths or private identifiers.
 *
 * **Cancellation is bounded but never abandons the run.** The abort wait covers
 * #3's termination window. If terminal publication lands inside it, the real
 * summary is returned; otherwise the tool returns `cancelled` with `unknown`
 * where facts are still pending, plus the run id — and the supervisor finalizes
 * the run regardless, so the model can inspect the terminal summary afterwards.
 * Holding the wait open through the full interpretation budget to render
 * evidence that inspection can deliver later would be a worse trade.
 */

import type { InspectionResponse, InspectRunRequest } from "../domain/inspection.ts"
import type { ResolvedTestRun, TestRunRequest } from "../domain/request.ts"
import type { TestRunCancelled, TestToolResult } from "../domain/result.ts"
import { SCHEMA_VERSION } from "../domain/result.ts"
import { requestedScopeDigest, type RequestedScope } from "../domain/scope.ts"
import type { RecoveryStatus } from "../runner/recovery.ts"
import type { Budget } from "./budget.ts"
import { DEFAULT_BUDGET } from "./budget.ts"
import { block, field, PRIORITY } from "./document.ts"
import { serialize } from "./budget.ts"
import { renderTestToolResult } from "./output.ts"

/** Covers #3's bounded termination window — roughly 25s escalation plus drain. */
export const ABORT_WAIT_MS = 30_000

/** Durable protocol states only. There are deliberately no inferred phases. */
export const PROTOCOL_STATES = [
  "admitted",
  "supervisorReady",
  "launchAuthorized",
  "executionCompleted",
  "interpreting",
] as const

export type ProtocolState = (typeof PROTOCOL_STATES)[number]

export type AdmittedRun = {
  runId: string
  resolved: ResolvedTestRun
  admittedAt: string
  queueDurationMs: number
}

export type RunHandle = {
  /** Resolves once the run holds the execution slot and has an id. */
  admitted: Promise<AdmittedRun>
  result: Promise<TestToolResult>
}

export type TestToolService = {
  start(request: TestRunRequest, hooks: { onState(state: ProtocolState): void }): RunHandle
  inspect(request: InspectRunRequest): Promise<InspectionResponse<unknown>>
  recover(): Promise<{ status: RecoveryStatus; message?: string }>
}

/** The slice of the host's tool context the adapter actually uses. */
export type ToolContext = {
  abort?: { readonly aborted: boolean; addEventListener?(type: "abort", handler: () => void): void }
  /**
   * Human- and TUI-facing only. No fact may exist only here; `runId` is the one
   * deliberate mirror.
   */
  metadata?(update: { title?: string; metadata?: Record<string, unknown> }): void
}

export type ToolDeps = {
  service: TestToolService
  budget?: Budget
  /** Monotonic, for the abort wait and for elapsed metadata. */
  now(): number
  sleep(ms: number): Promise<void>
  timestamp(): string
  abortWaitMs?: number
}

// --- xcode_test -----------------------------------------------------------

export async function executeTest(
  request: TestRunRequest,
  context: ToolContext,
  deps: ToolDeps,
): Promise<string> {
  const budget = deps.budget ?? DEFAULT_BUDGET
  const startedAt = deps.now()

  const publish = (state: ProtocolState, runId?: string) => {
    context.metadata?.({
      metadata: {
        state,
        elapsedMs: deps.now() - startedAt,
        ...(runId === undefined ? {} : { runId }),
      },
    })
  }

  const handle = deps.service.start(request, { onState: (state) => publish(state) })
  void handle.admitted.then((admitted) => publish("admitted", admitted.runId)).catch(() => {})

  const settled = await raceAbort(handle.result, context, deps)
  if (settled.status === "settled") {
    return renderTestToolResult(settled.value, budget).text
  }

  // Aborted. Give terminal publication the bounded window it needs.
  const waited = await waitFor(handle.result, deps.abortWaitMs ?? ABORT_WAIT_MS, deps)
  if (waited.status === "settled") {
    return renderTestToolResult(waited.value, budget).text
  }

  const admitted = await settledOrUndefined(handle.admitted)
  if (admitted === undefined) {
    // Cancelled before the run ever held the slot: there is nothing to inspect.
    return renderTestToolResult(
      {
        schemaVersion: SCHEMA_VERSION,
        outcome: "cancelled",
        phase: "queued",
      },
      budget,
    ).text
  }

  return renderTestToolResult(
    pendingCancellation(admitted, request.requestedScope, deps.now() - startedAt),
    budget,
  ).text
}

/**
 * A `cancelled` summary whose still-pending facts say `unknown` rather than
 * guessing. The run id is present, so the caller can read the real terminal
 * summary once the supervisor has finished publishing it.
 */
export function pendingCancellation(
  admitted: AdmittedRun,
  scope: RequestedScope,
  elapsedMs: number,
): TestRunCancelled {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: admitted.runId,
    resolved: admitted.resolved,
    scope: {
      kind: scope.kind,
      digest: requestedScopeDigest(scope),
      requestedSelectionCount: scope.kind === "selected" ? scope.tests.length : 0,
      verdict: "unverifiable",
      attestations: [],
      shown: 0,
      truncated: false,
    },
    timing: {
      admittedAt: admitted.admittedAt,
      queueDurationMs: admitted.queueDurationMs,
      totalDurationMs: elapsedMs,
    },
    terminationTrigger: "callerCancellation",
    termination: {
      requested: "yes",
      gracefulTerminationObserved: "unknown",
      forceEscalationRequired: "unknown",
      terminationGraceExceeded: "unknown",
      descendantsConfirmedExited: "unknown",
    },
    execution: { execObserved: "unknown", successfulExit: "unknown" },
    build: { completeness: "unavailable" },
    tests: { completeness: "unavailable" },
    inspection: {
      scope: "unavailable",
      failures: "unavailable",
      buildErrors: "unavailable",
      tests: "unavailable",
      log: "unavailable",
    },
    outcome: "cancelled",
    interruptionPhase: "unknown",
    diagnostics: {
      testFailures: [],
      testFailureSection: { total: 0, shown: 0, truncated: false },
      buildErrors: [],
      buildErrorSection: { total: 0, shown: 0, truncated: false },
      observedTests: [],
      observedTestSection: { total: 0, shown: 0, truncated: false },
    },
  }
}

// --- xcode_test_inspect ---------------------------------------------------

/**
 * Inspection ignores abort. It is a bounded operation under a short read lease
 * whose result lands in session history, so completing it is strictly more
 * useful than discarding it — this is adapter behavior, not a contract change.
 */
export async function executeInspect(
  request: InspectRunRequest,
  _context: ToolContext,
  deps: ToolDeps,
): Promise<string> {
  const response = await deps.service.inspect(request)
  return serialize(renderInspection(request, response), deps.budget ?? DEFAULT_BUDGET).text
}

export function renderInspection(
  request: InspectRunRequest,
  response: InspectionResponse<unknown>,
) {
  const header = `Inspection of ${request.facet} for run ${request.runId}: ${response.status}`

  switch (response.status) {
    case "available":
      return [
        block(PRIORITY.envelope, `${header} (${response.completeness})`),
        block(PRIORITY.facts, ...recordLines(response.data), ...truncationLines(response.truncation)),
      ]
    case "incomplete":
      return [
        block(
          PRIORITY.envelope,
          header,
          "",
          "The retained evidence is known to be partial, so an empty page does not prove there are zero records.",
        ),
        block(PRIORITY.facts, ...recordLines(response.data), ...truncationLines(response.truncation)),
      ]
    case "expired":
      return [
        block(
          PRIORITY.envelope,
          header,
          "",
          "This evidence existed and has since been deleted by retention. It cannot be recovered, and rerunning the tests would produce a different run.",
        ),
      ]
    case "notFound":
      return [block(PRIORITY.envelope, `${header} (${response.subject})`)]
    case "unsupported":
      return [
        block(
          PRIORITY.envelope,
          header,
          "",
          "This facet was never produced for this run.",
        ),
      ]
    case "invalid":
      return [block(PRIORITY.envelope, header, "", response.message)]
  }
}

function recordLines(data: unknown): string[] {
  const records = (data as { records?: unknown[] } | undefined)?.records ?? []
  return [
    `records (${records.length}):`,
    ...records.map((record) => `  ${JSON.stringify(record)}`),
  ]
}

function truncationLines(truncation: {
  hasMore: boolean
  nextCursor?: string
  responseTruncated: boolean
}): string[] {
  const lines: string[] = []
  if (truncation.hasMore) lines.push("", field("more", "yes"))
  if (truncation.nextCursor !== undefined) lines.push(field("cursor", truncation.nextCursor))
  if (truncation.responseTruncated) lines.push(field("truncated", "yes"))
  return lines
}

// --- xcode_test_recover ---------------------------------------------------

export async function executeRecover(
  _args: Record<string, never>,
  _context: ToolContext,
  deps: ToolDeps,
): Promise<string> {
  const outcome = await deps.service.recover()
  return serialize(
    [
      block(PRIORITY.envelope, `Recovery: ${outcome.status}`),
      block(PRIORITY.reason, ...(outcome.message === undefined ? [] : ["", outcome.message])),
    ],
    deps.budget ?? DEFAULT_BUDGET,
  ).text
}

// --- waiting --------------------------------------------------------------

type Settled<T> = { status: "settled"; value: T } | { status: "aborted" } | { status: "pending" }

async function raceAbort<T>(
  work: Promise<T>,
  context: ToolContext,
  deps: ToolDeps,
): Promise<Settled<T>> {
  if (context.abort?.aborted === true) return { status: "aborted" }

  const aborted = whenAborted(context, deps)
  const outcome = await Promise.race([work.then((value) => ({ value })), aborted])
  return "value" in outcome ? { status: "settled", value: outcome.value } : { status: "aborted" }
}

async function waitFor<T>(
  work: Promise<T>,
  budgetMs: number,
  deps: ToolDeps,
): Promise<Settled<T>> {
  const expiry = deps.sleep(budgetMs).then(() => EXPIRED)
  const outcome = await Promise.race([work.then((value) => ({ value })), expiry])
  return outcome === EXPIRED ? { status: "pending" } : { status: "settled", value: (outcome as { value: T }).value }
}

const EXPIRED = Symbol("expired")

function whenAborted(context: ToolContext, deps: ToolDeps): Promise<{ aborted: true }> {
  const signal = context.abort
  if (signal === undefined) return new Promise(() => {})

  if (typeof signal.addEventListener === "function") {
    return new Promise((resolve) => {
      signal.addEventListener?.("abort", () => resolve({ aborted: true }))
    })
  }

  // A signal without listener support is polled, so a plain `{ aborted }`
  // object is a usable stand-in in tests and in a host that supplies one.
  return (async () => {
    for (;;) {
      if (signal.aborted) return { aborted: true as const }
      await deps.sleep(25)
    }
  })()
}

async function settledOrUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await Promise.race([work, Promise.resolve(undefined)])
  } catch {
    return undefined
  }
}
