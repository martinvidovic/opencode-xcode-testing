/**
 * (b1) Host registration on V2 — credential-free, and always gating.
 *
 * This boots an isolated OpenCode V2 host whose only model provider is the
 * local stub, and asserts what the host actually offers a model: the three
 * tool IDs, their descriptions and exact parameter schemas, the enablement
 * marker's power to keep all of it invisible, the restricted agents' effective
 * permissions, each tool's independent deniability, isolation across nested
 * modules and worktrees, and a clean unload and reload.
 *
 * Everything is read from evidence the host produced (issue #140): the
 * `tools` array of a real model request, captured by the stub, and the
 * effective permission rules `agent.get` returns. V2 has no client route that
 * lists tools, so asking the host what it *registered* is no longer possible
 * — and what it *offers* is the stronger claim anyway, because it is filtered
 * through exactly the permissions a model runs under.
 *
 * Credential-free throughout: a gate that needs an API key is a gate that
 * stops running.
 */

import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_IDS, descriptionFor } from "../../src/adapter/descriptions.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"
import type { DrivenRoots } from "./driven-roots.ts"
import { baseHostConfig, bootHost, bounded, loadClient, observedHostVersion, provenanceProblem, type BootedHost, type HostClient } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { startStubProvider, type OfferedTool, type StubProvider } from "./provider.ts"
import type { ScenarioResult } from "./report.ts"
import { SCENARIO, type ScenarioName } from "./scenarios.ts"
import { schemaComplaints } from "./schemas.ts"
import { offeredNames, scriptedTurn } from "./turn.ts"

const REPO = join(import.meta.dir, "..", "..")
const TEMPLATES = join(REPO, "examples", "agent")

/** The template that promises no shell and no file access at all. */
const TEST_RUNNER = "xcode-test-runner"

/**
 * One gate-defined agent per Test Tool, each denying exactly that tool and
 * allowing the other two — the reason there are three IDs rather than one.
 */
export function denyingAgent(denied: string): string {
  return `gate-denies-${denied}`
}

/** The host configuration B1 runs under: this checkout as a plugin, and the stub. */
export function registrationConfig(baseURL: string, withPlugin = true): Record<string, unknown> {
  return {
    ...baseHostConfig(baseURL),
    ...(withPlugin ? { plugins: [REPO] } : {}),
    agents: Object.fromEntries(
      TOOL_IDS.map((denied) => [
        denyingAgent(denied),
        {
          mode: "primary",
          description: `Acceptance gate: every Test Tool but ${denied}`,
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...TOOL_IDS.filter((id) => id !== denied).map((id) => ({ action: id, resource: "*", effect: "allow" })),
          ],
        },
      ]),
    ),
  }
}

