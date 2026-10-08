/**
 * The documented installation path, exercised (issues #27, #142).
 *
 * The README's installation instructions are load-bearing, and they have been
 * wrong before in the quietest possible way: a plugin that never loads is
 * indistinguishable from a project that never opted in. So the instruction is
 * executed rather than reviewed — against an isolated V2 host whose config
 * directory belongs to this run, never the reader's own.
 *
 * The form exercised is V2's discovered plugin directory: the plugin's entry
 * file symlinked into the config directory's plural `plugins/`. Success is
 * judged by what a model is offered, because V2 has no route that lists tools
 * (issue #140).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"
import type { DrivenRoots } from "./driven-roots.ts"
import { bootHost, hostConfigDirectory, loadClient, observedHostVersion, type BootedHost } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { readProvenance } from "./provenance.ts"
import { startStubProvider, stubProviderConfig, type StubProvider } from "./provider.ts"
import type { ScenarioResult } from "./report.ts"
import { SCENARIO } from "./scenarios.ts"
import { scriptedTurn } from "./turn.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")

/** Records its one scenario as it finishes; see `ScenarioSink`. */
export async function runInstallationGate(record: ScenarioSink, roots: DrivenRoots): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-install-"))
  const started = Date.now()
  let stub: StubProvider | undefined
  let host: BootedHost | undefined

  try {
    const loaded = await loadClient()
    if (loaded.status !== "loaded") {
      record(scenario(started, "failed", loaded.detail))
      return
    }

    // Created before it is registered (issue #104): the host canonicalizes,
    // and a path that does not exist yet cannot be.
    const project = join(workspace, "project")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    roots.add(project)
    writeFileSync(join(project, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')

    // Exactly what the README says to do, in a config directory of this run's
    // own: the entry file, linked into the plural `plugins/` directory.
    const plugins = join(hostConfigDirectory(workspace), "plugins")
    mkdirSync(plugins, { recursive: true })
    symlinkSync(PLUGIN, join(plugins, "xcode-test.ts"))

    stub = startStubProvider()
    host = await bootHost({
      workspace,
      config: { $schema: "https://opencode.ai/config.json", providers: stubProviderConfig(stub.baseURL), share: "disabled", update: "disable" },
      cwd: project,
      connect: loaded.connect,
    })

    const offered = ((await scriptedTurn(host.client, stub, { directory: project })).offered ?? []).map((tool) => tool.name)
    const missing = TOOL_IDS.filter((id) => !offered.includes(id))
    record(
      scenario(
        started,
        missing.length === 0 ? "passed" : "failed",
        missing.length === 0
          ? `a plugins-directory symlink, exactly as the README describes it, offers the family (against ${checkoutPackages()})`
          : `installing the documented way offered nothing: ${missing.join(", ")} absent`,
      ),
    )
  } catch (error) {
    record(scenario(started, "failed", `the documented installation could not be exercised: ${safeFailure(error)}`))
  } finally {
    await host?.stop()
    stub?.stop()
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** The package versions this check ran against (issue #81). */
function checkoutPackages(): string {
  const { packages } = readProvenance(observedHostVersion())
  return `plugin ${packages.plugin.version ?? "unknown"}, client ${packages.client.version ?? "unknown"}`
}

function scenario(started: number, status: "passed" | "failed", detail: string): ScenarioResult {
  return {
    name: SCENARIO["b1 documented installation path"],
    kind: "gating",
    status,
    detail,
    durationMs: Date.now() - started,
  }
}
