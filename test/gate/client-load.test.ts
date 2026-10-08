/**
 * The gate's client, loaded from this checkout (issue #142).
 *
 * `@opencode/client` is a pinned dependency of this checkout now, not a module
 * found under the user's config directory. What is left to show is that the
 * gate loads it and that every request it makes carries the isolated host's
 * own credentials — a client that forgot them would be refused by the host,
 * and one that sent somebody else's would be talking to the wrong server.
 */

import { describe, expect, test } from "bun:test"

import { basicAuth, loadClient } from "../../scripts/gate/host.ts"

describe("the gate's client", () => {
  test("loads from this checkout", async () => {
    expect((await loadClient()).status).toBe("loaded")
  })

  test("authenticates every request to the host it was pointed at", async () => {
    const seen: Array<string | null> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization"))
        return Response.json({ version: "2.0.25", pid: 1, urls: [], paths: { tmp: "/tmp" }, capabilities: {} })
      },
    })
    try {
      const loaded = await loadClient()
      if (loaded.status !== "loaded") throw new Error(loaded.detail)

      const info = await loaded.connect(`http://127.0.0.1:${server.port}`, "secret").server.info()
      expect(info.version).toBe("2.0.25")
      expect(seen).toEqual([basicAuth("secret")])
    } finally {
      server.stop(true)
    }
  })
})
