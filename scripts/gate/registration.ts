/**
 * (b1) Host registration — credential-free, and always gating.
 *
 * This boots a real headless OpenCode instance with **no model provider
 * configured** and asserts what the host actually sees: the three tool IDs,
 * their descriptions and exact parameter schemas, the restricted-agent
 * permission rulesets, and the enablement marker's power to keep all of it
 * invisible.
 *
 * Everything here is checkable without a single credential, which is why it
 * gates unconditionally — a gate that needs an API key is a gate that stops
 * running.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_IDS, descriptionFor } from "../../src/adapter/descriptions.ts"
import { defaultConfigDirectory } from "../link-host-package.ts"
import type { ScenarioResult } from "./report.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")
const TEMPLATES = join(REPO, "examples", "agent")

/** A port nothing else is likely to hold, so the gate never adopts a running server. */
const GATE_PORT = 45_729

type OpencodeClient = {
  tool: {
    ids(options: unknown): Promise<{ data?: string[] }>
    list(options: unknown): Promise<{ data?: Array<{ id: string; description?: string; parameters?: unknown }> }>
  }
  session: { create(options: unknown): Promise<{ data?: { id: string } }> }
  app: { agents(options: unknown): Promise<{ data?: Array<Record<string, unknown>> }> }
}

type Sdk = {
  createOpencode(options: unknown): Promise<{
    client: OpencodeClient
    server: { url: string; close(): void }
  }>
}

/**
 * The SDK is host-managed test infrastructure, not a repository dependency, so
 * it is resolved from the host's own config directory when it is not otherwise
 * importable.
 */
async function loadSdk(): Promise<Sdk | undefined> {
  const candidate = join(
    defaultConfigDirectory(),
    "node_modules",
    "@opencode-ai",
    "sdk",
    "dist",
    "index.js",
  )
  if (!existsSync(candidate)) return undefined
  return (await import(candidate)) as Sdk
}

