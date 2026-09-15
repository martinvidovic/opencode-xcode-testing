/**
 * What b1 does when the host SDK will not load (issue #80).
 *
 * The SDK is host-managed test infrastructure, so the gate imports it from the
 * host's own installation at run time. A dynamic import runs another package's
 * top-level code, which may throw for any reason it likes — and that throw
 * used to leave `runRegistrationGate` entirely, then `runB1Suite`, taking the
 * installation gate with it.
 *
 * The installation gate has nothing to do with the SDK. It checks that the
 * symlink the README describes registers the tool family, on a machine that
 * may have no SDK at all. Cancelling it because a package under someone's home
 * directory is broken is the same mistake #70 closed from the other side: a
 * bootstrap failure reported as though it said something about its peer.
 *
 * Driven in subprocesses with a planted home, because `homedir()` is fixed for
 * the life of a process and the lookup is the thing under test. Each returns
 * before anything boots, so all three cost milliseconds.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")
const SENTINEL = "---sdk-load---"

type Scenario = { name: string; status: string; detail: string }

/**
 * Run the registration gate against a home whose SDK is whatever `body` says.
 *
 * `undefined` plants no SDK at all. Anything else is written where the gate
 * looks, so the import really happens and really fails.
 */
function registrationWith(body: string | undefined): Scenario[] {
  const home = mkdtempSync(join(tmpdir(), "xcode-test-sdk-"))

  try {
    if (body !== undefined) {
      const dist = join(home, ".config", "opencode", "node_modules", "@opencode-ai", "sdk", "dist")
      mkdirSync(dist, { recursive: true })
      writeFileSync(join(dist, "index.js"), body)
    }

    const script = `
      import { runRegistrationGate } from ${JSON.stringify(join(REPO, "scripts", "gate", "registration.ts"))}

      const scenarios = []
      await runRegistrationGate((result) => scenarios.push(result))
      process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(scenarios))
    `

    const result = spawnSync("bun", ["-e", script], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })

    // Said plainly. A gate that took its own process down is precisely the
    // defect here, and it should not arrive as a JSON parse error.
    if (result.status !== 0) {
      throw new Error(`the registration gate exited ${result.status}: ${result.stderr ?? ""}`)
    }

    const [, payload] = (result.stdout ?? "").split(SENTINEL)
    if (payload === undefined) {
      throw new Error(`the registration gate produced no result: ${result.stdout ?? ""}`)
    }
    return JSON.parse(payload) as Scenario[]
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe("a host SDK that is not installed", () => {
  test("fails registration, and says where the gate looked", () => {
    const [scenario] = registrationWith(undefined)

    expect(scenario?.name).toBe("b1 host registration")
    expect(scenario?.status).toBe("failed")
    expect(scenario?.detail).toContain("was not found")
  })
})

describe("a host SDK that throws while being imported", () => {
  test("fails registration rather than taking the gate down", () => {
    // The defect. A package under someone's home directory, broken in a way
    // this repository cannot see or fix, used to end the whole suite.
    const [scenario] = registrationWith("throw new Error('the sdk is broken')\n")

    expect(scenario?.status).toBe("failed")
    expect(scenario?.detail).toContain("could not be imported")
  })

  test("says what kind of failure it was, and never where the module lives", () => {
    // An import error quotes the module's own path, and that path is under
    // the user's home by construction.
    const [scenario] = registrationWith(
      "throw new Error('cannot open /Users/someone/Library/Application Support/thing')\n",
    )

    expect(scenario?.detail).toContain("Error")
    expect(scenario?.detail).not.toContain("/Users")
    expect(scenario?.detail).not.toContain("Support")
  })
})

describe("a host SDK of the wrong shape", () => {
  test("fails registration rather than failing later as a host that would not start", () => {
    // A module that loaded is not a module that fits. Called through a cast,
    // this failed inside the host boot and was reported as a host that would
    // not start — which is a different machine to go and look at.
    const [scenario] = registrationWith("export const somethingElse = 1\n")

    expect(scenario?.status).toBe("failed")
    // The exact wording, because the imprecise one passes either way: called
    // through a cast, this fails inside the host boot as "sdk.createOpencode
    // is not a function" — a failure that also mentions `createOpencode`, and
    // that sends a reader to look at the host.
    expect(scenario?.detail).toContain("does not export `createOpencode`")
  })
})
