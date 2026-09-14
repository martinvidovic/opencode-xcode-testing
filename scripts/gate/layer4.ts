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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TestRunRequest } from "../../src/domain/request.ts"
import type { ExecutionContext } from "./context.ts"
import type { TestToolResult } from "../../src/domain/result.ts"
import type { ToolchainIdentity } from "../../src/domain/toolchain.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"
import { createTestToolService } from "../../src/adapter/service.ts"
import { readProjectConfiguration } from "../../src/adapter/trusted-root.ts"
import { prepareStorage, runDirectory, storageFor, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import { loadCursorSecret } from "../../src/runner/secrets.ts"
import { examineBundle, type BundleExamination } from "../freshness-check.ts"
import { FIXTURE, generate } from "../generate-fixture-project.ts"
import { safeDiagnostic } from "./diagnostic.ts"
import type { ScenarioResult } from "./report.ts"

/**
 * Layer 4's own context: the shared one, plus the project override that only
 * this layer runs.
 */
export type Layer4Options = ExecutionContext & {
  /**
   * A locally owned real project to additionally run against.
   *
   * ADR 0001 is precise about what this means: "`--project` runs must pass if
   * invoked but do not form the gate." Not forming the gate is about the
   * *standing* gate — a machine without this project is not failing — and not
   * about tolerating a failure in front of someone who explicitly asked for
   * it. So these scenarios gate when they run, and only run when asked for.
   */
  project?: string
}

const SUPERVISOR_ENTRYPOINT = join(import.meta.dir, "..", "..", "src", "runner", "supervisor-entry.ts")

/**
 * The scenarios, and what a real Result Bundle they produced actually
 * contained.
 *
 * The **examination** travels out, not the path. Every artifact this function
 * creates lives in a workspace it deletes on the way out, so a path handed to
 * a later caller would name a directory that no longer exists — which is
 * exactly the bug the first version of this had, and which the gate's own
 * report caught.
 */
export type Layer4Outcome = { scenarios: ScenarioResult[]; bundle?: BundleExamination }

export async function runLayer4(options: Layer4Options): Promise<Layer4Outcome> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-gate-"))
  const homeDir = join(workspace, "home")
  mkdirSync(homeDir, { recursive: true })

  try {
    const results: ScenarioResult[] = []
    const passing = prepareProject(join(workspace, "passing"), "passing", options)
    const broken = prepareProject(join(workspace, "build-failed"), "buildFailed", options)

    const service = serviceFor(passing, homeDir, { ...options, configured: "fixture" })

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
        // The exact contract, not merely "not passed". Xcode exits zero here,
        // so an exit-code wrapper reports a green empty run — but so does a
        // tool that notices something is wrong and says the wrong thing about
        // it. The reason is what tells a caller their selection was the
        // problem rather than their code.
        if (!isTestRunSummary(result)) return `expected a Test Run, got ${describe(result)}`
        if (result.outcome !== "infrastructureFailed" || result.reason !== "scopeMismatch") {
          return `expected infrastructureFailed/scopeMismatch, got ${describe(result)}`
        }
        if (result.scope.verdict !== "mismatched") {
          return `expected a mismatched scope verdict, got ${result.scope.verdict}`
        }
        // Nothing ran, and the summary must say so rather than leaving the
        // counts to be read as "zero tests, all passing".
        const total = result.tests.counts?.total ?? 0
        return total === 0 ? undefined : `expected no observed tests, got ${total}`
      }),
    )

    const brokenService = serviceFor(broken, homeDir, { ...options, configured: "fixture" })
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

    if (options.project !== undefined) {
      results.push(...(await projectScenarios(options.project, homeDir, options)))
    }

    // Examined here, while the bundle still exists.
    const bundlePath = bundleOf(homeDir, passing, passed)
    return {
      scenarios: results,
      ...(bundlePath === undefined ? {} : { bundle: examineBundle(bundlePath) }),
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** Where the passing run's Result Bundle was retained, if it produced one. */
function bundleOf(homeDir: string, trustedRoot: string, result: TestToolResult): string | undefined {
  if (!isTestRunSummary(result)) return undefined
  const path = join(
    runDirectory(storageFor(homeDir, trustedRoot), result.runId),
    RUN_ARTIFACTS.resultBundle,
  )
  return existsSync(path) ? path : undefined
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
  if (response.status !== "available") {
    return fail("inspection without rerun", `the failures facet returned ${response.status}`)
  }

  const records = (response.data as { records: Array<{ id: string }> }).records
  if (records.length === 0) {
    return fail("inspection without rerun", "the failures facet was empty for a failing run")
  }

  // The summary already named its failures. Reading them again from retained
  // evidence must produce the *same* diagnostics: a facet that reran anything
  // would be reporting a second, different Test Run under the first one's id,
  // and identical-looking output is exactly how that would go unnoticed.
  const summarised = failed.diagnostics.testFailures.map((entry) => entry.id)
  const shared = records.map((record) => record.id).filter((id) => summarised.includes(id))
  if (shared.length === 0) {
    return fail(
      "inspection without rerun",
      "the retained failures share no diagnostic id with the summary, so they describe a different run",
    )
  }

  // And focusing must reach the detail a page deliberately caps.
  const first = records[0] as { id: string }
  const focused = await service.inspect({
    runId: failed.runId,
    facet: "failures",
    diagnosticId: first.id,
  })
  if (focused.status !== "available" && focused.status !== "incomplete") {
    return fail("inspection without rerun", `focusing a diagnostic returned ${focused.status}`)
  }
  const detail = (focused.data as { focused?: { id?: string; message?: string } }).focused
  if (detail?.id !== first.id) {
    return fail("inspection without rerun", "focusing a diagnostic did not return that diagnostic")
  }

  return pass(
    "inspection without rerun",
    `${records.length} failure record(s) and focused detail read from the retained bundle; ${shared.length} id(s) match the summary`,
  )
}

async function pagingScenario(
  service: ReturnType<typeof createTestToolService>,
  passed: TestToolResult,
): Promise<ScenarioResult> {
  if (!isTestRunSummary(passed)) {
    return fail("capped and cursor inspection", "no run id to page through")
  }

  const all = await service.inspect({ runId: passed.runId, facet: "tests", limit: 100 })
  if (all.status !== "available") {
    return fail("capped and cursor inspection", `the tests facet returned ${all.status}`)
  }
  const single = (all.data as { records: Array<{ id: string }> }).records.map((r) => r.id)
  if (single.length < 2) {
    return fail(
      "capped and cursor inspection",
      `the fixture project must run at least two tests to page through; it ran ${single.length}`,
    )
  }

  // One record at a time, to the end. The assertion is the whole sequence,
  // not that two pages differ: every record exactly once, in the order a
  // single page gives them, with a cursor that always moves and stops exactly
  // when the records run out.
  const seen: string[] = []
  let cursor: string | undefined

  for (let page = 0; page <= single.length; page += 1) {
    const response = await service.inspect({
      runId: passed.runId,
      facet: "tests",
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    })
    if (response.status !== "available") {
      return fail("capped and cursor inspection", `page ${page} returned ${response.status}`)
    }

    const records = (response.data as { records: Array<{ id: string }> }).records
    if (records.length !== 1) {
      return fail("capped and cursor inspection", `page ${page} returned ${records.length} records`)
    }
    seen.push((records[0] as { id: string }).id)

    if (!response.truncation.hasMore) break

    const next = response.truncation.nextCursor
    if (next === undefined || next === cursor) {
      return fail("capped and cursor inspection", `page ${page} did not advance its cursor`)
    }
    cursor = next
  }

  if (seen.length !== single.length) {
    return fail(
      "capped and cursor inspection",
      `paging one at a time yielded ${seen.length} of ${single.length} records`,
    )
  }
  if (new Set(seen).size !== seen.length) {
    return fail("capped and cursor inspection", "paging returned the same record twice")
  }
  if (seen.join(",") !== single.join(",")) {
    return fail("capped and cursor inspection", "paged order differs from a single page's order")
  }

  return pass(
    "capped and cursor inspection",
    `${single.length} record(s) paged one at a time, each exactly once and in a single page's order`,
  )
}

/**
 * The same seam, against a project this machine happens to own.
 *
 * What this proves is narrower than the fixture scenarios and still worth
 * having: that the adapter resolves, admits, runs and classifies against a
 * project nobody generated — a real scheme, a real destination, real tests.
 *
 * The project's own `.opencode/xcode-test.json` is what configures it.
 * Forcing the fixture's scheme onto someone else's project would fail scheme
 * resolution on nearly every real repository, which is not a finding about
 * anything.
 */
async function projectScenarios(
  project: string,
  homeDir: string,
  options: Layer4Options,
): Promise<ScenarioResult[]> {
  const started = Date.now()
  const scenario = (status: "passed" | "failed", detail: string): ScenarioResult => ({
    name: "supplied project run",
    // Gating, per ADR 0001: "`--project` runs must pass if invoked but do not
    // form the gate." Somebody who named a project wants to be told.
    kind: "gating",
    status,
    detail,
    durationMs: Date.now() - started,
  })

  try {
    const service = serviceFor(project, homeDir, { ...options, configured: undefined })
    const result = await service.start({ requestedScope: { kind: "all" } }, noop).result

    // Reaching *a* classified outcome is not the bar. An
    // `infrastructureFailed` run reached one and says the tool did not work,
    // which is exactly what this scenario exists to find out — and a gate that
    // counted it as a pass would report green on the one result that matters.
    //
    // What is *not* judged is the project: passing, failing, and failing to
    // build are all the tool working, and which of them a real repository
    // reaches is its own business.
    if (!isTestRunSummary(result)) {
      return [scenario("failed", `reached no Test Run: ${describe(result)}`)]
    }
    return [
      isHealthyOutcome(result.outcome)
        ? scenario("passed", `${describe(result)}; ${result.tests.counts?.total ?? 0} test(s) observed`)
        : scenario("failed", `the tool did not complete the run: ${describe(result)}`),
    ]
  } catch (error) {
    return [scenario("failed", `the run could not be driven: ${safeDiagnostic(error)}`)]
  }
}

/**
 * Outcomes that mean the tool did its job, whatever the project's code did.
 *
 * The other outcomes — `infrastructureFailed`, `timedOut`, `cancelled`,
 * `invalid` — are not answers about the project at all. They say this tool
 * could not produce one, which on a real repository is the finding a
 * `--project` run exists to surface.
 */
const HEALTHY_OUTCOMES = ["passed", "testFailed", "buildFailed"] as const

export function isHealthyOutcome(outcome: string): boolean {
  return (HEALTHY_OUTCOMES as readonly string[]).includes(outcome)
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

// --- harness --------------------------------------------------------------

function prepareProject(
  path: string,
  variant: "passing" | "buildFailed",
  options: ExecutionContext,
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

/**
 * `configured: undefined` means "let the project speak for itself": the
 * generated fixture is configured from here because the gate generated it,
 * and a supplied project is not.
 */
function serviceFor(
  trustedRoot: string,
  homeDir: string,
  options: ExecutionContext & { configured?: undefined | "fixture" },
) {
  const storage = storageFor(homeDir, trustedRoot)
  prepareStorage(storage)

  return createTestToolService({
    storage,
    trustedRoot,
    homeDir,
    configuration:
      options.configured === undefined
        ? readProjectConfiguration(trustedRoot)
        : {
            status: "loaded",
            configuration: {
              schemaVersion: 1,
              scheme: FIXTURE.scheme,
              destination: options.destination,
            },
          },
    toolchain: options.toolchain,
    runtime: { path: options.runtimePath },
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
