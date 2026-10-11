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
  /**
   * `timedOut` marks a probe that never answered (issue #162): probing again
   * may succeed. Any other failure is an answer, and gives the same one again.
   */
  | { status: "failed"; message: string; timedOut?: true }

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
 * probe that has not answered in this long is not going to. Shorter than the
 * startup budget for discovery as a whole, so that a hung probe is reported as
 * the probe that hung rather than as discovery running out of time.
 */
export const PROBE_TIMEOUT_MS = 6_000

/**
 * Probe by spawning the command, killing it at `timeoutMs` or when `signal`
 * aborts.
 *
 * `SIGKILL` rather than a polite signal: these are read-only version queries,
 * there is nothing for them to clean up, and a process that ignored the
 * deadline has no claim on a grace period.
 *
 * The probe leads its own process group, and the whole group is killed.
 * `xcrun` is a launcher, and what hangs is often a process it started — one
 * that inherits the probe's pipes and would hold them open, and the probe with
 * them, if only the direct child were killed.
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
        detached: true,
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      })
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))

      let killed = false
      const kill = () => {
        killed = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
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
      // A killed probe settles on `exit`: its answer no longer matters, and
      // waiting for its pipes to close is waiting on whatever still holds them.
      child.on("exit", () => {
        if (killed) finish(timedOut ? { status: null, stdout: output, timedOut: true } : { status: null, stdout: output })
      })
      // One that answered settles on `close`, which waits for the output
      // streams, so a probe that answers and exits at once is never read as
      // having said nothing.
      child.on("close", (status) => finish({ status, stdout: output }))
    })
}

/**
 * Where the developer directory came from (issue #164), in precedence order.
 *
 * - **configuration** — `developerDirectory` in the project configuration. It
 *   is used as given, and an unusable one is a hard error: falling back to
 *   whatever else is installed would test against an Xcode nobody chose.
 * - **environment** — a `DEVELOPER_DIR` the OpenCode service inherited, which
 *   is how a toolchain wrapper selects an Xcode for a shell. Read explicitly
 *   rather than left to `xcode-select -p`, which happens to honour it, so the
 *   precedence is this file's decision and not a side effect.
 * - **system** — `xcode-select -p`, the machine-wide selection.
 *
 * Whichever it is, the directory is frozen into the identity, and execution
 * and every later `xcresulttool` read run under that same `DEVELOPER_DIR`.
 */
export type DeveloperDirectorySource = "configuration" | "environment" | "system"

/**
 * How a selection is named in a failure. Never the path: it is machine-local,
 * and what a caller can act on is which setting to change.
 */
const SELECTED_BY: Record<DeveloperDirectorySource, string> = {
  configuration: "the configured developerDirectory",
  environment: "the DEVELOPER_DIR this OpenCode inherited",
  system: "the system Xcode selection (xcode-select -p)",
}

/** What to do about a selection that is not a usable full Xcode. */
const REMEDY: Record<DeveloperDirectorySource, string> = {
  configuration:
    "it must name a full Xcode installation's Contents/Developer, not Command Line Tools. Correct or remove developerDirectory in .opencode/xcode-test.json.",
  environment:
    "it must name a full Xcode installation's Contents/Developer, not Command Line Tools. Correct DEVELOPER_DIR where OpenCode is started, or set developerDirectory in .opencode/xcode-test.json.",
  system:
    "a full Xcode is needed, not Command Line Tools. Set developerDirectory in .opencode/xcode-test.json, or start OpenCode with DEVELOPER_DIR set; the system selection is never changed for you.",
}

/**
 * Resolve every identity fact in one pass. A missing fact fails the whole
 * resolution rather than producing a partial identity — a half-known toolchain
 * cannot be compared against anything later.
 *
 * `signal` abandons discovery: whatever probe is running is killed, and no
 * further one is started. `environment` is where an inherited `DEVELOPER_DIR`
 * is read from, and defaults to this process's.
 */
