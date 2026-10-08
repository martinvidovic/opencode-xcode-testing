/**
 * Host readiness is the child this gate spawned, never a stale listener
 * (issues #125, #142).
 *
 * A child that prints "listening" names a port; the server answering on that
 * port must then report the child's own pid. Both are required. A leftover
 * listener from a killed run — or anything else on that port — fails the
 * second check, so it can never be driven as though it were the host.
 *
 * The launcher is controlled, so no OpenCode is needed: a `bun -e` child
 * stands in for `opencode serve` and prints whatever line the case needs.
 */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { basicAuth, bootHost, hostConfigDirectory, type HostClient, type HostLauncher } from "../../scripts/gate/host.ts"

/** A child that announces `port` as its own and then idles. */
function announcing(port: number): HostLauncher {
  return ({ options }) =>
    spawn("bun", ["-e", `console.log("server listening on http://127.0.0.1:${port}"); setInterval(() => {}, 1000)`], {
      ...options,
      env: process.env,
    })
}

/** A client whose server claims to be whatever pid it is told. */
function clientReporting(pid: () => number | undefined): HostClient {
  return {
    server: { info: async () => ({ version: "2.0.25", pid: pid() ?? -1 }) },
  } as unknown as HostClient
}

function withWorkspace<T>(work: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-host-"))
  return work(workspace).finally(() => rmSync(workspace, { recursive: true, force: true }))
}

describe("a host whose announced port is answered by somebody else", () => {
  test("is refused, however plausible the answer", async () => {
    const stale = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("stale listener") })
    try {
      await withWorkspace(async (workspace) => {
        await expect(
          bootHost(
            { workspace, config: {}, cwd: import.meta.dir, connect: () => clientReporting(() => 4242) },
            announcing(stale.port ?? 0),
          ),
        ).rejects.toThrow("not the host this gate started")
      })
    } finally {
      stale.stop(true)
    }
  })
})

describe("a host that is the child this gate spawned", () => {
  test("is ready, on the port it announced", async () => {
    let child: number | undefined
    const launch: HostLauncher = (input) => {
      const spawned = announcing(51_234)(input)
      child = spawned.pid
      return spawned
    }

    await withWorkspace(async (workspace) => {
      const host = await bootHost(
        { workspace, config: { share: "disabled" }, cwd: import.meta.dir, connect: () => clientReporting(() => child) },
        launch,
      )
      try {
        expect(host.port).toBe(51_234)
        expect(host.version).toBe("2.0.25")
      } finally {
        await host.stop()
      }
    })
  })

  test("reads its configuration from a config directory of this run's own", async () => {
    let child: number | undefined
    let environment: NodeJS.ProcessEnv | undefined
    const launch: HostLauncher = (input) => {
      environment = input.options.env
      const spawned = announcing(51_235)(input)
      child = spawned.pid
      return spawned
    }

    await withWorkspace(async (workspace) => {
      const host = await bootHost(
        { workspace, config: { share: "disabled" }, cwd: import.meta.dir, connect: () => clientReporting(() => child) },
        launch,
      )
      try {
        const configFile = join(hostConfigDirectory(workspace), "opencode.json")
        expect(existsSync(configFile)).toBe(true)
        expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ share: "disabled" })

        // Never the user's: every XDG directory is beneath this run's
        // workspace, and the server has a password of its own.
        for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
          expect(environment?.[key]?.startsWith(workspace)).toBe(true)
        }
        expect(environment?.["OPENCODE_SERVER_PASSWORD"]?.length).toBeGreaterThan(16)

        host.configure({ share: "manual" })
        expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ share: "manual" })
      } finally {
        await host.stop()
      }
    })
  })
})

describe("authentication", () => {
  test("is HTTP Basic for the `opencode` user", () => {
    expect(basicAuth("secret")).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
  })
})
