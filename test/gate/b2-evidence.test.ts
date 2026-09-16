/**
 * What a failed B2 run leaves behind (issue #98).
 *
 * B2 is the only suite that drives the real OpenCode host, and it was the only
 * one that kept nothing. Its workspace went unconditionally, and the artifacts
 * that would explain a failure were never in it: the host runs the tool for
 * real, so the Run Record, raw log, normalized index and Result Bundle land in
 * the user's own storage root under one opaque key per project. A failure left
 * one line of text — which is the whole reason #84 has been chased by
 * rerunning and watching rather than by reading.
 *
 * The two halves pull opposite ways, so both are asserted here: a failing run
 * keeps that storage, correlated to the scenario that failed; a passing one
 * removes it, because these are roots for projects that will never exist again
 * and nothing downstream can ever ask whether a root is still real.
 */

import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { mergeEvidence } from "../../scripts/acceptance-gate.ts"
import { B2Evidence, worthKeeping } from "../../scripts/gate/b2-evidence.ts"
import { evidenceDirectory, preserveEvidence, pruneEvidence } from "../../scripts/gate/forensics.ts"
import { keyFor, renderReport, type RunReport } from "../../scripts/gate/report.ts"
import { prepareStorage, storageFor } from "../../src/runner/paths.ts"
import { field } from "../../src/adapter/document.ts"

