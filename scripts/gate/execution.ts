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
import type { ToolchainIdentity } from "../../src/domain/toolchain.ts"
import { byteLength, lineCount, resolveBudget } from "../../src/adapter/budget.ts"
import { FIXTURE, generate } from "../generate-fixture-project.ts"
import { defaultConfigDirectory } from "../link-host-package.ts"
import {
  startStubProvider,
  stubProviderConfig,
  STUB_MODEL_ID,
  STUB_PROVIDER_ID,
  type StubProvider,
} from "./provider.ts"
import type { ScenarioResult } from "./report.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")
const STUB_PORT = 45_795
const HOST_PORT = 45_796

export type ExecutionOptions = {
  toolchain: ToolchainIdentity
  runtimePath: string
  destination: Destination
}

type Client = {
  session: {
    create(options: unknown): Promise<{ data?: { id: string } }>
    prompt(options: unknown): Promise<unknown>
    messages(options: unknown): Promise<{ data?: Array<{ parts?: ToolPart[] }> }>
  }
}

type ToolPart = {
  type: string
  tool?: string
  state?: { status?: string; output?: string; error?: string }
}

export async function runExecutionGate(options: ExecutionOptions): Promise<ScenarioResult[]> {
  const sdkPath = join(
    defaultConfigDirectory(),
    "node_modules",
    "@opencode-ai",
    "sdk",
    "dist",
    "index.js",
  )
  if (!existsSync(sdkPath)) {
    return [failure("b2 execution", "@opencode-ai/sdk was not found under the OpenCode config directory")]
  }
  if (!existsSync(join(REPO, "node_modules", "@opencode-ai", "plugin"))) {
    return [
      failure(
        "b2 execution",
        "@opencode-ai/plugin is not resolvable from this checkout, so the plugin would fail to load silently. Run `bun scripts/link-host-package.ts`.",
      ),
    ]
  }

  const { createOpencode } = (await import(sdkPath)) as {
    createOpencode(options: unknown): Promise<{ client: Client; server: { close(): void } }>
  }

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
      return await scenarios(client, stub, { passing, broken })
    } finally {
      server.close()
    }
  } catch (error) {
    return [failure("b2 execution", `the stub-provider route could not be driven: ${String(error)}`)]
  } finally {
    stub?.stop()
    process.chdir(previousCwd)
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function scenarios(
  client: Client,
  stub: StubProvider,
  roots: { passing: string; broken: string },
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  const budget = resolveBudget(undefined)

  const passed = await invoke(client, stub, roots.passing, {
    tool: "xcode_test",
    args: scope(FIXTURE.passingSuite),
  })
  results.push(expectText("b2 passing", passed, "Test Run passed"))
  results.push(
    stub.turns > 0
      ? success("b2 driven by a model turn", `${stub.turns} scripted turns served, credential-free`)
      : failure("b2 driven by a model turn", "the stub provider was never called"),
  )

  const failed = await invoke(client, stub, roots.passing, {
    tool: "xcode_test",
    args: scope(FIXTURE.failingSuite),
  })
  results.push(expectText("b2 testFailed", failed, "Test Run testFailed"))
  results.push(
    /failures \(\d+\):\n\s+\S+:\d+/.test(failed)
      ? success("b2 rendered diagnostics", diagnosticExcerpt(failed))
      : failure("b2 rendered diagnostics", "a real failing run rendered no located failure"),
  )
  results.push(
    lineCount(failed) <= budget.maxLines && byteLength(failed) <= budget.maxBytes
      ? success(
          "b2 budget invariant",
          `${lineCount(failed)} lines, ${byteLength(failed)} bytes, within ${budget.maxLines}/${budget.maxBytes}`,
        )
      : failure("b2 budget invariant", "a real run exceeded the adapter's own output budget"),
  )

  const zeroMatch = await invoke(client, stub, roots.passing, {
    tool: "xcode_test",
    args: scope("NoSuchSuiteExists"),
  })
  results.push(
    zeroMatch.includes("Test Run passed")
      ? failure("b2 zero-match", "a run that matched no tests rendered as passed")
      : success("b2 zero-match", firstLine(zeroMatch)),
  )

  const buildFailed = await invoke(client, stub, roots.broken, {
    tool: "xcode_test",
    args: { scope: { kind: "all" } },
  })
  results.push(expectText("b2 buildFailed", buildFailed, "Test Run buildFailed"))

  const runId = /^run\s+(\S+)/m.exec(failed)?.[1]
  if (runId === undefined) {
    results.push(failure("b2 inspection without rerun", "no run id was rendered to inspect"))
  } else {
    const inspected = await invoke(client, stub, roots.passing, {
      tool: "xcode_test_inspect",
      args: { runId, facet: "failures" },
    })
    results.push(
      inspected.includes("available") || inspected.includes("incomplete")
        ? success("b2 inspection without rerun", firstLine(inspected))
        : failure("b2 inspection without rerun", firstLine(inspected)),
    )
  }

  return results
}

/** Script one call, drive one turn, and return the rendered tool output. */
async function invoke(
  client: Client,
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
  options: ExecutionOptions,
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

function expectText(name: string, output: string, expected: string): ScenarioResult {
  return output.includes(expected)
    ? success(name, firstLine(output))
    : failure(name, `expected "${expected}", got "${firstLine(output) || "(no tool output)"}"`)
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