/** Records each scenario as it finishes; see `ScenarioSink`. */
export async function runRegistrationGate(
  record: ScenarioSink,
  roots: DrivenRoots,
  hostVersion = observedHostVersion(),
): Promise<void> {
  const bootstrapFailed = (detail: string) => {
    record({ name: SCENARIO["b1 host registration"], kind: "gating", status: "failed", detail })
  }

  // Before anything boots (#81): a package set that disagrees with itself
  // makes whatever this gate establishes unattributable.
  const provenance = provenanceProblem(hostVersion)
  if (provenance !== undefined) return bootstrapFailed(provenance)

  const loaded = await loadClient()
  if (loaded.status !== "loaded") return bootstrapFailed(loaded.detail)

  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b1-"))
  let stub: StubProvider | undefined
  let host: BootedHost | undefined

  try {
    // A real host writes per-root storage under the user's own home for each
    // project it is pointed at, and nothing downstream can collect it unless
    // it is registered (issue #98). Registered as each is prepared, so a throw
    // in a later one does not leave an earlier one registered nowhere — and
    // swept by the caller, once, at the end of the run: a suite that cleaned
    // up after itself raced the host it had just closed, whose plugin
    // instances kept writing after the sweep.
    const marked = roots.add(prepareRoot(join(workspace, "marked"), { marker: true }))
    const unmarked = roots.add(prepareRoot(join(workspace, "unmarked"), { marker: false }))
    const modules = prepareModules(join(workspace, "modules"), roots)

    stub = startStubProvider()
    host = await bootHost({
      workspace,
      config: registrationConfig(stub.baseURL),
      cwd: marked,
      connect: loaded.connect,
    })

    // Each reaches the report as it finishes. Collected and returned instead,
    // none of them would arrive unless all of them did.
    await registrationScenarios(host.client, stub, marked, record)
    record(await markerScenario(host.client, stub, unmarked))
    record(await agentScenario(host.client, stub, marked))
    record(await denialScenario(host.client, stub, marked))
    record(await isolationScenario(host.client, stub, modules))
    record(await reloadScenario(host, stub, marked))
  } catch (error) {
    // Beside whatever already ran, not instead of it.
    record({
      name: SCENARIO["b1 host registration"],
      kind: "gating",
      status: "failed",
      detail: `the isolated host could not be driven: ${safeFailure(error)}`,
    })
  } finally {
    await host?.stop()
    stub?.stop()
    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * The registration checks, each published the moment it is decided.
 *
 * Exported so that ordering can be tested against a client that fails on
 * cue: a check already decided must not be lost to a later call that does not
 * come back.
 */
export async function registrationScenarios(
  client: HostClient,
  stub: StubProvider,
  directory: string,
  record: ScenarioSink,
): Promise<void> {
  const { offered } = await scriptedTurn(client, stub, { directory })
  const byName = new Map((offered ?? []).map((tool) => [tool.name, tool]))
  const missing = TOOL_IDS.filter((id) => !byName.has(id))

  record(
    offered === undefined
      ? fail(SCENARIO["b1 tool ids register"], "no model request offered any tool at all")
      : missing.length === 0
        ? pass(SCENARIO["b1 tool ids register"], `${TOOL_IDS.join(", ")} all offered to a model, credential-free`)
        : fail(SCENARIO["b1 tool ids register"], `not offered by the host: ${missing.join(", ")}`),
  )
  record(descriptionScenario(byName))
  record(parameterScenario(byName))
}

function descriptionScenario(byName: Map<string, OfferedTool>): ScenarioResult {
  for (const id of TOOL_IDS) {
    const offered = byName.get(id)
    if (offered === undefined) return fail(SCENARIO["b1 tool descriptions"], `${id} was not offered`)
    if (offered.description !== descriptionFor(id)) {
      return fail(SCENARIO["b1 tool descriptions"], `${id}'s description is not the shipped sidecar text`)
    }
  }
  return pass(SCENARIO["b1 tool descriptions"], "each description is exactly the shipped sidecar file")
}

function parameterScenario(byName: Map<string, OfferedTool>): ScenarioResult {
  // Every tool, not just the one with the most arguments: a schema nobody
  // checks is a schema that drifts.
  const complaints = TOOL_IDS.flatMap((id) => schemaComplaints(id, byName.get(id)?.parameters))

  return complaints.length === 0
    ? pass(
        SCENARIO["b1 parameter schemas"],
        "all three reach the model as their contract: only `scope` is required, facets are a closed set, recovery takes no arguments",
      )
    : fail(SCENARIO["b1 parameter schemas"], complaints.join("; "))
}

async function markerScenario(client: HostClient, stub: StubProvider, directory: string): Promise<ScenarioResult> {
  const { offered } = await scriptedTurn(client, stub, { directory })
  if (offered === undefined) {
    // The default agent always has built-in tools. Nothing offered means the
    // turn proved nothing, which is not the same as proving silence.
    return fail(SCENARIO["b1 enablement marker gates registration"], "no model request offered any tool at all")
  }
  const leaked = TOOL_IDS.filter((id) => offered.some((tool) => tool.name === id))
  return leaked.length === 0
    ? pass(SCENARIO["b1 enablement marker gates registration"], "an unmarked Location offers no Test Tool, silently")
    : fail(SCENARIO["b1 enablement marker gates registration"], `offered without a marker: ${leaked.join(", ")}`)
}

/**
 * The shipped templates, as the host resolves and enforces them.
 *
 * Two kinds of evidence, both required. The effective rules from `agent.get`
 * are evaluated the way the host evaluates them — last match wins — to show
 * `shell` and Code Mode's `execute` resolve to deny. And the tools a model
 * under that agent is actually offered show the same thing from the other
 * side: every Test Tool present, no shell, no Code Mode.
 */
async function agentScenario(client: HostClient, stub: StubProvider, directory: string): Promise<ScenarioResult> {
  const names = templateNames()

  for (const name of names) {
    const agent = await bounded("agent.get", client.agent.get({ agentID: name, location: { directory } }))
    const rules = agent.data.permissions
    for (const action of ["shell", "execute"]) {
      if (effectiveEffect(rules, action) !== "deny") {
        return fail(SCENARIO["b1 restricted agents"], `${name} does not deny \`${action}\``)
      }
    }
    for (const id of TOOL_IDS) {
      if (effectiveEffect(rules, id) !== "allow") {
        return fail(SCENARIO["b1 restricted agents"], `${name} does not allow ${id}`)
      }
    }

    const offered = offeredNames(await scriptedTurn(client, stub, { directory, agent: name }))
    const absent = TOOL_IDS.filter((id) => !offered.includes(id))
    if (absent.length > 0) {
      return fail(SCENARIO["b1 restricted agents"], `${name} was not offered ${absent.join(", ")}`)
    }
    const forbidden = offered.filter((tool) => tool === "shell" || tool === "execute")
    if (forbidden.length > 0) {
      return fail(SCENARIO["b1 restricted agents"], `${name} was offered ${forbidden.join(", ")}`)
    }
    // The runner promises no file access either, so it is offered the family
    // and nothing else: no read, edit, write, patch, grep or glob.
    const extra = offered.filter((tool) => !(TOOL_IDS as readonly string[]).includes(tool))
    if (name === TEST_RUNNER && extra.length > 0) {
      return fail(SCENARIO["b1 restricted agents"], `${name} was also offered ${extra.join(", ")}`)
    }
  }

  return pass(
    SCENARIO["b1 restricted agents"],
    `${names.join(", ")} deny shell and Code Mode and are offered the family; ${TEST_RUNNER} is offered nothing else`,
  )
}

/** Each tool denied on its own, the other two untouched. */
async function denialScenario(client: HostClient, stub: StubProvider, directory: string): Promise<ScenarioResult> {
  for (const denied of TOOL_IDS) {
    const names = offeredNames(await scriptedTurn(client, stub, { directory, agent: denyingAgent(denied) })).sort()
    const expected = TOOL_IDS.filter((id) => id !== denied).sort()
    if (names.join(",") !== expected.join(",")) {
      return fail(
        SCENARIO["b1 independent denial"],
        `an agent denying only ${denied} was offered ${names.join(", ") || "nothing"}`,
      )
    }
  }
  return pass(SCENARIO["b1 independent denial"], "denying any one Test Tool leaves exactly the other two")
}

type Modules = { nested: string; sibling: string; worktreeNested: string }

/**
 * Isolation across nested modules and worktrees (issue #140's Location map).
 *
 * A marker in one module enables that module's Locations and nothing beside
 * it; a linked worktree of the same repository carries its own marker and is
 * enabled on its own, as its own working copy.
 */
async function isolationScenario(client: HostClient, stub: StubProvider, modules: Modules): Promise<ScenarioResult> {
  const offeredIn = async (directory: string) => offeredNames(await scriptedTurn(client, stub, { directory }))

  const nested = await offeredIn(modules.nested)
  const sibling = await offeredIn(modules.sibling)
  const worktree = await offeredIn(modules.worktreeNested)

  const has = (names: string[]) => TOOL_IDS.every((id) => names.includes(id))
  const none = (names: string[]) => TOOL_IDS.every((id) => !names.includes(id))

  if (!has(nested)) return fail(SCENARIO["b1 location isolation"], "a Location inside a marked module was not offered the family")
  if (!none(sibling)) return fail(SCENARIO["b1 location isolation"], "an unmarked sibling module was offered the family")
  if (!has(worktree)) return fail(SCENARIO["b1 location isolation"], "the same module in a linked worktree was not offered the family")

  return pass(
    SCENARIO["b1 location isolation"],
    "a marked nested module and its linked worktree are enabled; an unmarked sibling stays silent",
  )
}

/**
 * Removing the plugin unloads it; restoring it loads it again.
 *
 * The host watches its config file and rebuilds plugin instances on change,
 * running each instance's cleanup (issue #140). What matters to a user is
 * the model-facing result of each transition, so that is what is checked.
 */
async function reloadScenario(host: BootedHost, stub: StubProvider, directory: string): Promise<ScenarioResult> {
  host.configure(registrationConfig(stub.baseURL, false))
  if (!(await pluginState(host.client, directory, "absent"))) {
    return fail(SCENARIO["b1 plugin reload"], "the plugin was still loaded after it was removed from the config")
  }
  const removed = offeredNames(await scriptedTurn(host.client, stub, { directory }))
  if (TOOL_IDS.some((id) => removed.includes(id))) {
    return fail(SCENARIO["b1 plugin reload"], "the family was still offered after the plugin was removed")
  }

  host.configure(registrationConfig(stub.baseURL, true))
  if (!(await pluginState(host.client, directory, "active"))) {
    return fail(SCENARIO["b1 plugin reload"], "the plugin did not come back after it was restored to the config")
  }
  const restored = offeredNames(await scriptedTurn(host.client, stub, { directory }))
  return TOOL_IDS.every((id) => restored.includes(id))
    ? pass(SCENARIO["b1 plugin reload"], "removing the plugin unloads the family; restoring it brings it back, without a restart")
    : fail(SCENARIO["b1 plugin reload"], "the family was not offered after the plugin was restored")
}

/** Wait, bounded, for the `xcode-test` plugin to reach `wanted` at a Location. */
async function pluginState(client: HostClient, directory: string, wanted: "active" | "absent"): Promise<boolean> {
  const deadline = Date.now() + RELOAD_MS
  while (Date.now() < deadline) {
    const listed = await bounded("plugin.list", client.plugin.list({ location: { directory } }))
    const plugin = listed.data.find((entry) => entry.id === "xcode-test")
    if (wanted === "absent" ? plugin === undefined : plugin?.state.status === "active") return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/** How long a config change may take to reach a Location's plugins. */
const RELOAD_MS = 30_000

// --- permissions ------------------------------------------------------------

export type PermissionRule = { action: string; resource: string; effect: string }

/**
 * The effect of `action` on any resource, the way V2 decides it: the last
 * matching rule wins, and `*` and `?` are whole-value wildcards (issue #140).
 * Only rules whose resource is `*` speak for "any resource".
 */
export function effectiveEffect(rules: ReadonlyArray<PermissionRule>, action: string): string | undefined {
  let effect: string | undefined
  for (const rule of rules) {
    if (rule.resource !== "*" || !wildcard(rule.action).test(action)) continue
    effect = rule.effect
  }
  return effect
}

function wildcard(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${source}$`)
}

// --- fixtures ---------------------------------------------------------------

function templateNames(): string[] {
  return readdirSync(TEMPLATES)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/, ""))
}

function prepareRoot(path: string, options: { marker: boolean }): string {
  mkdirSync(join(path, ".opencode", "agents"), { recursive: true })

  if (options.marker) {
    writeFileSync(join(path, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')
    // The templates are asserted as shipped, not as a copy written by the gate.
    for (const entry of readdirSync(TEMPLATES).filter((name) => name.endsWith(".md"))) {
      copyFileSync(join(TEMPLATES, entry), join(path, ".opencode", "agents", entry))
    }
  }

  return path
}

/**
 * A repository with a marked module and an unmarked sibling, committed, plus
 * a linked worktree of it.
 */
function prepareModules(path: string, roots: DrivenRoots): Modules {
  const repository = join(path, "repository")
  const worktree = join(path, "worktree")
  mkdirSync(join(repository, "module", "deep"), { recursive: true })
  mkdirSync(join(repository, "sibling"), { recursive: true })
  mkdirSync(join(repository, "module", ".opencode"), { recursive: true })
  writeFileSync(join(repository, "module", ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')
  writeFileSync(join(repository, "module", "deep", ".keep"), "")
  writeFileSync(join(repository, "sibling", ".keep"), "")

  git(repository, ["init", "-q"])
  git(repository, ["add", "-A"])
  git(repository, ["-c", "user.name=gate", "-c", "user.email=gate@localhost", "commit", "-q", "-m", "fixture"])
  git(repository, ["worktree", "add", "-q", worktree])

  // Storage is keyed by containment and configuration together, so each
  // enabled module is registered with both (issue #142).
  roots.add(repository, join(repository, "module"))
  roots.add(worktree, join(worktree, "module"))

  return {
    nested: realpathSync(join(repository, "module", "deep")),
    sibling: realpathSync(join(repository, "sibling")),
    worktreeNested: realpathSync(join(worktree, "module", "deep")),
  }
}

/**
 * Git for a fixture, never the user's git: no global config, no hooks, no
 * signing prompt, and bounded — a fixture step that can hang is a gate that
 * can hang.
 */
function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: GIT_MS,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${safeFailure(new Error(result.stderr ?? ""))}`)
}

const GIT_MS = 30_000

function pass(name: ScenarioName, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "passed", detail }
}

function fail(name: ScenarioName, detail: string): ScenarioResult {
  return { name, kind: "gating", status: "failed", detail }
}
