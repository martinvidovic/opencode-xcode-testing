/**
 * Where the gate's servers listen (issue #125).
 *
 * Four fixed numbers, four servers, and an assumption that all four were free.
 * The assumption failed in the ordinary way — a killed invocation leaves one
 * held, two invocations overlap — and it failed silently, which is the part
 * worth a file.
 *
 * `ports.ts` holds the reasoning, including why the two kinds of server are
 * fixed two different ways. What is here is what can be shown in this layer:
 * a server this repository starts, proved to come up with every one of the
 * old numbers held against it, and the helper that reads a spawned host's
 * port from its own line. The spawned host's ownership check is in
 * `host.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import { reportedPort } from "../../scripts/gate/ports.ts"
import { startStubProvider, STUB_MODEL_ID } from "../../scripts/gate/provider.ts"

/** The numbers the gate used to hard-code, before this. */
const FORMERLY_FIXED = [45_729, 45_741, 45_795, 45_796]

/** Hold `port` for the duration of `work`, as a stale invocation would. */
async function occupying<T>(ports: readonly number[], work: () => Promise<T>): Promise<T> {
  const held = ports.map((port) => Bun.serve({ port, fetch: () => new Response("someone else") }))
  try {
    return await work()
  } finally {
    for (const server of held) server.stop(true)
  }
}

describe("a server this repository starts", () => {
  test("refuses a port something else holds, rather than sharing it", () => {
    // Which is exactly why these ask the kernel instead. A fixed number that
    // a stale invocation still holds is not a slow gate or a degraded one —
    // it is a suite that cannot start at all, for a reason reported nowhere
    // near where anyone would look.
    const first = Bun.serve({ port: 0, fetch: () => new Response("first") })
    const held = first.port ?? 0
    try {
      expect(held).toBeGreaterThan(0)
      expect(() => Bun.serve({ port: held, fetch: () => new Response("second") })).toThrow()
    } finally {
      first.stop(true)
    }
  })
})

describe("the stub provider", () => {
  test("starts with every one of the old fixed ports held against it", async () => {
    // All four, not just its own: the point is that no number this gate used
    // to write down matters to it any more.
    await occupying(FORMERLY_FIXED, async () => {
      const stub = startStubProvider()
      try {
        expect(FORMERLY_FIXED).not.toContain(stub.port)
        expect(stub.baseURL).toContain(String(stub.port))

        const response = await fetch(`${stub.baseURL}/models`)
        expect(response.ok).toBe(true)
      } finally {
        stub.stop()
      }
    })
  })

  test("answers on the port it says it bound", async () => {
    // The port it reports is the one the URL passed to the host is built
    // from, so a provider that reported a different number would be a host
    // configured to talk to nothing.
    const stub = startStubProvider()
    try {
      const response = await fetch(`${stub.baseURL}/models`)
      const body = (await response.json()) as { data: Array<{ id: string }> }

      expect(body.data[0]?.id).toBe(STUB_MODEL_ID)
    } finally {
      stub.stop()
    }
  })

  test("asks the kernel for independent ports", async () => {
    // Two overlapping gate invocations, in the one respect this file can
    // reproduce in-process. This is kernel allocation, not a random-port
    // guarantee: the kernel makes simultaneous binds distinct.
    const stubs = [startStubProvider(), startStubProvider(), startStubProvider()]
    try {
      expect(new Set(stubs.map((stub) => stub.port)).size).toBe(stubs.length)
    } finally {
      for (const stub of stubs) stub.stop()
    }
  })
})

describe("what a host says it bound", () => {
  test("is read from its own line, not from what it was asked for", () => {
    expect(reportedPort("opencode server listening on http://127.0.0.1:52046")).toBe(52_046)
  })

  test("is the answer, since the request was `--port 0`", () => {
    // V2 honours `--port 0` (issue #140): the request names no port at all,
    // so the line the host prints is the only place the number exists.
    expect(reportedPort("server listening on http://127.0.0.1:63645")).toBe(63_645)
  })

  test("is absent rather than guessed when the line says nothing usable", () => {
    expect(reportedPort("opencode server listening on a socket")).toBeUndefined()
    expect(reportedPort("")).toBeUndefined()
    expect(reportedPort("opencode server listening on http://127.0.0.1:0")).toBeUndefined()
    expect(reportedPort("opencode server listening on http://127.0.0.1:70000")).toBeUndefined()
  })
})
