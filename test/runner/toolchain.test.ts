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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

  test("is killed with everything it started, even what still holds its output open", async () => {
    // `xcrun` is a launcher: what hangs is often a process it started, which
    // inherits the probe's pipes. Killing only the direct child would leave
    // that one holding them open, and a probe that waits for its output to
    // close would wait as long as it ran.
    const marker = "xcode-test-grandchild-probe-153"
    const started = performance.now()

    const outcome = await spawnProbe({ timeoutMs: 200 })("/bin/sh", ["-c", `/bin/sleep 30 & wait # ${marker}`])

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(outcome.timedOut).toBe(true)
    const stragglers = spawnSync("/usr/bin/pgrep", ["-f", "sleep 30"], { encoding: "utf8" }).stdout
    const ours = spawnSync("/bin/ps", ["-o", "pid=,command=", "-p", stragglers.split("\n").filter(Boolean).join(",") || "0"], {
      encoding: "utf8",
    }).stdout
    expect(ours).not.toContain(marker)
  })

  test("is never started once discovery has been abandoned", async () => {
    const started: string[] = []
    const abandon = new AbortController()
    abandon.abort()

    await resolveToolchain({
      environment: {},
      signal: abandon.signal,
      probe: async (command) => {
        started.push(command)
        return { status: 0, stdout: "/Applications/Xcode.app/Contents/Developer\n" }
      },
      digest: () => "digest",
    })

    expect(started).toEqual([])
  })

  test("fails discovery with a reason naming what did not answer", async () => {
    const resolution = await resolveToolchain({
      environment: {},
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
    const resolution = await resolveToolchain({ environment: {}, probe: scripted(), digest: () => "digest" })

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
      selectedBy: "system",
    })
  })

  test("is answered through a real spawn, output and status intact", async () => {
    const outcome = await spawnProbe({ timeoutMs: 5_000 })("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"])

    expect(outcome).toEqual({ status: 3, stdout: "out\nerr\n" })
  })
})

describe("which developer directory is used (issue #164)", () => {
  const XCODE = "/Applications/Xcode.app/Contents/Developer"
  const OTHER = "/Applications/Xcode-beta.app/Contents/Developer"
  const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools"

  /** Answers only for `usable`; records what ran, under which DEVELOPER_DIR. */
  function machine(usable: string[], ran: string[]): ToolchainProbe {
    return async (command, _args, env) => {
      ran.push(`${command.split("/").pop()}${env?.DEVELOPER_DIR === undefined ? "" : ` @ ${env.DEVELOPER_DIR}`}`)
      if (command.endsWith("xcode-select")) return { status: 0, stdout: `${COMMAND_LINE_TOOLS}\n` }
      if (env?.DEVELOPER_DIR === undefined || !usable.includes(env.DEVELOPER_DIR)) {
        return { status: 1, stdout: "xcode-select: error: tool 'xcodebuild' requires Xcode" }
      }
      return command.endsWith("xcodebuild")
        ? { status: 0, stdout: "Xcode 27.0\nBuild version 27A266a\n" }
        : { status: 0, stdout: "xcresulttool version 25115, schema version: 0.4.0\n" }
    }
  }

  test("is the configured one, without consulting the system selection", async () => {
    const ran: string[] = []

    const resolution = await resolveToolchain({
      developerDirectory: XCODE,
      environment: {},
      probe: machine([XCODE], ran),
      digest: () => "digest",
    })

    expect(resolution).toMatchObject({ status: "resolved", identity: { developerDirectory: XCODE } })
    expect(ran).toEqual([`xcodebuild @ ${XCODE}`, `xcrun @ ${XCODE}`])
  })

  test("is the configured one even when the environment names another", async () => {
    const ran: string[] = []

    const resolution = await resolveToolchain({
      developerDirectory: XCODE,
      environment: { DEVELOPER_DIR: OTHER },
      probe: machine([XCODE, OTHER], ran),
      digest: () => "digest",
    })

    expect(resolution).toMatchObject({ status: "resolved", identity: { developerDirectory: XCODE } })
  })

  test("fails closed when the configured one is unusable, naming it and falling back to nothing", async () => {
    const ran: string[] = []

    const resolution = await resolveToolchain({
      developerDirectory: COMMAND_LINE_TOOLS,
      environment: { DEVELOPER_DIR: XCODE },
      probe: machine([XCODE], ran),
      digest: () => "digest",
    })

    expect(resolution.status).toBe("failed")
    if (resolution.status !== "failed") return
    expect(resolution.message).toContain("the configured developerDirectory")
    expect(resolution.message).toContain("full Xcode")
    expect(resolution.message).not.toContain(COMMAND_LINE_TOOLS)
    expect(ran).toEqual([`xcodebuild @ ${COMMAND_LINE_TOOLS}`])
  })

  test("is an inherited DEVELOPER_DIR when nothing is configured", async () => {
    const ran: string[] = []

    const resolution = await resolveToolchain({
      environment: { DEVELOPER_DIR: XCODE },
      probe: machine([XCODE], ran),
      digest: () => "digest",
    })

    expect(resolution).toMatchObject({ status: "resolved", identity: { developerDirectory: XCODE } })
    expect(ran).toEqual([`xcodebuild @ ${XCODE}`, `xcrun @ ${XCODE}`])
  })

  test("names an unusable inherited DEVELOPER_DIR as the thing to fix", async () => {
    const resolution = await resolveToolchain({
      environment: { DEVELOPER_DIR: COMMAND_LINE_TOOLS },
      probe: machine([XCODE], []),
      digest: () => "digest",
    })

    expect(resolution.status).toBe("failed")
    if (resolution.status !== "failed") return
    expect(resolution.message).toContain("DEVELOPER_DIR")
  })

  test("is the system selection when neither is set", async () => {
    const ran: string[] = []

    const resolution = await resolveToolchain({ environment: {}, probe: machine([XCODE], ran), digest: () => "digest" })

    expect(resolution.status).toBe("failed")
    if (resolution.status !== "failed") return
    expect(resolution.message).toContain("system")
    expect(ran).toEqual(["xcode-select", `xcodebuild @ ${COMMAND_LINE_TOOLS}`])
  })

  test("fails when the selected directory does not hold the xcresulttool it answered for", async () => {
    // xcrun can answer from somewhere other than the directory it was given;
    // the digest is taken where results will be read from, and finding
    // nothing there is a toolchain that does not match itself.
    const resolution = await resolveToolchain({
      developerDirectory: XCODE,
      environment: {},
      probe: machine([XCODE], []),
      digest: () => "",
    })

    expect(resolution.status).toBe("failed")
    if (resolution.status !== "failed") return
    expect(resolution.message).toContain("xcresulttool")
  })
})