export async function runRegistrationGate(): Promise<ScenarioResult[]> {
  const sdk = await loadSdk()
  if (sdk === undefined) {
    return [
      {
        name: "b1 host registration",
        kind: "gating",
        status: "failed",
        detail:
          "@opencode-ai/sdk was not found under the OpenCode config directory; the gate looked there because the SDK is host-managed test infrastructure rather than a repository dependency.",
      },
    ]
  }

  if (!existsSync(join(REPO, "node_modules", "@opencode-ai", "plugin"))) {
    return [
      {
        name: "b1 host registration",
        kind: "gating",
        status: "failed",
        detail:
          "@opencode-ai/plugin is not resolvable from this checkout, so the plugin would fail to load silently. Run `bun scripts/link-host-package.ts`.",
      },
    ]
  }

  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b1-"))
  const previousCwd = process.cwd()

  try {
    const marked = prepareRoot(join(workspace, "marked"), { marker: true })
    const unmarked = prepareRoot(join(workspace, "unmarked"), { marker: false })

    process.chdir(marked)
    const { client, server } = await sdk.createOpencode({
      port: GATE_PORT,
      config: { plugin: [PLUGIN] },
    })

    try {
      return [
        ...(await registrationScenarios(client, marked)),
        await markerScenario(client, unmarked),
        await agentScenario(client, marked),
      ]
    } finally {
      server.close()
    }
  } catch (error) {
    return [
      {
        name: "b1 host registration",
        kind: "gating",
        status: "failed",
        detail: `the headless instance could not be driven: ${String(error)}`,
      },
    ]
  } finally {
    process.chdir(previousCwd)
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function registrationScenarios(
  client: OpencodeClient,
  directory: string,
): Promise<ScenarioResult[]> {
  // The factory runs at instance bootstrap, so an instance has to exist first.
  await client.session.create({ query: { directory }, body: { title: "acceptance gate" } })

  const ids = new Set((await client.tool.ids({ query: { directory } })).data ?? [])
  const missing = TOOL_IDS.filter((id) => !ids.has(id))

  const results: ScenarioResult[] = [
    missing.length === 0
      ? pass("b1 tool ids register", `${TOOL_IDS.join(", ")} all present, credential-free`)
      : fail("b1 tool ids register", `missing from the host: ${missing.join(", ")}`),
  ]

  // This endpoint filters by model, so the model id is chosen deliberately
  // rather than left to whatever happens to be configured.
  const listed = await client.tool.list({
    query: { directory, provider: "anthropic", model: "claude-sonnet-4-5" },
  })
  const byId = new Map((listed.data ?? []).map((entry) => [entry.id, entry]))

  results.push(descriptionScenario(byId))
  results.push(parameterScenario(byId))
  return results
}

function descriptionScenario(
  byId: Map<string, { description?: string; parameters?: unknown }>,
): ScenarioResult {
  for (const id of TOOL_IDS) {
    const listed = byId.get(id)
    if (listed === undefined) return fail("b1 tool descriptions", `${id} was not listed`)
    if (listed.description !== descriptionFor(id)) {
      return fail("b1 tool descriptions", `${id}'s description is not the shipped sidecar text`)
    }
  }
  return pass("b1 tool descriptions", "each description is exactly the shipped sidecar file")
}

function parameterScenario(
  byId: Map<string, { description?: string; parameters?: unknown }>,
): ScenarioResult {
  const test = byId.get("xcode_test")?.parameters as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined

  if (test?.properties === undefined) {
    return fail("b1 parameter schemas", "xcode_test exposed no parameter schema")
  }

  const properties = Object.keys(test.properties).sort()
  const expected = ["container", "destination", "scheme", "scope", "timeoutSeconds"]
  if (properties.join(",") !== expected.join(",")) {
    return fail("b1 parameter schemas", `xcode_test exposed ${properties.join(", ")}`)
  }

  // The legacy JSON-Schema fallback marks every key required. If that had been
  // taken, a model would have to invent a destination on every call.
  const required = (test.required ?? []).sort()
  if (required.join(",") !== "scope") {
    return fail("b1 parameter schemas", `xcode_test requires ${required.join(", ") || "(nothing)"}`)
  }

  const recover = byId.get("xcode_test_recover")?.parameters as
    | { properties?: Record<string, unknown> }
    | undefined
  const recoverKeys = Object.keys(recover?.properties ?? {})
  if (recoverKeys.length > 0) {
    return fail("b1 parameter schemas", `xcode_test_recover invented arguments: ${recoverKeys.join(", ")}`)
  }

  return pass("b1 parameter schemas", "only `scope` is required; recovery takes no arguments")
}

async function markerScenario(client: OpencodeClient, directory: string): Promise<ScenarioResult> {
  await client.session.create({ query: { directory }, body: { title: "acceptance gate" } })
  const ids = new Set((await client.tool.ids({ query: { directory } })).data ?? [])
  const leaked = TOOL_IDS.filter((id) => ids.has(id))

  return leaked.length === 0
    ? pass("b1 enablement marker gates registration", "an unmarked root registers nothing, silently")
    : fail("b1 enablement marker gates registration", `registered without a marker: ${leaked.join(", ")}`)
}

/**
 * The host resolves a template's `permission:` block into an ordered rule
 * list, and the ordering is the contract: last match wins with key order
 * preserved, so the `"*": deny` catch-all must come first and the specifics
 * after. Evaluating it the way the host does is the only way to assert that
 * `bash` is genuinely unreachable rather than merely absent from a map.
 */
export type PermissionRule = { permission: string; pattern: string; action: string }

export function resolveAction(rules: PermissionRule[], toolId: string): string | undefined {
  let action: string | undefined
  for (const rule of rules) {
    if (rule.permission !== "*" && rule.permission !== toolId) continue
    if (rule.pattern !== "*") continue
    action = rule.action
  }
  return action
}

async function agentScenario(client: OpencodeClient, directory: string): Promise<ScenarioResult> {
  const agents = (await client.app.agents({ query: { directory } })).data ?? []
  const names = new Set(agents.map((agent) => String(agent["name"])))

  const expected = readdirSync(TEMPLATES)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/, ""))

  const missing = expected.filter((name) => !names.has(name))
  if (missing.length > 0) {
    return fail("b1 restricted agents", `the host did not load: ${missing.join(", ")}`)
  }

  for (const name of expected) {
    const agent = agents.find((entry) => entry["name"] === name)
    // Directory-scope rules are noise here; only tool permissions matter.
    const rules = ((agent?.["permission"] ?? []) as PermissionRule[]).filter(
      (rule) => rule.permission !== "external_directory",
    )

    if (resolveAction(rules, "bash") !== "deny") {
      return fail("b1 restricted agents", `${name} does not deny bash`)
    }
    for (const id of TOOL_IDS) {
      if (resolveAction(rules, id) !== "allow") {
        return fail("b1 restricted agents", `${name} does not expose ${id}`)
      }
    }
  }

  return pass(
    "b1 restricted agents",
    `${expected.join(", ")} deny bash and allow the family, as the host resolves them`,
  )
}

// --- fixtures -------------------------------------------------------------

function prepareRoot(path: string, options: { marker: boolean }): string {
  mkdirSync(join(path, ".opencode", "agent"), { recursive: true })

  if (options.marker) {
    writeFileSync(join(path, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')
    // The templates are asserted as shipped, not as a copy written by the gate.
    for (const entry of readdirSync(TEMPLATES).filter((name) => name.endsWith(".md"))) {
      copyFileSync(join(TEMPLATES, entry), join(path, ".opencode", "agent", entry))
    }
  }

  return path
}

function pass(name: string, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "passed", detail }
}

function fail(name: string, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "failed", detail }
}

