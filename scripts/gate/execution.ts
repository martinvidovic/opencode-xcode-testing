/**
 * (b2) Execution — through a real model turn, against real Xcode.
 *
 * ADR 0002's route, and it works: tool execution in the host requires a model
 * turn, so the gate supplies a **local OpenAI-compatible stub provider** that
 * emits scripted tool calls. Deterministic, credential-free, no network — and
 * unlike layer (a) or the Layer 4 harness, this is the host calling our
 * `execute` for real, rendering a real Result Bundle under the real budget.
 *
 * A real `testFailed` run is required here specifically because nothing else in
 * the validation stack ever renders realistic diagnostics from a real bundle.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Destination } from "../../src/domain/request.ts"
import type { ExecutionContext } from "./context.ts"
import { byteLength, lineCount, resolveBudget } from "../../src/adapter/budget.ts"
import { FIXTURE, generate } from "../generate-fixture-project.ts"
import {
  startStubProvider,
  stubProviderConfig,
  STUB_MODEL_ID,
  STUB_PROVIDER_ID,
  type StubProvider,
} from "./provider.ts"
import { loadSdk, PLUGIN_NOT_LINKED, type OpencodeClient } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { SCENARIO } from "./scenarios.ts"
import type { ScenarioResult } from "./report.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")
const STUB_PORT = 45_795
const HOST_PORT = 45_796

/** Records each scenario as it finishes; see `ScenarioSink`. */
export async function runExecutionGate(
  options: ExecutionContext,
  record: ScenarioSink,
): Promise<void> {
  // The same loader b1 uses, and for the same reason (issue #80): an
  // unguarded dynamic import here would take the whole execution suite down
  // from inside another package's top-level code.
  const loaded = await loadSdk()
  if (loaded.status !== "loaded") {
    record(failure(SCENARIO["b2 execution"], loaded.detail))
    return
  }
  if (!existsSync(join(REPO, "node_modules", "@opencode-ai", "plugin"))) {
    record(failure(SCENARIO["b2 execution"], PLUGIN_NOT_LINKED))
    return
  }

  const { createOpencode } = loaded.sdk

  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-"))
  const previousCwd = process.cwd()
  let stub: StubProvider | undefined

  try {
    const passing = prepareProject(join(workspace, "passing"), "passing", options)
    const broken = prepareProject(join(workspace, "build-failed"), "buildFailed", options)

    stub = startStubProvider(STUB_PORT)
    process.chdir(passing)

    const { client, server } = await createOpencode({
      port: HOST_PORT,
      config: {
        plugin: [PLUGIN],
        provider: stubProviderConfig(stub.baseURL),
      },
    })

    try {
      await scenarios(client, stub, { passing, broken }, record)
    } finally {
      server.close()
    }
  } catch (error) {
    // Beside what already ran, not instead of it. Every scenario this suite
    // finished is already in the report, so a failure here adds a reason
    // rather than replacing eleven results with one.
    record(failure(SCENARIO["b2 execution"], `the stub-provider route could not be driven: ${safeFailure(error)}`))
  } finally {
    stub?.stop()
    process.chdir(previousCwd)
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function scenarios(
  client: OpencodeClient,
  stub: StubProvider,
  roots: { passing: string; broken: string },
  record: ScenarioSink,
): Promise<void> {
  const budget = resolveBudget(undefined)

  const passed = await invoke(client, stub, roots.passing, {
    tool: "xcode_test",
    args: scope(FIXTURE.passingSuite),
  })
  record(expectOutcome(SCENARIO["b2 passing"], passed, "Test Run passed"))
  record(
    stub.turns > 0
      ? success(SCENARIO["b2 driven by a model turn"], `${stub.turns} scripted turns served, credential-free`)
      : failure(SCENARIO["b2 driven by a model turn"], "the stub provider was never called"),
  )

  const failed = await invoke(client, stub, roots.passing, {
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

  const zeroMatch = await invoke(client, stub, roots.passing, {
    tool: "xcode_test",
    args: scope("NoSuchSuiteExists"),
  })
  // The exact contract, in the headline. "Not passed" would be satisfied by
  // any wrong answer at all, and a caller reading this text needs to be told
  // their *selection* was the problem rather than their code.
  record(
    expectOutcome(SCENARIO["b2 zero-match"], zeroMatch, "Test Run infrastructureFailed: scopeMismatch"),
  )

  const buildFailed = await invoke(client, stub, roots.broken, {
    tool: "xcode_test",
    args: { scope: { kind: "all" } },
  })
  record(expectOutcome(SCENARIO["b2 buildFailed"], buildFailed, "Test Run buildFailed"))

  const runId = /^run\s+(\S+)/m.exec(failed)?.[1]
  if (runId === undefined) {
    record(failure(SCENARIO["b2 inspection without rerun"], "no run id was rendered to inspect"))
  } else {
    const inspected = await invoke(client, stub, roots.passing, {
      tool: "xcode_test_inspect",
      args: { runId, facet: "failures" },
    })
    record(inspectionResult(inspected, runId))

    // The log facet reads a file rather than the index, and is the one facet
    // whose content is untrusted. Both facts have to survive the round trip
    // through the host, or a model reads project output as instruction.
    const logged = await invoke(client, stub, roots.passing, {
      tool: "xcode_test_inspect",
      args: { runId, facet: "log", maxBytes: 4096 },
    })
    record(logFacetResult(logged, runId))
  }
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

/** Script one call, drive one turn, and return the rendered tool output. */
async function invoke(
  client: OpencodeClient,
  stub: StubProvider,
  directory: string,
  call: { tool: string; args: unknown },
): Promise<string> {
  const session = await client.session.create({
    query: { directory },
    body: { title: `gate ${call.tool}` },
  })
  const id = session.data?.id
  if (id === undefined) throw new Error("the host created no session")

  stub.script(call)
  await client.session.prompt({
    path: { id },
    query: { directory },
    body: {
      model: { providerID: STUB_PROVIDER_ID, modelID: STUB_MODEL_ID },
      parts: [{ type: "text", text: `run ${call.tool}` }],
    },
  })

  const messages = await client.session.messages({ path: { id }, query: { directory } })
  for (const message of messages.data ?? []) {
    for (const part of message.parts ?? []) {
      if (part.type === "tool" && part.tool === call.tool) {
        return part.state?.output ?? part.state?.error ?? ""
      }
    }
  }
  return ""
}

// --- fixtures and results -------------------------------------------------

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
function expectOutcome(name: string, output: string, expected: string): ScenarioResult {
  const headline = firstLine(output)
  return headline.startsWith(expected)
    ? success(name, headline)
    : failure(name, `expected a headline of "${expected}", got "${headline || "(no tool output)"}"`)
}

function firstLine(output: string): string {
  return output.split("\n")[0] ?? ""
}

function diagnosticExcerpt(output: string): string {
  const at = output.indexOf("failures (")
  return output.slice(at).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim()
}

function success(name: string, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "passed", detail }
}

function failure(name: string, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "failed", detail }
}
