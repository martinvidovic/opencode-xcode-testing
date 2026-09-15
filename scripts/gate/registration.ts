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
import { bounded, SERVER_BOOT_MS } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { SCENARIO } from "./scenarios.ts"
import type { ScenarioResult } from "./report.ts"
import { schemaComplaints } from "./schemas.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")
const TEMPLATES = join(REPO, "examples", "agent")

/** A port nothing else is likely to hold, so the gate never adopts a running server. */
const GATE_PORT = 45_729

/**
 * The part of the OpenCode SDK this gate uses.
 *
 * Declared rather than assumed. The module is imported from the host's own
 * installation at run time, so nothing checks it for us — and `as Sdk` against
 * an identifier that was never defined checked exactly as much (issue #80).
 * Bun strips types rather than checking them, so that read as working code.
 */
type Sdk = {
  createOpencode(options: {
    port: number
    timeout: number
    config: { plugin: string[] }
  }): Promise<{ client: OpencodeClient; server: { close(): void } }>
}

/**
 * The part of the host's client this gate calls, derived from the calls.
 *
 * Narrow on purpose. A fuller declaration would be this repository's guess at
 * somebody else's type, kept in step by hand; what these gates need is the
 * three groups of methods they actually use, so an SDK that stopped offering
 * one of them is a mistake where it is written rather than at run time.
 */
export type OpencodeClient = {
  session: {
    create(input: { query: { directory: string }; body: { title: string } }): Promise<unknown>
    prompt(input: unknown): Promise<unknown>
    messages(input: unknown): Promise<{ data?: unknown }>
  }
  tool: {
    ids(input: { query: { directory: string } }): Promise<{ data?: string[] }>
    list(input: unknown): Promise<{ data?: unknown }>
  }
  app: {
    agents(input: { query: { directory: string } }): Promise<{ data?: unknown }>
  }
}

/**
 * What became of the attempt to load the SDK.
 *
 * Three answers, not two. "It is not installed" is a machine that has not been
 * set up; "it is there and would not load" is a machine whose host packages
 * are broken. Both fail registration, and a reader fixing one does something
 * different from a reader fixing the other.
 */
type SdkLoad =
  | { status: "loaded"; sdk: Sdk }
  | { status: "missing" }
  | { status: "unusable"; detail: string }

/**
 * The SDK is host-managed test infrastructure, not a repository dependency, so
 * it is resolved from the host's own config directory when it is not otherwise
 * importable.
 *
 * Nothing here escapes. A dynamic import runs another package's top-level
 * code, which may throw for any reason it likes — and a throw from this line
 * used to leave the whole suite, taking the installation gate with it. That
 * gate has nothing to do with the SDK: it checks that the README's symlink
 * registers the tool family, on a machine that may have no SDK at all.
 */
async function loadSdk(): Promise<SdkLoad> {
  const candidate = join(
    defaultConfigDirectory(),
    "node_modules",
    "@opencode-ai",
    "sdk",
    "dist",
    "index.js",
  )
  if (!existsSync(candidate)) return { status: "missing" }

  let module: unknown
  try {
    module = await import(candidate)
  } catch (error) {
    // Sanitized: the message routinely quotes the module's own absolute path,
    // and the path is under the user's home by construction.
    return { status: "unusable", detail: `it could not be imported: ${safeFailure(error)}` }
  }

  // A module that loaded is not a module that fits. Calling through a cast
  // would fail later, inside the host boot, and be reported as a host that
  // would not start — which is a different machine to go and look at.
  if (!isSdk(module)) {
    return { status: "unusable", detail: "it does not export `createOpencode`" }
  }
  return { status: "loaded", sdk: module }
}

function isSdk(value: unknown): value is Sdk {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Sdk).createOpencode === "function"
  )
}

