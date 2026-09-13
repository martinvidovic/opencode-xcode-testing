/**
 * Resolving and freezing the toolchain (#8).
 *
 * The effective developer directory is resolved **once**, before execution, and
 * then frozen by setting `DEVELOPER_DIR` explicitly for both `xcodebuild` and
 * the later `xcresulttool` reads. `/usr/bin/xcodebuild` is only a shim, so
 * identity compares the developer directory and the resolved toolchain rather
 * than the shim — and includes a digest of the `xcresulttool` binary, because
 * an installation replaced in place keeps its path and its version number.
 */

import { spawnSync } from "node:child_process"
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

export type ToolchainProbe = (command: string, args: string[], env?: Record<string, string>) => {
  status: number | null
  stdout: string
}

const systemProbe: ToolchainProbe = (command, args, env) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

/**
 * Resolve every identity fact in one pass. A missing fact fails the whole
 * resolution rather than producing a partial identity — a half-known toolchain
 * cannot be compared against anything later.
 */
export function resolveToolchain(
  options: { probe?: ToolchainProbe; digest?: (path: string) => string } = {},
): ToolchainResolution {
  const probe = options.probe ?? systemProbe

  const selected = probe(XCODE_SELECT, ["-p"])
  if (selected.status !== 0) {
    return { status: "failed", message: "no Xcode developer directory is selected" }
  }
  const developerDirectory = selected.stdout.trim()

  const version = probe(XCODEBUILD, ["-version"], { DEVELOPER_DIR: developerDirectory })
  if (version.status !== 0) {
    return { status: "failed", message: "xcodebuild could not report its version" }
  }
  const xcodeVersion = /Xcode\s+([0-9][0-9.]*)/.exec(version.stdout)?.[1]
  const xcodeBuild = /Build version\s+(\S+)/.exec(version.stdout)?.[1]
  if (xcodeVersion === undefined || xcodeBuild === undefined) {
    return { status: "failed", message: "xcodebuild's version output could not be read" }
  }

  const xcresulttoolPath = join(developerDirectory, "usr", "bin", "xcresulttool")
  const tool = probe(XCRUN, ["xcresulttool", "version"], { DEVELOPER_DIR: developerDirectory })
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

export function fileDigest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex")
  } catch {
    return ""
  }
}
