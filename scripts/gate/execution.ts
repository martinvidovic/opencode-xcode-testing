/**
 * (b2) Execution — through a real model turn, against real Xcode.
 *
 * ADR 0002's route, ported to V2 (issue #142): tool execution in the host
 * requires a model turn, so the gate supplies a **local OpenAI-compatible stub
 * provider** that emits scripted tool calls. Deterministic, credential-free,
 * no network — and unlike layer (a) or the Layer 4 harness, this is an
 * isolated V2 host calling our `execute` for real, under the shipped
 * restricted agent, rendering a real Result Bundle under the real budget.
 *
 * A real `testFailed` run is required here specifically because nothing else in
 * the validation stack ever renders realistic diagnostics from a real bundle.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ExecutionContext } from "./context.ts"
import { byteLength, lineCount, resolveBudget } from "../../src/adapter/budget.ts"
import { fieldValue, isField } from "../../src/adapter/document.ts"
import { B2Evidence, worthKeeping, type B2Correlation } from "./b2-evidence.ts"
import type { DrivenRoots } from "./driven-roots.ts"
import type { EvidenceSource } from "./forensics.ts"
import { FIXTURE, generate } from "../generate-fixture-project.ts"
import { startStubProvider, stubProviderConfig, type StubProvider } from "./provider.ts"
import { bootHost, loadClient, observedHostVersion, provenanceProblem, type BootedHost, type HostClient } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { SCENARIO, type ScenarioName } from "./scenarios.ts"
import type { ScenarioResult } from "./report.ts"
import { scriptedTurn } from "./turn.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"

const REPO = join(import.meta.dir, "..", "..")
const TEMPLATES = join(REPO, "examples", "agent")

/** Every call runs under the shipped restricted agent: no shell, no files. */
export const EXECUTING_AGENT = "xcode-test-runner"

/**
 * B2's own context: the shared one, plus the evidence port only this suite has.
 *
 * A port rather than a call into `forensics.ts`, for the reason Layer 4's is
 * one: it is the single thing in here that writes outside the workspace, and
 * naming it in the signature is what lets the gate decide the policy and a
 * test observe the decision. It is told what to keep and which scenario each
 * piece belongs to; when the run started, and therefore what key any of it is
 * filed under, stays with the caller that already knows.
 */
export type ExecutionGateOptions = ExecutionContext & {
  keepEvidence(sources: readonly EvidenceSource[], correlations: readonly B2Correlation[]): void
  /**
   * Where to register the project directories this suite makes the host create.
   *
   * Swept by the caller, once, at the end of the run. A suite that cleaned up
   * after itself raced the host it had just closed — storage kept appearing
   * *after* the sweep, because closing a server does not mean every plugin
   * instance it started has finished writing.
   */
  roots: DrivenRoots
}

