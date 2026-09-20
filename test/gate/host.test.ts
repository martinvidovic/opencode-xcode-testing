/** The host startup observer rejects a failed new child, not a stale endpoint. */

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bootHost } from "../../scripts/gate/host.ts"

describe("a B1 host startup with a stale listener", () => {
  test("fails from the new child while the old fixed endpoint remains reachable", async () => {
    const stale = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("stale listener"),
    })
    const configDirectory = mkdtempSync(join(tmpdir(), "xcode-test-occupied-port-"))
    const port = stale.port

    try {
      if (port === undefined) throw new Error("expected the stale listener port")
      const before = await fetch(`http://127.0.0.1:${port}/global/health`)
      expect(await before.text()).toBe("stale listener")

      await expect(
        bootHost(
          { configDirectory, cwd: import.meta.dir, requestedPort: port },
          ({ arguments: args }) =>
            spawn("bun", ["-e", `Bun.serve({ hostname: "127.0.0.1", port: ${port} })`, ...args]),
        ),
      ).rejects.toThrow("the host exited with 1")

      const after = await fetch(`http://127.0.0.1:${port}/global/health`)
      expect(await after.text()).toBe("stale listener")
    } finally {
      stale.stop(true)
      rmSync(configDirectory, { recursive: true, force: true })
    }
  })
})
