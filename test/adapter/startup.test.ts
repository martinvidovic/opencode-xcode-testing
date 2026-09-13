/**
 * The plugin-startup sequence (ADR 0002).
 *
 * The factory is awaited before every other host service, so the properties
 * here are about what startup *refuses* to do: it never blocks indefinitely, it
 * never pays for work an unmarked project has no stake in, and it never
 * registers tools it can already prove cannot work.
 */

import { describe, expect, test } from "bun:test"

import {
  hostVersionDiagnostic,
  isTestedHostVersion,
  runStartup,
  STARTUP_DEADLINE_MS,
  TESTED_HOST_VERSIONS,
  type StartupPorts,
} from "../../src/adapter/startup.ts"

type Trace = string[]

function ports(overrides: Partial<StartupPorts> = {}, trace: Trace = []): StartupPorts {
  let clock = 0
  return {
    markerExists: () => {
      trace.push("marker")
      return true
    },
    requiredFiles: () => ["entrypoint.ts", "descriptions/a.txt"],
    fileExists: () => {
      trace.push("structural")
      return true
    },
    probeRuntime: async () => {
      trace.push("probe")
      return { status: "resolved" }
    },
    readHostVersion: async () => {
      trace.push("version")
      return "1.18.30"
    },
    reconcileRoot: async () => {
      trace.push("reconcile")
    },
    runHousekeeping: async () => {
      trace.push("housekeeping")
    },
    now: () => (clock += 1),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  }
}

describe("the unmarked-root fast path", () => {
  test("registers nothing when the enablement marker is absent", async () => {
    const outcome = await runStartup(ports({ markerExists: () => false }))
    expect(outcome).toEqual({ status: "disabled" })
  })

  test("skips the probe, the version read and reconciliation entirely", async () => {
    // Not merely registration: an unconfigured project pays nothing at all.
    const trace: Trace = []
    await runStartup(ports({ markerExists: () => false }, trace))
    expect(trace).toEqual([])
  })
})

describe("structural verification", () => {
  test("runs after the marker and before anything bounded", async () => {
    const trace: Trace = []
    await runStartup(ports({}, trace))
    expect(trace.slice(0, 2)).toEqual(["marker", "structural"])
  })

  test("registers nothing when a shipped file is missing", async () => {
    const outcome = await runStartup(
      ports({ fileExists: (path) => path !== "descriptions/a.txt" }),
    )
    expect(outcome.status).toBe("structuralFailure")
    if (outcome.status !== "structuralFailure") return
    expect(outcome.missing).toEqual(["descriptions/a.txt"])
  })

  test("names the expected layout, because a partial copy is its own failure class", async () => {
    const outcome = await runStartup(ports({ fileExists: () => false }))
    if (outcome.status !== "structuralFailure") throw new Error("expected a structural failure")
    expect(outcome.diagnostic).toContain("checkout is incomplete")
    expect(outcome.diagnostic).toContain("supervisor entrypoint")
  })

  test("skips every bounded item once it has failed", async () => {
    const trace: Trace = []
    await runStartup(ports({ fileExists: () => false }, trace))
    expect(trace).not.toContain("probe")
    expect(trace).not.toContain("housekeeping")
  })
})

describe("a marked root", () => {
  test("runs every bounded item and reports ready", async () => {
    const trace: Trace = []
    const outcome = await runStartup(ports({}, trace))

    expect(outcome.status).toBe("ready")
    for (const item of ["probe", "version", "reconcile", "housekeeping"]) {
      expect(trace).toContain(item)
    }
  })

  test("records the host version it observed", async () => {
    const outcome = await runStartup(ports({ readHostVersion: async () => "1.18.29" }))
    expect(outcome).toMatchObject({ status: "ready", hostVersion: "1.18.29", hostVersionTested: true })
  })

  test("degrades an unreachable version read to `unknown` without blocking", async () => {
    const outcome = await runStartup(
      ports({
        readHostVersion: () => Promise.reject(new Error("unreachable")),
      }),
    )
    expect(outcome).toMatchObject({ status: "ready", hostVersion: "unknown" })
    if (outcome.status !== "ready") return
    expect(outcome.incomplete).toContain("hostVersion")
  })

  test("returns with whatever finished when an item exceeds its own budget", async () => {
    const outcome = await runStartup(
      ports({
        // Never settles: the bounded wrapper must give up on it.
        reconcileRoot: () => new Promise(() => {}),
        deadlineMs: 200,
      }),
    )
    expect(outcome.status).toBe("ready")
    if (outcome.status !== "ready") return
    expect(outcome.incomplete).toContain("reconciliation")
    expect(outcome.hostVersion).toBe("1.18.30")
  }, 10_000)

  test("still reports ready when everything bounded fails, since all of it is retried", async () => {
    const outcome = await runStartup(
      ports({
        probeRuntime: () => Promise.reject(new Error("no runtime")),
        reconcileRoot: () => Promise.reject(new Error("locked")),
        runHousekeeping: () => Promise.reject(new Error("locked")),
        readHostVersion: () => Promise.reject(new Error("unreachable")),
      }),
    )
    expect(outcome.status).toBe("ready")
    if (outcome.status !== "ready") return
    expect(outcome.incomplete).toEqual([
      "hostVersion",
      "housekeeping",
      "reconciliation",
      "runtimeProbe",
    ])
  })
})

describe("the host-version policy", () => {
  test("enumerates the tested set explicitly", () => {
    expect([...TESTED_HOST_VERSIONS]).toEqual(["1.18.29", "1.18.30"])
    expect(isTestedHostVersion("1.18.29")).toBe(true)
    expect(isTestedHostVersion("1.18.31")).toBe(false)
  })

  test("warns on skew and never refuses to load", () => {
    const diagnostic = hostVersionDiagnostic("1.19.0")
    expect(diagnostic).toContain("1.19.0")
    expect(diagnostic).toContain("Loading normally")
  })

  test("says nothing for a tested version or an unknown one", () => {
    expect(hostVersionDiagnostic("1.18.30")).toBeUndefined()
    // An unreachable health endpoint is not evidence of skew.
    expect(hostVersionDiagnostic("unknown")).toBeUndefined()
  })
})

describe("the startup ceiling", () => {
  test("is a ten-second defect guard, not an expected cost", () => {
    expect(STARTUP_DEADLINE_MS).toBe(10_000)
  })
})