function withHome<T>(work: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "xcode-test-b2-evidence-"))
  try {
    return work(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * The key the tool would file this root under.
 *
 * Canonical, because the host resolves a trusted root before it stores
 * anything and `storageFor` hashes what it is given. The workspace here is
 * under the system temp directory, which on macOS is reached through a
 * symbolic link — so a helper
 * that hashed the path as written would agree with a collector that made the
 * same mistake, and the pair would pass while the real gate left both roots on
 * disk. It did: 312 roots before a run, 314 after.
 */
function keyed(home: string, root: string) {
  return storageFor(home, realpathSync(root))
}

/** A project root whose per-root storage exists, as a real B2 run leaves it. */
function drivenRoot(home: string, workspace: string, name: string, bytes = 64): string {
  const root = join(workspace, name)
  mkdirSync(root, { recursive: true })
  const storage = keyed(home, root)
  prepareStorage(storage)

  const run = join(storage.runsDir, `run-${name}`)
  mkdirSync(join(run, "result.xcresult"), { recursive: true })
  for (const artifact of ["metadata.json", "raw.log", "index.json", "summary.json"]) {
    writeFileSync(join(run, artifact), "x".repeat(bytes))
  }
  writeFileSync(join(run, "result.xcresult", "Info.plist"), "x".repeat(bytes))

  // The cache `xcodebuild` leaves beside them, which is what makes a root
  // large enough to matter and is never worth keeping.
  mkdirSync(join(storage.rootDir, "DerivedData", "Build"), { recursive: true })
  writeFileSync(join(storage.rootDir, "DerivedData", "Build", "huge.o"), "x".repeat(bytes * 500))
  return root
}

/** A rendered response, as the host hands one back. */
function response(runId: string): string {
  return ["Test Run infrastructureFailed: resultBundleUnreadable", "", field("run", runId), ""].join("\n")
}

function failed(name: string) {
  return { name, kind: "gating", status: "failed", detail: "it did not" } as never
}

function passed(name: string) {
  return { name, kind: "gating", status: "passed", detail: "it did" } as never
}

describe("a B2 scenario that failed", () => {
  test("keeps the storage the host wrote, and says which scenario it belongs to", () => {
    withHome((home) => {
      const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-ws-"))
      const evidence = new B2Evidence(home)
      const passing = drivenRoot(home, workspace, "passing")
      const broken = drivenRoot(home, workspace, "build-failed")
      evidence.root(passing)
      evidence.root(broken)

      evidence.observe("zero-match", passing, response("abc123"))
      evidence.watch(failed("b2 zero-match"))

      expect(evidence.failed).toBe(true)
      const sources = evidence.sources(workspace)
      expect(sources.map((source) => source.name).sort()).toEqual(
        [
          "b2-host-diagnostics",
          `b2-root-${keyed(home, broken).rootKey}`,
          `b2-root-${keyed(home, passing).rootKey}`,
        ].sort(),
      )

      // The correlation is the point. Two anonymous root keys and eleven
      // results is not one, and it is what a reader had before.
      expect(evidence.correlations()).toEqual([
        {
          scenario: "b2 zero-match",
          root: "passing",
          rootKey: keyed(home, passing).rootKey,
          runId: "abc123",
        },
      ])
      rmSync(workspace, { recursive: true, force: true })
    })
  })

  test("carries the artifacts a diagnosis needs, and not the cache beside them", () => {
    withHome((home) => {
      const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-ws-"))
      const evidence = new B2Evidence(home)
      const passing = drivenRoot(home, workspace, "passing")
      evidence.observe("zero-match", passing, response("abc123"))
      evidence.root(passing)
      evidence.watch(failed("b2 zero-match"))

      const kept = preserveEvidence(
        evidence.sources(workspace).map((source) => ({ ...source, keep: worthKeeping })),
        { startedAt: "2026-09-16T00:00:00.000Z", homeDir: home },
      )
      expect(kept.status).toBe("preserved")

      const set = join(evidenceDirectory(home), keyFor("2026-09-16T00:00:00.000Z"))
      const run = join(set, `b2-root-${keyed(home, passing).rootKey}`, "runs", "run-passing")
      for (const artifact of ["metadata.json", "raw.log", "index.json", "result.xcresult"]) {
        expect(existsSync(join(run, artifact))).toBe(true)
      }

      // `DerivedData` is regenerable and is most of a root's bytes. A set that
      // carried it would exceed the whole budget and be discarded, so keeping
      // it is the same as keeping nothing.
      expect(
        existsSync(join(set, `b2-root-${keyed(home, passing).rootKey}`, "DerivedData")),
      ).toBe(false)
      expect(kept.status === "preserved" ? kept.bytes : Infinity).toBeLessThan(10_000)

      // The responses are where a staging failure says what it was, and that
      // sentence exists nowhere else once the host process is gone.
      const transcript = join(set, "b2-host-diagnostics", "responses.json")
      expect(existsSync(transcript)).toBe(true)
      rmSync(workspace, { recursive: true, force: true })
    })
  })
})

describe("a host exception, rather than a scenario that answered wrongly", () => {
  test("is still a run worth keeping evidence for", () => {
    withHome((home) => {
      const evidence = new B2Evidence(home)
      // Nothing was invoked: the route itself could not be driven.
      evidence.watch(failed("b2 execution"))

      expect(evidence.failed).toBe(true)
      expect(evidence.correlations()).toEqual([
        { scenario: "b2 execution", root: "unknown", rootKey: "unknown" },
      ])
    })
  })

  test("names the last run it did reach, when it reached one", () => {
    withHome((home) => {
      const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-ws-"))
      const evidence = new B2Evidence(home)
      const passing = drivenRoot(home, workspace, "passing")
      evidence.root(passing)
      evidence.observe("failing run", passing, response("def456"))
      evidence.watch(failed("b2 execution"))

      expect(evidence.correlations()[0]?.runId).toBe("def456")
      rmSync(workspace, { recursive: true, force: true })
    })
  })
})

describe("cleanup", () => {
  test("removes the per-root storage a passing run accumulated", () => {
    withHome((home) => {
      const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-ws-"))
      const evidence = new B2Evidence(home)
      const passing = drivenRoot(home, workspace, "passing")
      const broken = drivenRoot(home, workspace, "build-failed")
      evidence.root(passing)
      evidence.root(broken)
      evidence.watch(passed("b2 passing"))

      expect(evidence.failed).toBe(false)
      expect(existsSync(keyed(home, passing).rootDir)).toBe(true)

      // The defect this exists to end: one directory per gate run, for ever.
      // The registry stores a hash and a timestamp by design and never a path,
      // so nothing downstream can ever ask whether a root is still real.
      expect(evidence.clean().sort()).toEqual(
        [keyed(home, passing).rootKey, keyed(home, broken).rootKey].sort(),
      )
      expect(existsSync(keyed(home, passing).rootDir)).toBe(false)
      expect(existsSync(keyed(home, broken).rootDir)).toBe(false)
      rmSync(workspace, { recursive: true, force: true })
    })
  })

  test("cannot remove evidence before the report that references it is written", () => {
    withHome((home) => {
      const startedAt = "2026-09-16T00:00:00.000Z"
      const source = mkdtempSync(join(tmpdir(), "xcode-test-b2-src-"))
      writeFileSync(join(source, "metadata.json"), "x".repeat(64))

      // Layer 4 keeps first; B2 keeps second, in the same run and under the
      // same key. A policy that pruned by count alone would let the second
      // preservation delete the first, and the report naming the key is not
      // written until both have happened.
      preserveEvidence([{ name: "layer4", path: source }], { startedAt, homeDir: home })
      preserveEvidence([{ name: "b2-root-abc", path: source }], {
        startedAt,
        homeDir: home,
        policy: { maxSets: 1, maxAgeMs: 0, maxBytes: 1_000_000 },
      })

      const set = join(evidenceDirectory(home), keyFor(startedAt))
      expect(readdirSync(set).sort()).toEqual(["b2-root-abc", "layer4"])
      rmSync(source, { recursive: true, force: true })
    })
  })

  test("still prunes that set once it is no longer the run being written", () => {
    withHome((home) => {
      const startedAt = "2026-09-16T00:00:00.000Z"
      const source = mkdtempSync(join(tmpdir(), "xcode-test-b2-src-"))
      writeFileSync(join(source, "metadata.json"), "x".repeat(64))
      preserveEvidence([{ name: "b2-root-abc", path: source }], { startedAt, homeDir: home })

      // Protection is scoped to the run doing the writing, not granted for
      // ever. A later run prunes this by exactly the policy that always applied.
      expect(pruneEvidence({ homeDir: home, policy: { maxSets: 0, maxAgeMs: 0, maxBytes: 0 } })).toEqual([
        keyFor(startedAt),
      ])
      expect(existsSync(join(evidenceDirectory(home), keyFor(startedAt)))).toBe(false)
      rmSync(source, { recursive: true, force: true })
    })
  })
})

describe("the durable report's correlation", () => {
  const report = (b2Evidence: RunReport["b2Evidence"]): RunReport =>
    ({
      schemaVersion: 1,
      startedAt: "2026-09-16T00:00:00.000Z",
      finishedAt: "2026-09-16T00:01:00.000Z",
      selected: ["b2"],
      toolchain: {
        xcodeVersion: "26.4.1",
        xcodeBuild: "17E202",
        xcresulttoolVersion: "24757",
        schemaVersion: "0.1.0",
        developerDirectory: "/x",
      },
      hostVersion: "1.18.29",
      runtime: { path: "/opt/bun", version: "1.4.0", source: "path" },
      destination: { deviceName: "iPhone 17 Pro", runtime: "iOS-26-4", id: "D1" },
      freshness: {},
      scenarios: [],
      outcome: "failed",
      evidence: { key: keyFor("2026-09-16T00:00:00.000Z"), bytes: 4_096 },
      b2Evidence,
    }) as RunReport

  test("reaches the reader, rather than only the JSON", () => {
    const text = renderReport(
      report([{ scenario: "b2 zero-match" as never, root: "passing", rootKey: "a".repeat(64), runId: "abc123" }]),
      "/somewhere/report.json",
    )

    expect(text).toContain("b2 zero-match")
    expect(text).toContain("a".repeat(64))
    expect(text).toContain("abc123")
  })

  test("names nothing but opaque identifiers", () => {
    // A durable report is read by people who did not run the gate, and a B2
    // root is a directory under someone's home named after a temp project.
    const text = renderReport(
      report([{ scenario: "b2 zero-match" as never, root: "passing", rootKey: "a".repeat(64), runId: "abc123" }]),
      "/somewhere/report.json",
    )

    expect(text).not.toContain("/Users")
    expect(text).not.toContain("/var/folders")
    expect(text).not.toContain("/private")
  })

  test("says nothing at all when no B2 scenario failed", () => {
    expect(renderReport(report([]), "/somewhere/report.json")).not.toContain("b2 evidence")
    expect(renderReport(report(undefined), "/somewhere/report.json")).not.toContain("b2 evidence")
  })
})

describe("what is worth keeping out of a driven root", () => {
  test("excludes the build cache and nothing else", () => {
    expect(worthKeeping(join("roots", "abc", "runs", "r1", "metadata.json"))).toBe(true)
    expect(worthKeeping(join("roots", "abc", "runs", "r1", "result.xcresult"))).toBe(true)
    expect(worthKeeping(join("roots", "abc", "DerivedData"))).toBe(false)
    expect(worthKeeping(join("roots", "abc", "DerivedData", "Build", "x.o"))).toBe(false)
    // Not a substring match: a run that happened to be named after it stays.
    expect(worthKeeping(join("roots", "abc", "runs", "DerivedDataNotes.json"))).toBe(true)
  })
})

describe("two suites keeping evidence in one run", () => {
  test("describes the set as the one set it is, not as whichever half went last", () => {
    const layer4 = { key: "k", bytes: 400 }
    expect(mergeEvidence(layer4, { key: "k", bytes: 600 })).toEqual({ key: "k", bytes: 1_000 })
  })

  test("never lets a half that could not be kept erase one that was", () => {
    // The tempting shape, and the wrong one. The report would say nothing was
    // kept while the correlation still pointed at a key holding Layer 4's
    // evidence — sending a reader away from a directory sitting right there.
    const merged = mergeEvidence({ key: "k", bytes: 400 }, { unavailable: "too large" })

    expect(merged).toEqual({ key: "k", bytes: 400, partial: "too large" })
    expect(mergeEvidence({ unavailable: "too large" }, { key: "k", bytes: 400 })).toEqual({
      key: "k",
      bytes: 400,
      partial: "too large",
    })
  })

  test("says so plainly when neither half could be kept", () => {
    expect(mergeEvidence({ unavailable: "no store" }, { unavailable: "too large" })).toEqual({
      unavailable: "no store; too large",
    })
  })

  test("weighs the budget against the set, not against the half in front of it", () => {
    withHome((home) => {
      const startedAt = "2026-09-16T00:00:00.000Z"
      const source = mkdtempSync(join(tmpdir(), "xcode-test-b2-src-"))
      writeFileSync(join(source, "metadata.json"), "x".repeat(600))

      const policy = { maxSets: 3, maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1_000 }
      expect(
        preserveEvidence([{ name: "layer4", path: source }], { startedAt, homeDir: home, policy })
          .status,
      ).toBe("preserved")

      // The second half fits on its own and does not fit beside the first. A
      // check that only ever weighed what was in front of it would carry the
      // store past a bound the first half had already half spent.
      expect(
        preserveEvidence([{ name: "b2-root-abc", path: source }], {
          startedAt,
          homeDir: home,
          policy,
        }).status,
      ).toBe("discarded")
      rmSync(source, { recursive: true, force: true })
    })
  })
})

describe("what the host itself said", () => {
  test("is kept, because none of it reaches a scenario result", () => {
    withHome((home) => {
      const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-ws-"))
      const evidence = new B2Evidence(home)
      // The host runs in this process, so a plugin that failed to load says so
      // on the error stream and nowhere a scenario can see it.
      evidence.hostOutput("plugin xcode-test failed to load: ENOENT\n")
      evidence.watch(failed("b2 execution"))

      const diagnostics = evidence.sources(workspace).find((s) => s.name === "b2-host-diagnostics")
      expect(diagnostics).toBeDefined()
      expect(existsSync(join(diagnostics!.path, "host.log"))).toBe(true)
      rmSync(workspace, { recursive: true, force: true })
    })
  })

  test("leaves no empty file behind when the host said nothing", () => {
    withHome((home) => {
      const workspace = mkdtempSync(join(tmpdir(), "xcode-test-b2-ws-"))
      const evidence = new B2Evidence(home)
      evidence.watch(failed("b2 execution"))

      const diagnostics = evidence.sources(workspace).find((s) => s.name === "b2-host-diagnostics")
      expect(existsSync(join(diagnostics!.path, "host.log"))).toBe(false)
      rmSync(workspace, { recursive: true, force: true })
    })
  })
})
