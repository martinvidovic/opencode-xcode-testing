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
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_IDS } from "../../src/adapter/descriptions.ts"
import type { ScenarioResult } from "./report.ts"

const REPO = join(import.meta.dir, "..", "..")
const PLUGIN = join(REPO, "src", "adapter", "plugin.ts")
const PORT = 45_741

/** Generous: this boots a host that loads and starts the plugin. */
const BOOT_MS = 90_000

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

    const ids = await toolIds(configDirectory, project)
    const missing = TOOL_IDS.filter((id) => !ids.includes(id))

    return [
      {
        name: "b1 documented installation path",
        kind: "gating",
        status: missing.length === 0 ? "passed" : "failed",
        detail:
          missing.length === 0
            ? "a plugin-directory symlink, exactly as the README describes it, registers the family"
            : `installing the documented way registered nothing: ${missing.join(", ")} absent`,
        durationMs: Date.now() - started,
      },
    ]
  } catch (error) {
    return [
      {
        name: "b1 documented installation path",
        kind: "gating",
        status: "failed",
        detail: `the documented installation could not be exercised: ${String(error)}`,
        durationMs: Date.now() - started,
      },
    ]
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

/** Boot a host against this config directory and ask what it registered. */
async function toolIds(configDirectory: string, project: string): Promise<string[]> {
  const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", `--port=${PORT}`], {
    cwd: project,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  })

  try {
    await listening(child)
    const response = await fetch(
      `http://127.0.0.1:${PORT}/experimental/tool/ids?directory=${encodeURIComponent(project)}`,
      { signal: AbortSignal.timeout(30_000) },
    )
    return (await response.json()) as string[]
  } finally {
    // Its own process group would be tidier, but this child is ours alone and
    // the workspace it reads goes with it.
    child.kill("SIGKILL")
  }
}

function listening(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(
      () => reject(new Error(`the host did not start within ${BOOT_MS}ms`)),
      BOOT_MS,
    )

    const settle = (error?: Error) => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.includes("server listening")) settle()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    child.on("error", (error) => settle(error))
    child.on("exit", (code) => settle(new Error(`the host exited with ${code ?? "no code"}`)))
  })
}