export async function resolveToolchain(
  options: {
    developerDirectory?: string
    environment?: Readonly<Record<string, string | undefined>>
    probe?: ToolchainProbe
    digest?: (path: string) => string
    signal?: AbortSignal
  } = {},
): Promise<ToolchainResolution> {
  const unguarded =
    options.probe ?? spawnProbe(options.signal === undefined ? {} : { signal: options.signal })
  // Abandoned discovery starts nothing further: a probe spawned only to be
  // killed at once is a process nobody wanted.
  const probe: ToolchainProbe = (command, args, env) =>
    options.signal?.aborted === true ? Promise.resolve({ status: null, stdout: "" }) : unguarded(command, args, env)

  const selection = await selectDeveloperDirectory(options, probe)
  if (selection.status === "failed") return selection
  const { developerDirectory, source } = selection
  const failed = (problem: string, remedy = ""): ToolchainResolution => ({
    status: "failed",
    message: `${problem} for ${SELECTED_BY[source]}${remedy === "" ? "" : `: ${remedy}`}`,
  })

  const version = await probe(XCODEBUILD, ["-version"], { DEVELOPER_DIR: developerDirectory })
  if (version.timedOut === true) return didNotAnswer("xcodebuild", source)
  if (version.status !== 0) return failed("xcodebuild could not report its version", REMEDY[source])
  const xcodeVersion = /Xcode\s+([0-9][0-9.]*)/.exec(version.stdout)?.[1]
  const xcodeBuild = /Build version\s+(\S+)/.exec(version.stdout)?.[1]
  if (xcodeVersion === undefined || xcodeBuild === undefined) {
    return failed("xcodebuild's version output could not be read")
  }

  const xcresulttoolPath = join(developerDirectory, "usr", "bin", "xcresulttool")
  const tool = await probe(XCRUN, ["xcresulttool", "version"], { DEVELOPER_DIR: developerDirectory })
  if (tool.timedOut === true) return didNotAnswer("xcresulttool", source)
  if (tool.status !== 0) return failed("xcresulttool could not report its version", REMEDY[source])
  const xcresulttoolVersion = /version\s+(\d+)/i.exec(tool.stdout)?.[1]
  const schemaVersion = /schema\s+version:?\s+([0-9.]+)/i.exec(tool.stdout)?.[1]
  if (xcresulttoolVersion === undefined || schemaVersion === undefined) {
    return failed("xcresulttool's version output could not be read")
  }

  // Taken where results will be read from. `xcrun` can answer from elsewhere,
  // and a directory that does not hold the tool that answered for it is a
  // toolchain that does not match itself.
  const digest = (options.digest ?? fileDigest)(xcresulttoolPath)
  if (digest === "") return failed("the xcresulttool binary could not be found and digested")

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

async function selectDeveloperDirectory(
  options: { developerDirectory?: string; environment?: Readonly<Record<string, string | undefined>> },
  probe: ToolchainProbe,
): Promise<{ status: "selected"; developerDirectory: string; source: DeveloperDirectorySource } | Extract<ToolchainResolution, { status: "failed" }>> {
  if (options.developerDirectory !== undefined) {
    return { status: "selected", developerDirectory: options.developerDirectory, source: "configuration" }
  }
  const inherited = (options.environment ?? process.env)["DEVELOPER_DIR"]?.trim()
  if (inherited !== undefined && inherited !== "") {
    return { status: "selected", developerDirectory: inherited, source: "environment" }
  }

  const selected = await probe(XCODE_SELECT, ["-p"])
  if (selected.timedOut === true) return didNotAnswer("xcode-select", "system")
  if (selected.status !== 0) return { status: "failed", message: "no Xcode developer directory is selected" }
  return { status: "selected", developerDirectory: selected.stdout.trim(), source: "system" }
}

function didNotAnswer(
  tool: string,
  source: DeveloperDirectorySource,
): Extract<ToolchainResolution, { status: "failed" }> {
  return {
    status: "failed",
    message: `${tool} did not answer in time and was stopped, for ${SELECTED_BY[source]}`,
    timedOut: true,
  }
}

export function fileDigest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return ""
  }
}
