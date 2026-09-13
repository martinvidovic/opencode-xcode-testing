/**
 * ADR 0001 Layer 4: the runner + interpreter acceptance gate.
 *
 * Driven through a harness rather than through OpenCode — adapter validation is
 * (b1) and (b2)'s job. What this proves is the seam that matters most: a real
 * `xcodebuild` run, a real Result Bundle, and the interpreter's classification
 * of it, including the cases a naive wrapper gets wrong.
 *
 * The zero-match scenario is the reason this gate exists at all. `xcodebuild`
 * exits successfully when `-only-testing` matches nothing, so a tool that
 * trusted the exit code would report a green run in which not one test ran.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Destination, TestRunRequest } from "../../src/domain/request.ts"
import type { TestToolResult } from "../../src/domain/result.ts"
import type { ToolchainIdentity } from "../../src/domain/toolchain.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"
import { createTestToolService } from "../../src/adapter/service.ts"
import { prepareStorage, storageFor } from "../../src/runner/paths.ts"
import { loadCursorSecret } from "../../src/runner/secrets.ts"
import { FIXTURE, generate } from "../generate-fixture-project.ts"
import type { ScenarioResult } from "./report.ts"

export type Layer4Options = {
  toolchain: ToolchainIdentity
  runtimePath: string
  destination: Destination
  /** A locally owned real project. Runs against it never form the gate. */
  projectOverride?: string
}

const SUPERVISOR_ENTRYPOINT = join(import.meta.dir, "..", "..", "src", "runner", "supervisor-entry.ts")

