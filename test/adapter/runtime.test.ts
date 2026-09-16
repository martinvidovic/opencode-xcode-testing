/**
 * Runtime resolution (ADR 0002).
 *
 * The candidate most likely to be wrong is the one that looks most obviously
 * right: the shipped `opencode` is a Bun-compiled single-file executable, so it
 * reports a perfectly good Bun version and cannot execute a `.ts` file. Every
 * candidate is therefore probed by running one, and nothing here falls back
 * silently.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import {
  cacheIsValid,
  resolveRuntime,
  type RuntimeCacheEntry,
  type RuntimeProbe,
} from "../../src/adapter/runtime.ts"

const TRUSTED_ROOT = "/workspace/example"

/** A probe that accepts exactly the candidates it is told to accept. */
function probeAccepting(...usable: string[]): RuntimeProbe {
  return async (candidate) =>
    usable.includes(candidate) ? { usable: true, version: "1.4.0" } : { usable: false }
}

describe("an explicitly configured runtime", () => {
  test("wins over everything else", async () => {
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      configured: "/opt/bun/bin/bun",
      hostExecutable: "/opt/opencode",
      pathCandidate: "bun",
      probe: probeAccepting("/opt/bun/bin/bun", "/opt/opencode", "bun"),
    })
    expect(outcome).toMatchObject({ status: "resolved", path: "/opt/bun/bin/bun", source: "configuration" })
  })

  test("resolves a relative value against the trusted root", async () => {
    const expected = join(TRUSTED_ROOT, "tools/bun")
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      configured: "tools/bun",
      hostExecutable: "/opt/opencode",
      probe: probeAccepting(expected),
    })
    expect(outcome).toMatchObject({ status: "resolved", path: expected })
  })

  test("is a hard error when it is set but unusable, never a fallback", async () => {
    // A setting that silently degrades fails somewhere else, later.
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      configured: "/opt/broken/bun",
      hostExecutable: "/opt/opencode",
      pathCandidate: "bun",
      probe: probeAccepting("bun"),
    })

    expect(outcome.status).toBe("failed")
    if (outcome.status !== "failed") return
    expect(outcome.reason).toBe("runnerFailure")
    expect(outcome.message).toContain("configured runtime")
    expect(outcome.probed).toEqual(["/opt/broken/bun"])
  })
})

describe("the host executable", () => {
  test("is used when it genuinely runs TypeScript", async () => {
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      hostExecutable: "/opt/bun",
      pathCandidate: "bun",
      probe: probeAccepting("/opt/bun"),
    })
    expect(outcome).toMatchObject({ status: "resolved", source: "host" })
  })

  test("falls through to PATH when it cannot, which is the expected case", async () => {
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      hostExecutable: "/opt/homebrew/bin/opencode",
      pathCandidate: "bun",
      probe: probeAccepting("bun"),
    })
    expect(outcome).toMatchObject({ status: "resolved", path: "bun", source: "path" })
  })

  test("is probed before PATH, so a working host executable is preferred", async () => {
    const probed: string[] = []
    await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      hostExecutable: "/opt/opencode",
      pathCandidate: "bun",
      probe: async (candidate) => {
        probed.push(candidate)
        return { usable: false }
      },
    })
    expect(probed).toEqual(["/opt/opencode", "bun"])
  })
})

describe("when nothing works", () => {
  test("fails closed rather than falling back silently", async () => {
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      hostExecutable: "/opt/opencode",
      pathCandidate: "bun",
      probe: probeAccepting(),
    })
    expect(outcome).toMatchObject({ status: "failed", reason: "runnerFailure" })
  })

  test("names Bun, the candidates it tried, and the setting that would fix it", async () => {
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      hostExecutable: "/opt/opencode",
      probe: probeAccepting(),
    })
    if (outcome.status !== "failed") throw new Error("expected a failure")

    expect(outcome.message).toContain("Bun")
    expect(outcome.message).toContain("runtime")
    expect(outcome.message).toContain("compiled binary")
    expect(outcome.probed).toEqual(["/opt/opencode"])
  })

  test("copes with Bun being absent from PATH entirely", async () => {
    const outcome = await resolveRuntime({
      trustedRoot: TRUSTED_ROOT,
      hostExecutable: "/opt/opencode",
      probe: probeAccepting(),
    })
    expect(outcome.status).toBe("failed")
  })
})

describe("the probe cache", () => {
  // A full entry, because that is what the cache holds: `source` is recorded
  // rather than re-derived from the path, so an entry without one is a shape
  // the cache never produces.
  const entry: RuntimeCacheEntry = { path: "/opt/bun", mtimeMs: 1_000, size: 42, source: "host" }

  test("is valid only when path, mtime and size all still agree", () => {
    expect(cacheIsValid(entry, { ...entry })).toBe(true)
    expect(cacheIsValid(entry, { ...entry, mtimeMs: 1_001 })).toBe(false)
    expect(cacheIsValid(entry, { ...entry, size: 43 })).toBe(false)
    expect(cacheIsValid(entry, { ...entry, path: "/opt/other" })).toBe(false)
  })

  test("is invalid when there is nothing to compare", () => {
    expect(cacheIsValid(undefined, { ...entry })).toBe(false)
    expect(cacheIsValid(entry, undefined)).toBe(false)
  })
})