/** Records each scenario as it finishes; see `ScenarioSink`. */
export async function runExecutionGate(
  options: ExecutionGateOptions,
  record: ScenarioSink,
): Promise<void> {
  // The same provenance rule b1 applies, and for the same reason (#81): a
  // package tree that disagrees with itself makes whatever this gate proves
  // unattributable to any package set.
  const provenance = provenanceProblem(observedHostVersion())
  if (provenance !== undefined) {
    record(failure(SCENARIO["b2 execution"], provenance))
    return
  }

  // The same loader b1 uses, and for the same reason (issue #80): a missing
  // or broken client fails this gate with the command that fixes it rather
  // than taking the whole run down at module load.
  const loaded = await loadClient()
  if (loaded.status !== "loaded") {
    record(failure(SCENARIO["b2 execution"], loaded.detail))
    return
  }

  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-"))
  let stub: StubProvider | undefined
  let host: BootedHost | undefined

  // Collected as the suite runs, because none of it can be recovered
  // afterwards: the projects are deleted, the host is gone, and the responses
  // that carry a staging failure's own sentence exist only in memory (#98).
  const evidence = new B2Evidence(undefined, options.roots)
  const watched: ScenarioSink = (result) => {
    evidence.watch(result)
    record(result)
  }

  try {
    // Registered as each one is prepared, not after both (#98).
    const passing = evidence.root(prepareProject(join(workspace, "passing"), "passing", options))
    const broken = evidence.root(prepareProject(join(workspace, "build-failed"), "buildFailed", options))

    stub = startStubProvider()
    host = await bootHost({
      workspace,
      config: {
        $schema: "https://opencode.ai/config.json",
        share: "disabled",
        update: "disable",
        // The checkout as a plugin directory, carrying the limits below as an
        // option: the V2 plugin cannot read the host's effective `tool_output`
        // (issue #140), so a user who lowers it tells the plugin too.
        plugins: [{ package: REPO, options: { tool_output: CONFIGURED_LIMITS } }],
        providers: stubProviderConfig(stub.baseURL),
        // Deliberately below the host's defaults (issue #82). The whole claim
        // is that the adapter stays under *the host's* limits rather than
        // under numbers it likes.
        tool_output: CONFIGURED_LIMITS,
      },
      cwd: passing,
      connect: loaded.connect,
    })

    await scenarios(host.client, stub, { passing, broken }, watched, evidence)
  } catch (error) {
    // Beside what already ran, not instead of it.
    watched(failure(SCENARIO["b2 execution"], `the stub-provider route could not be driven: ${safeFailure(error)}`))
  } finally {
    // The host is a child process now, so its own complaints — a plugin that
    // failed to load says so here and only here (#98) — are read off it
    // rather than tee'd from this process.
    if (host !== undefined) evidence.hostOutput(host.output())
    await host?.stop()
    stub?.stop()

    // Kept before anything is removed, and correlated before it is kept. The
    // order is the whole of AC5: the report names an evidence key, and the
    // key has to still be there when someone reads the report.
    if (evidence.failed) {
      options.keepEvidence(
        evidence.sources(workspace).map((source) => ({ ...source, keep: worthKeeping })),
        evidence.correlations(),
      )
    }

    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * Host limits this gate configures, chosen so that at least one of them binds.
 *
 * "Lower than the documented defaults" is not enough on its own. The adapter's
 * self-caps are 1,900 lines and 32 KiB, and a real Test Run response here runs
 * to about sixty lines and four and a half kilobytes — so against a host at
 * 2,000/50 KiB, or at any limit above those, an adapter that ignored the host
 * configuration entirely would pass. A check that cannot fail is not a check.
 *
 * **The byte limit is the one that binds.** At 4 KiB the adapter's budget
 * becomes 2 KiB after its safety margin, and the largest response has to shed
 * blocks to fit; an adapter reading the documented defaults instead would emit
 * its natural ~4.5 KiB and exceed the host's limit. The line limit is
 * deliberately comfortable: the margin is 50 lines, so any line limit close
 * enough to bind leaves a budget of a handful of lines and shreds every
 * response, which tests the last-resort path rather than this one.
 */
const CONFIGURED_LIMITS = { max_lines: 300, max_bytes: 4_096 } as const

async function scenarios(
  client: HostClient,
  stub: StubProvider,
  roots: { passing: string; broken: string },
  record: ScenarioSink,
  evidence: B2Evidence,
): Promise<void> {
  // The limits this gate configured on the host it is driving, resolved the
  // way the adapter resolves them.
  const budget = resolveBudget({
    status: "configured",
    maxLines: CONFIGURED_LIMITS.max_lines,
    maxBytes: CONFIGURED_LIMITS.max_bytes,
  })

  /**
   * Every tool response this suite provoked, kept for the limits check.
   *
   * All of them, not the largest or the last. The claim is about the tool's
   * output, and one response staying under a limit says nothing about the
   * other nine — the failure mode is a facet nobody thought to measure.
   */
  const responses: Array<{ what: string; text: string; truncated: boolean }> = []
  const invoked = async (what: string, directory: string, call: { tool: string; args: unknown }) => {
    const { answer } = await scriptedTurn(client, stub, { directory, agent: EXECUTING_AGENT, call })
    const text = answer?.text ?? ""
    responses.push({ what, text, truncated: answer?.truncated === true })
    evidence.observe(what, directory, text)
    return text
  }

  const passed = await invoked("passing run", roots.passing, {
    tool: "xcode_test",
    args: scope(FIXTURE.passingSuite),
  })
  record(expectOutcome(SCENARIO["b2 passing"], passed, "Test Run passed"))
  record(
    stub.turns > 0
      ? success(SCENARIO["b2 driven by a model turn"], `${stub.turns} scripted turns served, credential-free`)
      : failure(SCENARIO["b2 driven by a model turn"], "the stub provider was never called"),
  )

  const failed = await invoked("failing run", roots.passing, {
    tool: "xcode_test",
    args: scope(FIXTURE.failingSuite),
  })
  record(expectOutcome(SCENARIO["b2 testFailed"], failed, "Test Run testFailed"))
  record(
    /failures \(\d+\):\n\s+\S+:\d+/.test(failed)
      ? success(SCENARIO["b2 rendered diagnostics"], diagnosticExcerpt(failed))
      : failure(SCENARIO["b2 rendered diagnostics"], "a real failing run rendered no located failure"),
  )
  record(
    lineCount(failed) <= budget.maxLines && byteLength(failed) <= budget.maxBytes
      ? success(
          SCENARIO["b2 budget invariant"],
          `${lineCount(failed)} lines, ${byteLength(failed)} bytes, within ${budget.maxLines}/${budget.maxBytes}`,
        )
      : failure(SCENARIO["b2 budget invariant"], "a real run exceeded the adapter's own output budget"),
  )

  const zeroMatch = await invoked("zero-match", roots.passing, {
    tool: "xcode_test",
    args: scope("NoSuchSuiteExists"),
  })
  // The exact contract, in the headline. "Not passed" would be satisfied by
  // any wrong answer at all, and a caller reading this text needs to be told
  // their *selection* was the problem rather than their code.
  record(
    expectOutcome(SCENARIO["b2 zero-match"], zeroMatch, "Test Run infrastructureFailed: scopeMismatch"),
  )

  const buildFailed = await invoked("build failure", roots.broken, {
    tool: "xcode_test",
    args: { scope: { kind: "all" } },
  })
  record(expectOutcome(SCENARIO["b2 buildFailed"], buildFailed, "Test Run buildFailed"))

  const runId = fieldValue(failed, "run")
  if (runId === undefined) {
    record(failure(SCENARIO["b2 inspection without rerun"], "no run id was rendered to inspect"))
  } else {
    const inspected = await invoked("failures inspection", roots.passing, {
      tool: "xcode_test_inspect",
      args: { runId, facet: "failures" },
    })
    record(inspectionResult(inspected, runId))

    // The log facet reads a file rather than the index, and is the one facet
    // whose content is untrusted. Both facts have to survive the round trip
    // through the host, or a model reads project output as instruction.
    const logged = await invoked("log inspection", roots.passing, {
      tool: "xcode_test_inspect",
      // Sized to the budget the configured host limits leave, not to a round
      // number (issue #82). A caller asking for more log than the host will
      // carry gets the window's byte range and none of its text — which is
      // the adapter doing the right thing, and no way to check that the text
      // it *can* return is fenced and labelled.
      args: { runId, facet: "log", maxBytes: 1024 },
    })
    record(logFacetResult(logged, runId))

    // Deliberately more log than the host's configured limit will carry
    // (issue #82). Its answer is not checked for content — the window above
    // does that — and it exists so the limits check below has a response that
    // *would* exceed the host if the adapter had helped itself to the
    // documented defaults. Without it every response is naturally small, and
    // an adapter ignoring the host configuration entirely would pass.
    await invoked("oversized log window", roots.passing, {
      tool: "xcode_test_inspect",
      args: { runId, facet: "log", maxBytes: 65_536 },
    })
  }

  record(withinConfiguredLimits(responses, budget))
}

/**
 * Every response this suite produced, against the limits the host was given.
 *
 * The invariant the adapter exists to keep: host truncation is unreachable,
 * because a truncated response is replaced by a pointer to a directory the
 * model cannot open. Checked against limits deliberately set **below** the
 * documented defaults, so the host's number is the binding one — against a
 * host with nothing configured, an adapter that ignored the configuration
 * entirely would pass this (issue #82).
 *
 * The worst response is named on success as well as on failure. "All of them
 * fit" is worth little without how close the closest came.
 */
function withinConfiguredLimits(
  responses: ReadonlyArray<{ what: string; text: string; truncated: boolean }>,
  budget: { maxLines: number; maxBytes: number },
): ScenarioResult {
  if (responses.length === 0) {
    return failure(SCENARIO["b2 configured host limits"], "no tool response was produced to measure")
  }

  // The host's own flag first: on V2 a truncated tool part says so, which is
  // the direct evidence rather than an inference from sizes (issue #140).
  const truncated = responses.filter((response) => response.truncated)
  if (truncated.length > 0) {
    return failure(
      SCENARIO["b2 configured host limits"],
      `the host truncated ${truncated.length} response(s): ${truncated.map((response) => response.what).join("; ")}`,
    )
  }

  const over = responses.filter(
    (response) =>
      lineCount(response.text) > CONFIGURED_LIMITS.max_lines ||
      byteLength(response.text) > CONFIGURED_LIMITS.max_bytes,
  )
  if (over.length > 0) {
    const worst = over
      .map((response) => `${response.what} (${lineCount(response.text)} lines, ${byteLength(response.text)} bytes)`)
      .join("; ")
    return failure(
      SCENARIO["b2 configured host limits"],
      `${over.length} response(s) exceeded the host's configured ${CONFIGURED_LIMITS.max_lines}/${CONFIGURED_LIMITS.max_bytes}: ${worst}`,
    )
  }

  const widest = responses.reduce((a, b) => (lineCount(a.text) >= lineCount(b.text) ? a : b))
  const heaviest = responses.reduce((a, b) => (byteLength(a.text) >= byteLength(b.text) ? a : b))
  return success(
    SCENARIO["b2 configured host limits"],
    `${responses.length} response(s) under the host's configured ${CONFIGURED_LIMITS.max_lines} lines / ${CONFIGURED_LIMITS.max_bytes} bytes; widest ${lineCount(widest.text)} lines (${widest.what}), heaviest ${byteLength(heaviest.text)} bytes (${heaviest.what}); the adapter's own budget was ${budget.maxLines}/${budget.maxBytes}`,
  )
}

/**
 * What a log chunk must have rendered.
 *
 * Three separate claims, each checked where it belongs rather than by seeing
 * whether a word occurs: the response is about this run's log, it carries the
 * byte range that makes paging possible, and it is fenced and named as
 * untrusted — which is the only thing standing between a model and text the
 * project wrote.
 */
function logFacetResult(rendered: string, runId: string): ScenarioResult {
  const headline = firstLine(rendered)
  if (!headline.startsWith(`Inspection of log for run ${runId}`)) {
    return failure(SCENARIO["b2 log facet"], `not a log inspection of this run: ${headline}`)
  }
  if (!/^bytes\s+\d+\.\.\d+$/m.test(rendered)) {
    return failure(SCENARIO["b2 log facet"], `no byte range to continue from: ${headline}`)
  }
  if (!rendered.includes("begin untrusted log") || !rendered.includes("end untrusted log")) {
    return failure(SCENARIO["b2 log facet"], "the log was not fenced and labelled as untrusted")
  }
  return success(SCENARIO["b2 log facet"], headline)
}

/**
 * What an inspection of a failing run must have rendered.
 *
 * Substring-matching "available" would pass on the word appearing anywhere,
 * including inside a diagnostic explaining that nothing is available. The
 * assertions here are about the answer's shape: the run it is about, the facet
 * asked for, and at least one record actually read back.
 */
function inspectionResult(rendered: string, runId: string): ScenarioResult {
  if (!rendered.includes(runId)) {
    return failure(SCENARIO["b2 inspection without rerun"], "the response named a different run")
  }
  if (!/Inspection of failures/.test(rendered)) {
    return failure(SCENARIO["b2 inspection without rerun"], `not a failures inspection: ${firstLine(rendered)}`)
  }

  const records = /records \((\d+)\)/.exec(rendered)
  if (records === null) {
    return failure(SCENARIO["b2 inspection without rerun"], `no records section: ${firstLine(rendered)}`)
  }
  if (Number.parseInt(records[1] as string, 10) === 0) {
    return failure(SCENARIO["b2 inspection without rerun"], "a failing run inspected to zero failure records")
  }

  return success(SCENARIO["b2 inspection without rerun"], `${firstLine(rendered)} — ${records[0]}`)
}

// --- fixtures and results -------------------------------------------------

function prepareProject(
  path: string,
  variant: "passing" | "buildFailed",
  options: ExecutionContext,
): string {
  const tree = generate({ out: path, variant })
  mkdirSync(join(tree.root, ".opencode", "agents"), { recursive: true })
  // The shipped template, as shipped: every call below runs under it.
  for (const entry of readdirSync(TEMPLATES).filter((name) => name.endsWith(".md"))) {
    copyFileSync(join(TEMPLATES, entry), join(tree.root, ".opencode", "agents", entry))
  }
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

function scope(suite: string): unknown {
  return { scope: { kind: "selected", tests: [{ bundle: FIXTURE.testTarget, suite }] } }
}

/**
 * Assert the rendered **headline**, not that a word appears somewhere.
 *
 * A substring test passes on the word turning up inside an explanatory
 * diagnostic — "this was not a testFailed run because…" contains
 * `testFailed`. The headline is the first line, and it is the sentence the
 * renderer contracts to produce, so that is what is compared.
 */
function expectOutcome(name: ScenarioName, output: string, expected: string): ScenarioResult {
  const headline = firstLine(output)
  if (headline.startsWith(expected)) return success(name, headline)

  // The reason as well as the headline. A headline mismatch says *that* the
  // run came out differently and the sentence under it says why — and a reader
  // looking at a report from a machine they do not have in front of them has
  // only what the report chose to keep.
  //
  // Found by shape rather than by position: the renderer puts the run id and
  // the resolved contract in `label   value` lines, and the reason is the
  // first prose line among them. The shape is asked of the renderer rather
  // than reconstructed here, so that a change to its column width cannot
  // quietly turn every reason into an empty string.
  const reason =
    output
      .split("\n")
      .slice(1)
      .filter((line) => !isField(line))
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  return failure(
    name,
    `expected a headline of "${expected}", got "${headline || "(no tool output)"}"${
      reason.length > 0 ? ` — ${reason}` : ""
    }`,
  )
}

function firstLine(output: string): string {
  return output.split("\n")[0] ?? ""
}

function diagnosticExcerpt(output: string): string {
  const at = output.indexOf("failures (")
  return output.slice(at).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim()
}

function success(name: ScenarioName, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "passed", detail }
}

function failure(name: ScenarioName, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "failed", detail }
}
