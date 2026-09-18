/**
 * The (b1) suite as the gate actually runs it (issue #70).
 *
 * b1 is two gates back to back — registration, then installation — and they
 * are independent: a host that will not start says nothing about whether a
 * documented symlink registers the tool family. That independence is the whole
 * subject here, because it is what a coarser rule got wrong. Treating a
 * bootstrap failure as something that stops "the suite" meant the installation
 * check running afterwards made the failure look non-terminal, and five
 * registration checks that were never runnable were reported as registry
 * drift — on every machine without a host SDK.
 *
 * Driven through `runB1Suite` rather than a reconstruction of it. A test that
 * records the scenarios it expects, in the order it expects, proves only that
 * the test knows what it wrote down; the ordering is a property of the
 * production code, and this is the only way to observe it.
 *
 * **It costs about half a minute**, nearly all of it the installation gate
 * waiting for a host that cannot boot. That is the price of exercising the
 * real path instead of a fast imitation of it, and the imitation is precisely
 * what the coarse rule was hiding behind.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bootHost } from "../../scripts/gate/host.ts"

const REPO = join(import.meta.dir, "..", "..")

/** Marks where the payload starts, past whatever the gates printed. */
const SENTINEL = "---b1-orchestration---"

/**
 * What `runB1Suite` reported, run against the home it is given.
 *
 * In a subprocess because the SDK is looked for under the user's home, and
 * `os.homedir()` is fixed for the life of a process — so the only way to run
 * the real lookup against a home whose SDK is absent, or broken, is to start
 * somewhere that has one.
 */
type Observed = { scenarios: Array<[string, string]>; disagreements: string[] }

function b1Under(home: string): Observed {
  return runB1(home, REPO)
}

/**
 * Run `runB1Suite` in a subprocess under `home`, from `cwd`, after `prelude`.
 *
 * The prelude is how a test arranges something the suite cannot arrange for
 * itself — removing the working directory out from under it, for instance,
 * which no API exposes and which is exactly the shape of an unanticipated
 * throw.
 */
function runB1(home: string, cwd: string, prelude = ""): Observed {
  const script = `
    import { rmSync } from "node:fs"
    ${prelude}

    import { runB1Suite } from ${JSON.stringify(join(REPO, "scripts", "gate", "b1.ts"))}
    import {
      asSuite,
      newObservations,
      registryDisagreements,
      scenarioSink,
    } from ${JSON.stringify(join(REPO, "scripts", "gate", "observations.ts"))}

    const observed = newObservations("2026-09-14T01:00:00.000Z")
    observed.selected = ["b1"]
    await asSuite(observed, "b1", () => runB1Suite(scenarioSink(observed)))

    process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify({
      scenarios: observed.scenarios.map((s) => [s.name, s.status]),
      disagreements: registryDisagreements(observed),
    }))
  `

  const result = spawnSync("bun", ["-e", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  })

  // Said plainly rather than left to a JSON parse error. A missing `bun`, or a
  // subprocess that died, otherwise surfaces as "Unexpected end of JSON input"
  // after two minutes — a message about this function rather than about what
  // went wrong.
  if (result.status !== 0) {
    throw new Error(`the b1 subprocess exited ${result.status}: ${result.stderr ?? ""}`)
  }

  // A sentinel, because the gates print their own diagnostics and anything
  // brace-shaped among them would otherwise be read as the payload.
  const [, payload] = (result.stdout ?? "").split(SENTINEL)
  if (payload === undefined) {
    throw new Error(`the b1 subprocess produced no result: ${result.stdout ?? ""}`)
  }

  return JSON.parse(payload) as Observed
}

/**
 * The same, from a working directory that is removed before the suite runs.
 *
 * Its own directory rather than the repository's, because the subprocess
 * deletes it — and `import.meta.dir` paths are absolute, so the imports still
 * resolve from a directory that no longer exists.
 */
function b1WithADeletedWorkingDirectory(home: string): Observed {
  const doomed = mkdtempSync(join(tmpdir(), "xcode-test-doomed-cwd-"))
  return runB1(home, doomed, `rmSync(${JSON.stringify(doomed)}, { recursive: true, force: true })`)
}

describe("a b1 run that cannot find a host SDK", () => {
  test("runs the installation check anyway, and calls none of it registry drift", async () => {
    // One run, two facts about it. Split across two tests they would cost two
    // host-boot timeouts to learn the same thing twice.
    const home = mkdtempSync(join(tmpdir(), "xcode-test-empty-home-"))
    try {
      const observed = b1Under(home)

      // The ordering that matters, taken from the production path rather than
      // asserted into existence: the bootstrap failure, and then an
      // independent check that runs regardless of it.
      expect(observed.scenarios.map(([name]) => name)).toEqual([
        "b1 host registration",
        "b1 documented installation path",
      ])
      expect(observed.scenarios[0]?.[1]).toBe("failed")

      // The defect this closes. The five registration checks were never
      // runnable, `unreached` says so, and saying it again here would turn an
      // honest bootstrap failure into a page of drift warnings — on every
      // machine without a host SDK, which is most of them.
      expect(observed.disagreements).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})

describe("a b1 run whose registration gate ends unexpectedly", () => {
  test("still runs the installation check, which has nothing to do with it", async () => {
    // Not a failure the registration gate reports — one it does not survive.
    // `runRegistrationGate` reads `process.cwd()` before its own handler is in
    // scope, so a working directory that has been removed underneath it raises
    // past everything it knows how to say. That is the shape of any
    // unanticipated throw, and what matters is what happens to its *peer*:
    // the installation gate checks a symlink described in the README and has
    // no stake in any of this.
    //
    // A well-formed stub SDK is planted so the gate gets that far. With no
    // SDK it would report a bootstrap failure and return, which is the case
    // above and proves nothing about a throw.
    const home = mkdtempSync(join(tmpdir(), "xcode-test-throwing-home-"))
    try {
      const dist = join(home, ".config", "opencode", "node_modules", "@opencode-ai", "sdk", "dist")
      mkdirSync(dist, { recursive: true })
      writeFileSync(join(dist, "index.js"), "export function createOpencode() { return {} }\n")

      const observed = b1WithADeletedWorkingDirectory(home)

      expect(observed.scenarios.map(([name]) => name)).toEqual([
        "b1 host registration",
        "b1 documented installation path",
      ])
      expect(observed.scenarios[0]?.[1]).toBe("failed")
      expect(observed.disagreements).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})

describe("a B1 host startup", () => {
  test("fails while the old fixed endpoint reaches the leftover listener", async () => {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
    const configDirectory = mkdtempSync(join(tmpdir(), "xcode-test-occupied-port-"))
    const port = reservation.port

    try {
      if (port === undefined) throw new Error("expected the reserved port")
      reservation.stop(true)

      const first = await bootHost({ configDirectory, cwd: REPO, port })
      await first.stop()

      const held = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response("leftover listener"),
      })
      try {
        await expect(bootHost({ configDirectory, cwd: REPO, port })).rejects.toThrow()
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("leftover listener")
      } finally {
        held.stop(true)
      }
    } finally {
      rmSync(configDirectory, { recursive: true, force: true })
    }
  }, 30_000)
})
