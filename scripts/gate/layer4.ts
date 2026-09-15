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

import { monotonicNow } from "../../src/domain/clock.ts"
import type { ScenarioSink } from "./observations.ts"
import type { TestRunRequest } from "../../src/domain/request.ts"
import type { ExecutionContext } from "./context.ts"
import type { TestToolResult } from "../../src/domain/result.ts"
import type { ToolchainIdentity } from "../../src/domain/toolchain.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"
import type { TestToolOutcome } from "../../src/domain/outcome.ts"
import { createTestToolService } from "../../src/adapter/service.ts"
import { readProjectConfiguration } from "../../src/adapter/trusted-root.ts"
import { prepareStorage, runDirectory, storageFor, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import { loadCursorSecret } from "../../src/runner/secrets.ts"
import { examineBundle, type BundleExamination } from "../freshness-check.ts"
import { FIXTURE, generate } from "../generate-fixture-project.ts"
import { safeDiagnostic } from "./diagnostic.ts"
import { SCENARIO } from "./scenarios.ts"
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
  /**
   * What to do with a failed run's evidence.
   *
   * A port rather than a call to `forensics.ts`, because it is the one thing
   * in here that writes outside the workspace. Naming it in the signature is
   * what lets the gate decide the policy and a test observe the decision,
   * rather than this file reaching into the user's home on its own account.
   *
   * It is told where the evidence is and nothing else. Which run this is and
   * when it started are the caller's own facts, and handing them back would
   * make this file responsible for keeping them.
   */
  keepEvidence(source: string): void
}

const SUPERVISOR_ENTRYPOINT = join(import.meta.dir, "..", "..", "src", "runner", "supervisor-entry.ts")

/**
 * Run the Layer 4 scenarios against a real simulator.
 *
 * `record` is called as each scenario finishes, not once at the end. This
 * suite drives real `xcodebuild` invocations, so it is the likeliest place in
 * the gate for something to throw — and every scenario before the throw is a
 * fact about this machine that stays true.
 *
 * What comes back is the **examination** of the Result Bundle, not its path.
 * Every artifact this function creates lives in a workspace it deletes on the
 * way out, so a path handed to a later caller would name a directory that no
 * longer exists — exactly the bug the first version of this had, and which
 * the gate's own report caught.
 */