describe("a selection that cannot be trusted as given (review of #164)", () => {
  const XCODE = "/Applications/Xcode.app/Contents/Developer"

  test("refuses an inherited DEVELOPER_DIR that is not an absolute path", async () => {
    const ran: string[] = []
    const resolution = await resolveToolchain({
      environment: { DEVELOPER_DIR: "Xcode.app/Contents/Developer" },
      probe: async (command) => {
        ran.push(command)
        return { status: 0, stdout: "" }
      },
      digest: () => "digest",
    })

    expect(resolution.status).toBe("failed")
    if (resolution.status !== "failed") return
    expect(resolution.message).toContain("DEVELOPER_DIR is not an absolute path")
    // And no fallback to the system selection in its place.
    expect(ran).toEqual([])
  })

  test("asks the system selection without an inherited DEVELOPER_DIR it would echo back", async () => {
    const asked: Array<Readonly<Record<string, string | undefined>> | undefined> = []
    await resolveToolchain({
      environment: { DEVELOPER_DIR: "" },
      probe: async (command, _args, env) => {
        if (command.endsWith("xcode-select")) asked.push(env)
        return { status: 1, stdout: "" }
      },
      digest: () => "digest",
    })

    expect(asked).toHaveLength(1)
    expect(asked[0]).toHaveProperty("DEVELOPER_DIR", undefined)
  })

  test("fails as a mismatch when the selected directory does not hold the xcresulttool that answered", async () => {
    // The real digest, over a directory that has no xcresulttool in it: xcrun
    // answered from somewhere else.
    const empty = mkdtempSync(join(tmpdir(), "xcode-test-mismatch-"))
    try {
      const resolution = await resolveToolchain({
        developerDirectory: empty,
        environment: {},
        probe: async (command) =>
          command.endsWith("xcodebuild")
            ? { status: 0, stdout: "Xcode 27.0\nBuild version 27A266a\n" }
            : { status: 0, stdout: "xcresulttool version 25115, schema version: 0.4.0\n" },
      })

      expect(resolution.status).toBe("failed")
      if (resolution.status !== "failed") return
      expect(resolution.message).toContain("not in the selected directory")
      expect(resolution.message).not.toContain(empty)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test("records which setting chose the directory it resolved", async () => {
    const resolution = await resolveToolchain({
      environment: { DEVELOPER_DIR: XCODE },
      probe: scripted(),
      digest: () => "digest",
    })

    expect(resolution).toMatchObject({ status: "resolved", selectedBy: "environment" })
  })
})
