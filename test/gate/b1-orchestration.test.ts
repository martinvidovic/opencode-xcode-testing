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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")

/**
 * What `runB1Suite` reported, with no host SDK to be found.
 *
 * In a subprocess because the SDK is looked for under the user's home, and
 * `os.homedir()` is fixed for the life of a process — so the only way to run
 * the real lookup against a home that has no SDK in it is to start somewhere
 * that has one.
 */
function b1WithoutAnSdk(home: string): {
  scenarios: Array<[string, string]>
  disagreements: string[]
} {
  const script = `
    import { runB1Suite } from ${JSON.stringify(join(REPO, "scripts", "gate", "registration.ts"))}
    import {
      asSuite,
      newObservations,
      registryDisagreements,
      scenarioSink,
    } from ${JSON.stringify(join(REPO, "scripts", "gate", "observations.ts"))}

    const observed = newObservations("2026-09-14T01:00:00.000Z")
    observed.selected = ["b1"]
    await asSuite(observed, "b1", () => runB1Suite(scenarioSink(observed)))

    process.stdout.write(JSON.stringify({
      scenarios: observed.scenarios.map((s) => [s.name, s.status]),
      disagreements: registryDisagreements(observed),
    }))
  `

  const result = spawnSync("bun", ["-e", script], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  })

  const payload = (result.stdout ?? "").slice((result.stdout ?? "").indexOf("{"))
  return JSON.parse(payload) as { scenarios: Array<[string, string]>; disagreements: string[] }
}

describe("a b1 run that cannot find a host SDK", () => {
  test("runs the installation check anyway, and calls none of it registry drift", async () => {
    // One run, two facts about it. Split across two tests they would cost two
    // host-boot timeouts to learn the same thing twice.
    const home = mkdtempSync(join(tmpdir(), "xcode-test-empty-home-"))
    try {
      const observed = b1WithoutAnSdk(home)

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
