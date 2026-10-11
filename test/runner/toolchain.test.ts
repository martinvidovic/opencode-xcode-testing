/**
 * Toolchain discovery that cannot hang setup (issue #153).
 *
 * The probes behind discovery — `xcode-select`, `xcodebuild -version`,
 * `xcrun xcresulttool version` — used to run through `spawnSync` with no
 * timeout, after the startup deadline had already been met. A probe that never
 * exited held plugin setup, and the host's event loop with it, for as long as
 * it chose. These tests are about the bound: a probe that does not answer is
 * killed, and discovery says so rather than waiting.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

import {
  resolveToolchain,
  spawnProbe,
  XCODEBUILD,
  type ToolchainProbe,
} from "../../src/runner/toolchain.ts"

/** The children of this process still running `command`, by PID. */
function childrenRunning(command: string): string[] {
  const result = spawnSync("/usr/bin/pgrep", ["-P", String(process.pid), "-f", command], { encoding: "utf8" })
  return result.stdout.split("\n").filter((line) => line.trim() !== "")
}

/** Answers every probe as a healthy Xcode 27 would, except where told not to. */
function scripted(overrides: Record<string, Awaited<ReturnType<ToolchainProbe>>> = {}): ToolchainProbe {
  return async (command) => {
    const override = overrides[command]
    if (override !== undefined) return override
    if (command.endsWith("xcode-select")) return { status: 0, stdout: "/Applications/Xcode.app/Contents/Developer\n" }
    if (command.endsWith("xcodebuild")) return { status: 0, stdout: "Xcode 27.0\nBuild version 27A266a\n" }
    return { status: 0, stdout: "xcresulttool version 24000, format version 3.53 (current), schema version: 0.1.0\n" }
  }
}

describe("a probe that never exits", () => {
  test("is killed at its timeout, and reports that it timed out", async () => {
    const marker = "xcode-test-hung-probe-153"
    const started = performance.now()

    const outcome = await spawnProbe({ timeoutMs: 200 })("/bin/sh", ["-c", `exec /bin/sleep 30 # ${marker}`])

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.status).toBeNull()
    expect(childrenRunning(marker)).toEqual([])
  })

  test("is killed when discovery is abandoned, without waiting out its timeout", async () => {
    const marker = "xcode-test-abandoned-probe-153"
    const abandon = new AbortController()
    setTimeout(() => abandon.abort(), 100)
    const started = performance.now()

    const outcome = await spawnProbe({ timeoutMs: 30_000, signal: abandon.signal })("/bin/sh", [
      "-c",
      `exec /bin/sleep 30 # ${marker}`,
    ])

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(outcome.status).toBeNull()
    expect(childrenRunning(marker)).toEqual([])
  })

  test("fails discovery with a reason naming what did not answer", async () => {
    const resolution = await resolveToolchain({
      probe: scripted({ [XCODEBUILD]: { status: null, stdout: "", timedOut: true } }),
      digest: () => "digest",
    })

    expect(resolution.status).toBe("failed")
    if (resolution.status !== "failed") return
    expect(resolution.message).toContain("xcodebuild")
    expect(resolution.message).toContain("did not answer")
  })
})

describe("a probe that answers", () => {
  test("is read into a resolved identity", async () => {
    const resolution = await resolveToolchain({ probe: scripted(), digest: () => "digest" })

    expect(resolution).toEqual({
      status: "resolved",
      identity: {
        developerDirectory: "/Applications/Xcode.app/Contents/Developer",
        xcodeVersion: "27.0",
        xcodeBuild: "27A266a",
        xcresulttoolPath: "/Applications/Xcode.app/Contents/Developer/usr/bin/xcresulttool",
        xcresulttoolVersion: "24000",
        xcresulttoolDigest: "digest",
        schemaVersion: "0.1.0",
      },
    })
  })

  test("is answered through a real spawn, output and status intact", async () => {
    const outcome = await spawnProbe({ timeoutMs: 5_000 })("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"])

    expect(outcome).toEqual({ status: 3, stdout: "out\nerr\n" })
  })
})
