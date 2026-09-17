/**
 * The documented installation path, exercised (issue #27).
 *
 * The README tells someone to symlink the plugin into OpenCode's plugin
 * directory. That instruction is load-bearing and, until this ran, it was
 * wrong: it symlinked the *checkout* rather than the plugin file, and the host
 * has no way to pick an entry point out of a repository. Nothing failed
 * loudly — the plugin simply never loaded, which is indistinguishable from a
 * project that never opted in.
 *
 * So the instruction is executed rather than reviewed. The host runs against a
 * throwaway config directory, never the reader's own: a gate that installed
 * itself into someone's real OpenCode would be changing the machine it is
 * supposed to be measuring.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { bootHost, observedHostVersion, toolIds } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { readProvenance } from "./provenance.ts"
import { SCENARIO } from "./scenarios.ts"
import type { ScenarioResult } from "./report.ts"
import type { DrivenRoots } from "./driven-roots.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")

/** Records its one scenario as it finishes; see `ScenarioSink`. */
export async function runInstallationGate(
  record: ScenarioSink,
  roots: DrivenRoots,
): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-install-"))
  const started = Date.now()

  try {
    // Exactly what the README says to do, in a directory of our own.
    const configDirectory = join(workspace, "config")
    mkdirSync(join(configDirectory, "plugin"), { recursive: true })
    symlinkSync(PLUGIN, join(configDirectory, "plugin", "xcode-test.ts"))

    // Registered so the run can collect the per-root storage a live host
    // creates for it. The project goes with the workspace below; that storage
    // would not, and nothing downstream can ever collect it (issue #98).
    // Created *before* it is registered (issue #104). `DrivenRoots` addresses
    // a root by the key the host will use, and the host canonicalizes — which
    // a path that does not exist yet cannot be. Registering first fell back to
    // the path as written, produced a key for a directory nothing ever creates,
    // and left this suite's storage uncollected once per run while every
    // `existsSync` on the way politely declined to notice.
    const project = join(workspace, "project")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    roots.add(project)
    writeFileSync(join(project, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')

    const host = await bootHost({ configDirectory, cwd: project })
    let registered: string[]
    try {
      registered = await toolIds(host, project)
    } finally {
      await host.stop()
    }

    const missing = TOOL_IDS.filter((id) => !registered.includes(id))
    record(
      scenario(
        started,
        missing.length === 0 ? "passed" : "failed",
        missing.length === 0
          ? `a plugin-directory symlink, exactly as the README describes it, registers the family (against ${linkedPackages()})`
          : `installing the documented way registered nothing: ${missing.join(", ")} absent`,
      ),
    )
  } catch (error) {
    record(
      scenario(started, "failed", `the documented installation could not be exercised: ${safeFailure(error)}`),
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/**
 * The package versions this check actually registered against (issue #81).
 *
 * The gate builds its own config directory and symlinks the plugin *source*,
 * so at first glance the host's package tree has nothing to do with it. It
 * has everything to do with it: that source imports `@opencode-ai/plugin`,
 * which resolves through this checkout's `node_modules` symlink into exactly
 * the host-managed tree. A green installation check is a claim about a
 * package version, and it should say which.
 */
function linkedPackages(): string {
  const { packages } = readProvenance(observedHostVersion())
  return `plugin ${packages.plugin.version ?? "unknown"}, sdk ${packages.sdk.version ?? "unknown"}`
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