export async function runLayer4(options: Layer4Options): Promise<ScenarioResult[]> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-gate-"))
  const homeDir = join(workspace, "home")
  mkdirSync(homeDir, { recursive: true })

  try {
    const results: ScenarioResult[] = []
    const passing = prepareProject(join(workspace, "passing"), "passing", options)
    const broken = prepareProject(join(workspace, "build-failed"), "buildFailed", options)

    const service = serviceFor(passing, homeDir, options)

    const passed = await timed("passing run", () =>
      service.start(scoped(FIXTURE.passingSuite), noop).result,
    )
    results.push(
      expect(passed, "passing run", (result) =>
        outcomeOf(result) === "passed"
          ? undefined
          : `expected passed, got ${describe(result)}`,
      ),
    )

    const failed = await timed("failing run", () =>
      service.start(scoped(FIXTURE.failingSuite), noop).result,
    )
    results.push(
      expect(failed, "failing run", (result) =>
        outcomeOf(result) === "testFailed"
          ? undefined
          : `expected testFailed, got ${describe(result)}`,
      ),
    )

    const zeroMatch = await timed("zero-match detection", () =>
      service.start(scoped("NoSuchSuiteExists"), noop).result,
    )
    results.push(
      expect(zeroMatch, "zero-match detection", (result) => {
        // The contract is narrow and deliberate: never `passed`. Xcode exits
        // zero here, so an exit-code wrapper would report a green empty run.
        if (outcomeOf(result) === "passed") return "a run that matched no tests was reported as passed"
        return undefined
      }),
    )

    const brokenService = serviceFor(broken, homeDir, options)
    const buildFailed = await timed("buildFailed", () =>
      brokenService.start({ requestedScope: { kind: "all" } }, noop).result,
    )
    results.push(
      expect(buildFailed, "buildFailed", (result) =>
        outcomeOf(result) === "buildFailed"
          ? undefined
          : `expected buildFailed, got ${describe(result)}`,
      ),
    )

    results.push(await inspectionScenario(service, failed))
    results.push(await pagingScenario(service, passed))

    // Report-only, per ADR 0001: these are timing-sensitive by nature, and
    // #11's stub suite already proves the supervision machinery deterministically.
    results.push(await cancellationScenario(service))
    results.push(await timeoutScenario(service))

    return results
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

// --- scenarios ------------------------------------------------------------

async function inspectionScenario(
  service: ReturnType<typeof createTestToolService>,
  failed: TestToolResult,
): Promise<ScenarioResult> {
  if (!isTestRunSummary(failed)) {
    return fail("inspection without rerun", "the failing run produced no run id to inspect")
  }

  const response = await service.inspect({ runId: failed.runId, facet: "failures" })
  if (response.status !== "available" && response.status !== "incomplete") {
    return fail("inspection without rerun", `the failures facet returned ${response.status}`)
  }

  const records = (response.data as { records: unknown[] }).records
  return records.length > 0
    ? pass("inspection without rerun", `${records.length} failure record(s) read from the retained bundle`)
    : fail("inspection without rerun", "the failures facet was empty for a failing run")
}

async function pagingScenario(
  service: ReturnType<typeof createTestToolService>,
  failed: TestToolResult,
): Promise<ScenarioResult> {
  if (!isTestRunSummary(failed)) {
    return fail("capped and cursor inspection", "no run id to page through")
  }

  const first = await service.inspect({ runId: failed.runId, facet: "tests", limit: 1 })
  if (first.status !== "available") {
    return fail("capped and cursor inspection", `the tests facet returned ${first.status}`)
  }

  const cursor = first.truncation.nextCursor
  if (cursor === undefined) {
    // One test in the suite is a legitimate shape; the cap still applied.
    return pass("capped and cursor inspection", "a single page covered the facet; the cap applied")
  }

  const second = await service.inspect({ runId: failed.runId, facet: "tests", limit: 1, cursor })
  if (second.status !== "available") {
    return fail("capped and cursor inspection", `the cursor returned ${second.status}`)
  }

  const firstIds = ids(first.data)
  const secondIds = ids(second.data)
  return firstIds.some((id) => secondIds.includes(id))
    ? fail("capped and cursor inspection", "the cursor returned a record the first page already had")
    : pass("capped and cursor inspection", "paging advanced without repeating a record")
}

/**
 * A real `xcodebuild` cancellation. Report-only: how long a real toolchain
 * takes to notice a signal is not something a gate should assert on.
 */
async function cancellationScenario(
  service: ReturnType<typeof createTestToolService>,
): Promise<ScenarioResult> {
  let abort: () => void = () => {}
  const whenAborted = new Promise<void>((resolve) => {
    abort = resolve
  })
  let aborted = false

  const handle = service.start({ requestedScope: { kind: "all" } }, noop, {
    get aborted() {
      return aborted
    },
    whenAborted,
  })

  await handle.admitted.catch(() => undefined)
  setTimeout(() => {
    aborted = true
    abort()
  }, 1_500)

  const started = Date.now()
  const result = await handle.result
  const outcome = describe(result)

  return {
    name: "real cancellation",
    kind: "report-only",
    status: outcome === "cancelled" ? "passed" : "failed",
    detail: `observed ${outcome} after ${Date.now() - started}ms`,
    durationMs: Date.now() - started,
  }
}

/**
 * Real timeout escalation. Also report-only: whether a one-second deadline
 * lands during build or during testing depends on how warm the machine is.
 */
async function timeoutScenario(
  service: ReturnType<typeof createTestToolService>,
): Promise<ScenarioResult> {
  const started = Date.now()
  const result = await service.start(
    { requestedScope: { kind: "all" }, timeoutSeconds: 1 },
    noop,
  ).result

  const outcome = describe(result)
  return {
    name: "timeout escalation",
    kind: "report-only",
    status: outcome === "timedOut" ? "passed" : "failed",
    detail: `observed ${outcome} after ${Date.now() - started}ms`,
    durationMs: Date.now() - started,
  }
}

function ids(data: unknown): string[] {
  return ((data as { records?: Array<{ id?: string }> }).records ?? []).map((r) => r.id ?? "")
}

// --- harness --------------------------------------------------------------

function prepareProject(
  path: string,
  variant: "passing" | "buildFailed",
  options: Layer4Options,
): string {
  const tree = generate({ out: path, variant })
  mkdirSync(join(tree.root, ".opencode"), { recursive: true })
  writeFileSync(
    join(tree.root, ".opencode", "xcode-test.json"),
    `${JSON.stringify(
      { schemaVersion: 1, scheme: FIXTURE.scheme, destination: options.destination },
      null,
      2,
    )}\n`,
  )
  return tree.root
}

function serviceFor(trustedRoot: string, homeDir: string, options: Layer4Options) {
  const storage = storageFor(homeDir, trustedRoot)
  prepareStorage(storage)

  return createTestToolService({
    storage,
    trustedRoot,
    homeDir,
    configuration: {
      schemaVersion: 1,
      scheme: FIXTURE.scheme,
      destination: options.destination,
    },
    toolchain: options.toolchain,
    runtimePath: options.runtimePath,
    supervisorEntrypoint: SUPERVISOR_ENTRYPOINT,
    now: () => Number(process.hrtime.bigint() / 1_000_000n),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: loadCursorSecret(storage),
  })
}

function scoped(suite: string): TestRunRequest {
  return {
    requestedScope: { kind: "selected", tests: [{ bundle: FIXTURE.testTarget, suite }] },
  }
}

const noop = { onState: () => {} }

// --- result helpers -------------------------------------------------------

let lastDurationMs = 0

async function timed<T>(_name: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    return await work()
  } finally {
    lastDurationMs = Date.now() - started
  }
}

function outcomeOf(result: TestToolResult): string {
  return result.outcome
}

function describe(result: TestToolResult): string {
  if (!isTestRunSummary(result)) return `${result.outcome} (no Test Run)`
  if (result.outcome === "infrastructureFailed") return `${result.outcome}/${result.reason}`
  return result.outcome
}

function expect(
  result: TestToolResult,
  name: string,
  check: (result: TestToolResult) => string | undefined,
): ScenarioResult {
  const problem = check(result)
  return problem === undefined
    ? { name, kind: "gating", status: "passed", detail: describe(result), durationMs: lastDurationMs }
    : { name, kind: "gating", status: "failed", detail: problem, durationMs: lastDurationMs }
}

function pass(name: string, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "passed", detail }
}

function fail(name: string, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "failed", detail }
}
