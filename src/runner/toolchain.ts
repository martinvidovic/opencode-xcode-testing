/**
 * Resolving and freezing the toolchain (#8).
 *
 * The effective developer directory is resolved **once**, before execution, and
 * then frozen by setting `DEVELOPER_DIR` explicitly for both `xcodebuild` and
 * the later `xcresulttool` reads. `/usr/bin/xcodebuild` is only a shim, so
 * identity compares the developer directory and the resolved toolchain rather
 * than the shim — and includes a digest of the `xcresulttool` binary, because
 * an installation replaced in place keeps its path and its version number.
 *
 * Every probe is asynchronous and bounded (issue #153). They used to run
 * through `spawnSync` with no timeout, so a hung `xcrun` or `xcodebuild` held
 * plugin setup — and the host's event loop — for as long as it chose. A probe
 * now answers, times out, or is abandoned with the discovery that asked for it,
 * and in the last two cases its process is killed rather than left behind.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { ToolchainIdentity } from "../domain/toolchain.ts"

export const XCODE_SELECT = "/usr/bin/xcode-select"
export const XCRUN = "/usr/bin/xcrun"
export const XCODEBUILD = "/usr/bin/xcodebuild"

export type ToolchainResolution =
  | { status: "resolved"; identity: ToolchainIdentity }
  | { status: "failed"; message: string }

/**
 * What one probe observed. `timedOut` is set only when the probe was killed
 * for not answering, so "it answered with a failure" and "it never answered"
 * stay distinguishable.
 */
export type ProbeOutcome = { status: number | null; stdout: string; timedOut?: true }

export type ToolchainProbe = (
  command: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<ProbeOutcome>

/**
 * How long one probe may take on its own. `xcodebuild -version` is the slow
 * one, and a cold first run after a reboot has been seen to take seconds; a
 * probe that has not answered in this long is not going to.
 */
export const PROBE_TIMEOUT_MS = 8_000

/**
 * Probe by spawning the command, killing it at `timeoutMs` or when `signal`
 * aborts.
 *
 * `SIGKILL` rather than a polite signal: these are read-only version queries,
 * there is nothing for them to clean up, and a process that ignored the
 * deadline has no claim on a grace period.
 */
export function spawnProbe(options: { timeoutMs?: number; signal?: AbortSignal } = {}): ToolchainProbe {
  return (command, args, env) =>
    new Promise((resolve) => {
      let output = ""
      let timedOut = false
      let settled = false
      const finish = (outcome: ProbeOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abandon)
        resolve(outcome)
      }

      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      })
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))

      const kill = () => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Already gone, which is what killing it was for.
        }
      }
      const abandon = () => kill()
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, options.timeoutMs ?? PROBE_TIMEOUT_MS)
      if (options.signal?.aborted === true) kill()
      else options.signal?.addEventListener("abort", abandon, { once: true })

      child.on("error", () => finish({ status: null, stdout: output }))
      // `close`, not `exit`: it waits for the output streams, so a probe that
      // answers and exits at once is never read as having said nothing.
      child.on("close", (status) =>
        finish(timedOut ? { status: null, stdout: output, timedOut: true } : { status, stdout: output }),
      )
    })
}

/**
 * Resolve every identity fact in one pass. A missing fact fails the whole
 * resolution rather than producing a partial identity — a half-known toolchain
 * cannot be compared against anything later.
 *
 * `signal` abandons discovery: whatever probe is running is killed, and no
 * further one is started.
 */
export async function resolveToolchain(
  options: { probe?: ToolchainProbe; digest?: (path: string) => string; signal?: AbortSignal } = {},
): Promise<ToolchainResolution> {
  const probe =
    options.probe ?? spawnProbe(options.signal === undefined ? {} : { signal: options.signal })

  const selected = await probe(XCODE_SELECT, ["-p"])
  if (selected.timedOut === true) return didNotAnswer("xcode-select")
  if (selected.status !== 0) {
    return { status: "failed", message: "no Xcode developer directory is selected" }
  }
  const developerDirectory = selected.stdout.trim()

  const version = await probe(XCODEBUILD, ["-version"], { DEVELOPER_DIR: developerDirectory })
  if (version.timedOut === true) return didNotAnswer("xcodebuild")
  if (version.status !== 0) {
    return { status: "failed", message: "xcodebuild could not report its version" }
  }
  const xcodeVersion = /Xcode\s+([0-9][0-9.]*)/.exec(version.stdout)?.[1]
  const xcodeBuild = /Build version\s+(\S+)/.exec(version.stdout)?.[1]
  if (xcodeVersion === undefined || xcodeBuild === undefined) {
    return { status: "failed", message: "xcodebuild's version output could not be read" }
  }

  const xcresulttoolPath = join(developerDirectory, "usr", "bin", "xcresulttool")
  const tool = await probe(XCRUN, ["xcresulttool", "version"], { DEVELOPER_DIR: developerDirectory })
  if (tool.timedOut === true) return didNotAnswer("xcresulttool")
  if (tool.status !== 0) {
    return { status: "failed", message: "xcresulttool could not report its version" }
  }
  const xcresulttoolVersion = /version\s+(\d+)/i.exec(tool.stdout)?.[1]
  const schemaVersion = /schema\s+version:?\s+([0-9.]+)/i.exec(tool.stdout)?.[1]
  if (xcresulttoolVersion === undefined || schemaVersion === undefined) {
    return { status: "failed", message: "xcresulttool's version output could not be read" }
  }

  const digest = (options.digest ?? fileDigest)(xcresulttoolPath)
  if (digest === "") {
    return { status: "failed", message: "the xcresulttool binary could not be digested" }
  }

  return {
    status: "resolved",
    identity: {
      developerDirectory,
      xcodeVersion,
      xcodeBuild,
      xcresulttoolPath,
      xcresulttoolVersion,
      xcresulttoolDigest: digest,
      schemaVersion,
    },
  }
}

function didNotAnswer(tool: string): ToolchainResolution {
  return {
    status: "failed",
    message: `${tool} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds and was stopped`,
  }
}

export function fileDigest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return ""
  }
}
