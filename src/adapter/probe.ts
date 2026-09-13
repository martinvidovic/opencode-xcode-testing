/**
 * Probing a runtime candidate (ADR 0002).
 *
 * The probe runs a trivial TypeScript file rather than asking for a version
 * string, because the candidate most likely to be wrong is the one that
 * *reports* a perfectly good Bun version: the shipped `opencode` is a
 * Bun-compiled single-file executable, and it cannot execute a `.ts` file at
 * all. Only running one distinguishes them.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Written, executed, and deleted. Its output is the entire proof. */
const PROBE_SOURCE = 'const ok: string = "xcode-test-probe"\nconsole.log(ok)\n'
const PROBE_MARKER = "xcode-test-probe"
const PROBE_TIMEOUT_MS = 2_000

export function probeRuntimeCandidate(candidate: string): { usable: boolean; version?: string } {
  const directory = mkdtempSync(join(tmpdir(), "xcode-test-probe-"))
  const script = join(directory, "probe.ts")

  try {
    writeFileSync(script, PROBE_SOURCE)
    const result = spawnSync(candidate, [script], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    })
    if (result.status !== 0 || !(result.stdout ?? "").includes(PROBE_MARKER)) {
      return { usable: false }
    }
    return { usable: true, ...versionOf(candidate) }
  } catch {
    return { usable: false }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function versionOf(candidate: string): { version?: string } {
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS })
  const version = (result.stdout ?? "").trim()
  return version.length === 0 ? {} : { version }
}

/** Where `bun` is on `PATH`, or `undefined` when it is not there at all. */
export function bunOnPath(): string | undefined {
  const result = spawnSync("/usr/bin/env", ["bun", "--version"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  })
  return result.status === 0 ? "bun" : undefined
}
