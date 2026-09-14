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
import { safeDiagnostic } from "./diagnostic.ts"
import { bootHost, toolIds } from "./host.ts"
import type { ScenarioResult } from "./report.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")

/** Its own port, so this never adopts the registration gate's host. */
const PORT = 45_741

export async function runInstallationGate(): Promise<ScenarioResult[]> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-install-"))
  const started = Date.now()

  try {
    // Exactly what the README says to do, in a directory of our own.
    const configDirectory = join(workspace, "config")
    mkdirSync(join(configDirectory, "plugin"), { recursive: true })
    symlinkSync(PLUGIN, join(configDirectory, "plugin", "xcode-test.ts"))

    const project = join(workspace, "project")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(join(project, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')

    const host = await bootHost({ port: PORT, configDirectory, cwd: project })
    let registered: string[]
    try {
      registered = await toolIds(host, project)
    } finally {
      host.stop()
    }

    const missing = TOOL_IDS.filter((id) => !registered.includes(id))
    return [
      scenario(
        started,
        missing.length === 0 ? "passed" : "failed",
        missing.length === 0
          ? "a plugin-directory symlink, exactly as the README describes it, registers the family"
          : `installing the documented way registered nothing: ${missing.join(", ")} absent`,
      ),
    ]
  } catch (error) {
    return [
      scenario(started, "failed", `the documented installation could not be exercised: ${safeDiagnostic(error)}`),
    ]
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function scenario(started: number, status: "passed" | "failed", detail: string): ScenarioResult {
  return {
    name: "b1 documented installation path",
    kind: "gating",
    status,
    detail,
    durationMs: Date.now() - started,
  }
}