export async function runLayer4(
  options: Layer4Options,
  record: ScenarioSink,
): Promise<BundleExamination | undefined> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-gate-"))
  const homeDir = join(workspace, "home")
  mkdirSync(homeDir, { recursive: true })

  // Watched on the way past rather than asked for at the end, for the same
  // reason the sink exists: the end is what a run that throws does not reach,
  // and a throw is precisely when the evidence is worth keeping.
  let anyFailed = false
  const watch: ScenarioSink = (result) => {
    if (countsAsFailure(result)) anyFailed = true
    record(result)
  }
  let threw = false

  try {
    const passing = prepareProject(join(workspace, "passing"), "passing", options)
    const broken = prepareProject(join(workspace, "build-failed"), "buildFailed", options)

    const service = serviceFor(passing, homeDir, { ...options, configured: "fixture" })

    const passed = await timed(SCENARIO["passing run"], () =>
      service.start(scoped(FIXTURE.passingSuite), noop).result,
    )
    watch(
      expect(passed, SCENARIO["passing run"], (result) =>
        outcomeOf(result) === "passed"
          ? undefined
          : `expected passed, got ${describe(result)}`,
      ),
    )

    const failed = await timed(SCENARIO["failing run"], () =>
      service.start(scoped(FIXTURE.failingSuite), noop).result,
    )
    watch(
      expect(failed, SCENARIO["failing run"], (result) =>
        outcomeOf(result) === "testFailed"
          ? undefined
          : `expected testFailed, got ${describe(result)}`,
      ),
    )

    const zeroMatch = await timed(SCENARIO["zero-match detection"], () =>
      service.start(scoped("NoSuchSuiteExists"), noop).result,
    )
    watch(
      expect(zeroMatch, SCENARIO["zero-match detection"], (result) => {
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
    const buildFailed = await timed(SCENARIO["buildFailed"], () =>
      brokenService.start({ requestedScope: { kind: "all" } }, noop).result,
    )
    watch(
      expect(buildFailed, SCENARIO["buildFailed"], (result) =>
        outcomeOf(result) === "buildFailed"
          ? undefined
          : `expected buildFailed, got ${describe(result)}`,
      ),
    )

    watch(await inspectionScenario(service, failed))
    watch(await pagingScenario(service, passed))

    // Report-only, per ADR 0001: these are timing-sensitive by nature, and
    // #11's stub suite already proves the supervision machinery deterministically.
    watch(await cancellationScenario(service))
    watch(await timeoutScenario(service))

    if (options.project !== undefined) {
      for (const scenario of await projectScenarios(options.project, homeDir, options)) {
        watch(scenario)
      }
    }

    // Examined here, while the bundle still exists.
    const bundlePath = bundleOf(homeDir, passing, passed)
    return bundlePath === undefined ? undefined : examineBundle(bundlePath)
  } catch (error) {
    threw = true
    throw error
  } finally {
    // A passing run leaves nothing: its workspace is regenerable and its
    // evidence proves only what the report already says. A failing one leaves
    // the Run Records, logs, index and Result Bundles that are the difference
    // between knowing something broke and knowing what.
    if (anyFailed || threw) {
      // The storage root rather than the temp home above it, so the preserved
      // tree opens onto `roots/` and `registry/` instead of three levels of
      // `Library/Application Support` that say nothing.
      options.keepEvidence(storageFor(homeDir, workspace).toolRoot)
    }
    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * Whether this result makes the run one worth keeping evidence for.
 *
 * Report-only results are deliberately excluded, and that is the whole reason
 * this is a named rule rather than a condition. Cancellation and timeout are
 * report-only per ADR 0001 because they are timing-sensitive by nature, and a
 * run whose only disappointment was one of those has *passed* — keeping a
 * Result Bundle for it would fill the store from green runs.
 */
export function countsAsFailure(result: ScenarioResult): boolean {
  return result.kind === "gating" && result.status === "failed"
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
    return fail(SCENARIO["inspection without rerun"], "the failing run produced no run id to inspect")
  }

  const response = await service.inspect({ runId: failed.runId, facet: "failures" })
  if (response.status !== "available") {
    return fail(SCENARIO["inspection without rerun"], `the failures facet returned ${response.status}`)
  }

  const records = (response.data as { records: Array<{ id: string }> }).records
  if (records.length === 0) {
    return fail(SCENARIO["inspection without rerun"], "the failures facet was empty for a failing run")
  }

  // The summary already named its failures. Reading them again from retained
  // evidence must produce the *same* diagnostics: a facet that reran anything
  // would be reporting a second, different Test Run under the first one's id,
  // and identical-looking output is exactly how that would go unnoticed.
  const summarised = failed.diagnostics.testFailures.map((entry) => entry.id)
  const shared = records.map((record) => record.id).filter((id) => summarised.includes(id))
  if (shared.length === 0) {
    return fail(
      SCENARIO["inspection without rerun"],
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
    return fail(SCENARIO["inspection without rerun"], `focusing a diagnostic returned ${focused.status}`)
  }
  const page = focused.data as {
    view?: string
    reason?: string
    focused?: { id?: string; message?: string }
  }

  // Distinguished from a wrong record on purpose. A withheld view means the
  // record was found and will not fit the cap, which is a correct answer about
  // this gate's fixture only if the fixture has become enormous — so it is a
  // failure, and it says the right thing about why.
  if (page.view === "omitted") {
    return fail(SCENARIO["inspection without rerun"], `the Focused Detail was withheld: ${page.reason ?? ""}`)
  }
  if (page.focused?.id !== first.id) {
    return fail(SCENARIO["inspection without rerun"], "focusing a diagnostic did not return that diagnostic")
  }

  return pass(
    SCENARIO["inspection without rerun"],
    `${records.length} failure record(s) and focused detail read from the retained bundle; ${shared.length} id(s) match the summary`,
  )
}

async function pagingScenario(
  service: ReturnType<typeof createTestToolService>,
  passed: TestToolResult,
): Promise<ScenarioResult> {
  if (!isTestRunSummary(passed)) {
    return fail(SCENARIO["capped and cursor inspection"], "no run id to page through")
  }

  const all = await service.inspect({ runId: passed.runId, facet: "tests", limit: 100 })
  if (all.status !== "available") {
    return fail(SCENARIO["capped and cursor inspection"], `the tests facet returned ${all.status}`)
  }
  const single = (all.data as { records: Array<{ id: string }> }).records.map((r) => r.id)
  if (single.length < 2) {
    return fail(
      SCENARIO["capped and cursor inspection"],
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
      return fail(SCENARIO["capped and cursor inspection"], `page ${page} returned ${response.status}`)
    }

    const records = (response.data as { records: Array<{ id: string }> }).records
    if (records.length !== 1) {
      return fail(SCENARIO["capped and cursor inspection"], `page ${page} returned ${records.length} records`)
    }
    seen.push((records[0] as { id: string }).id)

    if (!response.truncation.hasMore) break

    const next = response.truncation.nextCursor
    if (next === undefined || next === cursor) {
      return fail(SCENARIO["capped and cursor inspection"], `page ${page} did not advance its cursor`)
    }
    cursor = next
  }

  if (seen.length !== single.length) {
    return fail(
      SCENARIO["capped and cursor inspection"],
      `paging one at a time yielded ${seen.length} of ${single.length} records`,
    )
  }
  if (new Set(seen).size !== seen.length) {
    return fail(SCENARIO["capped and cursor inspection"], "paging returned the same record twice")
  }
  if (seen.join(",") !== single.join(",")) {
    return fail(SCENARIO["capped and cursor inspection"], "paged order differs from a single page's order")
  }

  return pass(
    SCENARIO["capped and cursor inspection"],
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
    name: SCENARIO["supplied project run"],
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
const HEALTHY_OUTCOMES: readonly TestToolOutcome[] = ["passed", "testFailed", "buildFailed"]

export function isHealthyOutcome(outcome: TestToolOutcome): boolean {
  return HEALTHY_OUTCOMES.includes(outcome)
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
    name: SCENARIO["real cancellation"],
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
    name: SCENARIO["timeout escalation"],
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
    now: monotonicNow,
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
