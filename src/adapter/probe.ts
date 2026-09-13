/**
 * Probing a runtime candidate (ADR 0002).
 *
 * The probe runs a trivial TypeScript file rather than asking for a version
 * string, because the candidate most likely to be wrong is the one that
 * *reports* a perfectly good Bun version: the shipped `opencode` is a
 * Bun-compiled single-file executable, and it cannot execute a `.ts` file at
 * all. Only running one distinguishes them.
 */

import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Written, executed, and deleted. Its output is the entire proof. */
const PROBE_SOURCE = 'const ok: string = "xcode-test-probe"\nconsole.log(ok)\n'
const PROBE_MARKER = "xcode-test-probe"
const PROBE_TIMEOUT_MS = 2_000

export async function probeRuntimeCandidate(
  candidate: string,
): Promise<{ usable: boolean; version?: string }> {
  const directory = mkdtempSync(join(tmpdir(), "xcode-test-probe-"))
  const script = join(directory, "probe.ts")

  try {
    writeFileSync(script, PROBE_SOURCE)
    const output = await run(candidate, [script])
    if (!output.ok || !output.stdout.includes(PROBE_MARKER)) return { usable: false }

    const version = (await run(candidate, ["--version"])).stdout.trim()
    return { usable: true, ...(version.length === 0 ? {} : { version }) }
  } catch {
    return { usable: false }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Bounded, and asynchronous so a probe cannot block the startup deadline. */
function run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    let stdout = ""
    let settled = false

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout })
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(false)
    }, PROBE_TIMEOUT_MS)

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.on("error", () => finish(false))
    child.on("close", (status) => finish(status === 0))
  })
}

/** Where `bun` is on `PATH`, or `undefined` when it is not there at all. */
export function bunOnPath(): string | undefined {
  const result = spawnSync("/usr/bin/env", ["bun", "--version"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  })
  return result.status === 0 ? "bun" : undefined
}