/** Records each scenario as it finishes; see `ScenarioSink`. */
export async function runRegistrationGate(record: ScenarioSink): Promise<void> {
  const loaded = await loadSdk()
  if (loaded.status !== "loaded") {
    record({
      name: SCENARIO["b1 host registration"],
      kind: "gating",
      status: "failed",
      detail:
        loaded.status === "missing"
          ? "@opencode-ai/sdk was not found under the OpenCode config directory; the gate looked there because the SDK is host-managed test infrastructure rather than a repository dependency."
          : `@opencode-ai/sdk was found under the OpenCode config directory but ${loaded.detail}.`,
    })
    return
  }
  const sdk = loaded.sdk

  if (!existsSync(join(REPO, "node_modules", "@opencode-ai", "plugin"))) {
    record({
      name: SCENARIO["b1 host registration"],
      kind: "gating",
      status: "failed",
      detail:
        "@opencode-ai/plugin is not resolvable from this checkout, so the plugin would fail to load silently. Run `bun scripts/link-host-package.ts`.",
    })
    return
  }

  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b1-"))
  const previousCwd = process.cwd()

  try {
    const marked = prepareRoot(join(workspace, "marked"), { marker: true })
    const unmarked = prepareRoot(join(workspace, "unmarked"), { marker: false })

    process.chdir(marked)
    const { client, server } = await sdk.createOpencode({
      port: GATE_PORT,
      timeout: SERVER_BOOT_MS,
      config: { plugin: [PLUGIN] },
    })

    try {
      // Each of these reaches the report as it finishes. Collected and
      // returned instead, none of them would arrive unless all of them did —
      // and the last two boot host machinery.
      await registrationScenarios(client, marked, record)
      record(await markerScenario(client, unmarked))
      record(await agentScenario(client, marked))
    } finally {
      server.close()
    }
  } catch (error) {
    // Recorded beside whatever already ran rather than instead of it: this
    // suite's scenarios are in the report the moment each finishes, so a
    // failure here says what went wrong without erasing what went right.
    record({
      name: SCENARIO["b1 host registration"],
      kind: "gating",
      status: "failed",
      detail: `the headless instance could not be driven: ${safeFailure(error)}`,
    })
  } finally {
    process.chdir(previousCwd)
    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * The registration checks, each published the moment it is decided.
 *
 * `tool.list` is a second round trip to a host process that is still booting,
 * and it sits between the first check and the last two. Collecting all three
 * and returning them meant that if it did not answer, the first — already
 * decided, already true — went with it.
 *
 * Exported so that property can be tested against a client that fails on cue.
 * The rest of this suite needs a real host process and belongs to Layer 4;
 * this function needs only a client, and the thing worth pinning about it is
 * precisely what it has already published when one stops answering.
 */
export async function registrationScenarios(
  client: OpencodeClient,
  directory: string,
  record: ScenarioSink,
): Promise<void> {
  // The factory runs at instance bootstrap, so an instance has to exist first.
  await bounded(
    "session.create",
    client.session.create({ query: { directory }, body: { title: "acceptance gate" } }),
  )

  const ids = new Set(
    (await bounded("tool.ids", client.tool.ids({ query: { directory } }))).data ?? [],
  )
  const missing = TOOL_IDS.filter((id) => !ids.has(id))

  record(
    missing.length === 0
      ? pass(SCENARIO["b1 tool ids register"], `${TOOL_IDS.join(", ")} all present, credential-free`)
      : fail(SCENARIO["b1 tool ids register"], `missing from the host: ${missing.join(", ")}`),
  )

  // This endpoint filters by model, so the model id is chosen deliberately
  // rather than left to whatever happens to be configured.
  const listed = await bounded(
    "tool.list",
    client.tool.list({
      query: { directory, provider: "anthropic", model: "claude-sonnet-4-5" },
    }),
  )
  const byId = new Map((listed.data ?? []).map((entry) => [entry.id, entry]))

  record(descriptionScenario(byId))
  record(parameterScenario(byId))
}

function descriptionScenario(
  byId: Map<string, { description?: string; parameters?: unknown }>,
): ScenarioResult {
  for (const id of TOOL_IDS) {
    const listed = byId.get(id)
    if (listed === undefined) return fail(SCENARIO["b1 tool descriptions"], `${id} was not listed`)
    if (listed.description !== descriptionFor(id)) {
      return fail(SCENARIO["b1 tool descriptions"], `${id}'s description is not the shipped sidecar text`)
    }
  }
  return pass(SCENARIO["b1 tool descriptions"], "each description is exactly the shipped sidecar file")
}

function parameterScenario(
  byId: Map<string, { description?: string; parameters?: unknown }>,
): ScenarioResult {
  // Every tool, not just the one with the most arguments: a schema nobody
  // checks is a schema that drifts, and `xcode_test_inspect` is the one a
  // model reaches for after every failing run.
  const complaints = TOOL_IDS.flatMap((id) => schemaComplaints(id, byId.get(id)?.parameters))

  return complaints.length === 0
    ? pass(
        SCENARIO["b1 parameter schemas"],
        "all three normalize to their contract: only `scope` is required, facets are a closed set, recovery takes no arguments",
      )
    : fail(SCENARIO["b1 parameter schemas"], complaints.join("; "))
}

async function markerScenario(client: OpencodeClient, directory: string): Promise<ScenarioResult> {
  await bounded(
    "session.create",
    client.session.create({ query: { directory }, body: { title: "acceptance gate" } }),
  )
  const ids = new Set(
    (await bounded("tool.ids", client.tool.ids({ query: { directory } }))).data ?? [],
  )
  const leaked = TOOL_IDS.filter((id) => ids.has(id))

  return leaked.length === 0
    ? pass(SCENARIO["b1 enablement marker gates registration"], "an unmarked root registers nothing, silently")
    : fail(SCENARIO["b1 enablement marker gates registration"], `registered without a marker: ${leaked.join(", ")}`)
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
  const agents = (await bounded("app.agents", client.app.agents({ query: { directory } }))).data ?? []
  const names = new Set(agents.map((agent) => String(agent["name"])))

  const expected = readdirSync(TEMPLATES)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/, ""))

  const missing = expected.filter((name) => !names.has(name))
  if (missing.length > 0) {
    return fail(SCENARIO["b1 restricted agents"], `the host did not load: ${missing.join(", ")}`)
  }

  for (const name of expected) {
    const agent = agents.find((entry) => entry["name"] === name)
    // Directory-scope rules are noise here; only tool permissions matter.
    const rules = ((agent?.["permission"] ?? []) as PermissionRule[]).filter(
      (rule) => rule.permission !== "external_directory",
    )

    if (resolveAction(rules, "bash") !== "deny") {
      return fail(SCENARIO["b1 restricted agents"], `${name} does not deny bash`)
    }
    for (const id of TOOL_IDS) {
      if (resolveAction(rules, id) !== "allow") {
        return fail(SCENARIO["b1 restricted agents"], `${name} does not expose ${id}`)
      }
    }
  }

  return pass(
    SCENARIO["b1 restricted agents"],
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
