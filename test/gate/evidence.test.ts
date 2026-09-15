/**
 * What a failed Layer 4 run leaves behind (issue #73).
 *
 * Layer 4 built its whole world in a temp workspace and deleted it on the way
 * out, unconditionally — so a failure destroyed the only copy of the thing
 * anyone would want. The Run Record saying what the supervisor decided, the
 * raw log, the normalized index, the Result Bundle the interpreter read: all
 * of it gone, leaving one line of text saying a scenario did not pass. That is
 * enough to know something is wrong and never enough to know what.
 *
 * Two properties, and the second is not optional. Evidence has to be kept when
 * a run fails, and the store has to be bounded whatever happens — an
 * unbounded diagnostic aid is a disk that fills up quietly, which is a worse
 * failure than the one it was meant to explain.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  EVIDENCE_POLICY,
  evidenceDirectory,
  evidenceKeyFor,
  preserveEvidence,
  pruneEvidence,
} from "../../scripts/gate/forensics.ts"
import { countsAsFailure, runLayer4 } from "../../scripts/gate/layer4.ts"
import { reportPathFor } from "../../scripts/gate/report.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"

/** A temp home, and a source tree standing in for a run's storage. */
function withHome<T>(work: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "xcode-test-evidence-"))
  try {
    return work(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function sourceTree(bytes: number): string {
  const source = mkdtempSync(join(tmpdir(), "xcode-test-source-"))
  mkdirSync(join(source, "runs", "abc"), { recursive: true })
  writeFileSync(join(source, "runs", "abc", "metadata.json"), "x".repeat(bytes))
  return source
}

/** Plant a set of a given size and age, as a previous run would have left it. */
function plantSet(home: string, key: string, bytes: number, ageMs: number): void {
  const path = join(evidenceDirectory(home), key)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  writeFileSync(join(path, "metadata.json"), "x".repeat(bytes))
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
}

function setsIn(home: string): string[] {
  try {
    return readdirSync(evidenceDirectory(home)).sort()
  } catch {
    return []
  }
}

describe("a failed run's evidence", () => {
  test("is filed under the same key as the report that describes it", () => {
    withHome((home) => {
      const startedAt = "2026-09-15T19:35:54.775Z"
      const source = sourceTree(16)

      try {
        const kept = preserveEvidence(source, { startedAt, homeDir: home })

        expect(kept.status).toBe("preserved")

        // Not merely "some agreed string". The report's own filename is built
        // from the same instant by the same rule, so a reader holding the
        // report knows where the evidence is without the report saying — and
        // a correlation that is nobody's job to maintain cannot drift.
        expect(reportPathFor(startedAt, home)).toContain(evidenceKeyFor(startedAt))
        expect(setsIn(home)).toEqual([evidenceKeyFor(startedAt)])
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })

  test("is owner-only, like everything else this tool keeps", () => {
    withHome((home) => {
      const source = sourceTree(16)
      try {
        preserveEvidence(source, { startedAt: "2026-09-15T00:00:00.000Z", homeDir: home })

        // A run's evidence is its private log output and its Result Bundle,
        // which is project source in all but name.
        const mode = statSync(join(evidenceDirectory(home), "2026-09-15T00-00-00-000Z")).mode
        expect(mode & 0o077).toBe(0)
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })

  test("says so rather than failing when a throw left nothing to keep", () => {
    withHome((home) => {
      // A run that threw before it wrote anything. An empty directory here
      // would read as evidence somebody has already looked through.
      const kept = preserveEvidence(join(home, "never-existed"), {
        startedAt: "2026-09-15T00:00:00.000Z",
        homeDir: home,
      })

      expect(kept.status).toBe("discarded")
      expect(setsIn(home)).toEqual([])
    })
  })

  test("is discarded rather than kept when one run exceeds the whole budget", () => {
    withHome((home) => {
      const source = sourceTree(4096)
      try {
        const kept = preserveEvidence(source, {
          startedAt: "2026-09-15T00:00:00.000Z",
          homeDir: home,
          policy: { ...EVIDENCE_POLICY, maxBytes: 1024 },
        })

        // The alternative is a permanent exception to the bound, which is not
        // a bound. A reader is told it was not kept and why, rather than left
        // to conclude the run was fine.
        expect(kept.status).toBe("discarded")
        expect(setsIn(home)).toEqual([])
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })
})

describe("the evidence store", () => {
  test("keeps only the newest sets its count allows", () => {
    withHome((home) => {
      plantSet(home, "oldest", 16, 3_000)
      plantSet(home, "middle", 16, 2_000)
      plantSet(home, "newer", 16, 1_000)
      plantSet(home, "newest", 16, 0)

      pruneEvidence(home, { ...EVIDENCE_POLICY, maxSets: 2 })

      expect(setsIn(home)).toEqual(["newer", "newest"])
    })
  })

  test("drops anything past its age whatever the count allows", () => {
    withHome((home) => {
      plantSet(home, "ancient", 16, 30 * 24 * 60 * 60 * 1000)
      plantSet(home, "recent", 16, 0)

      // Two sets, a limit of three: only age can remove one here, which is
      // what makes this about age rather than about crowding.
      pruneEvidence(home, EVIDENCE_POLICY)

      expect(setsIn(home)).toEqual(["recent"])
    })
  })

  test("drops the oldest until the bytes fit", () => {
    withHome((home) => {
      plantSet(home, "old", 900, 2_000)
      plantSet(home, "new", 900, 0)

      pruneEvidence(home, { ...EVIDENCE_POLICY, maxBytes: 1000 })

      expect(setsIn(home)).toEqual(["new"])
    })
  })

  test("reports nothing to prune rather than failing when there is no store", () => {
    withHome((home) => {
      // The ordinary case on a machine where the gate has never failed.
      expect(pruneEvidence(home, EVIDENCE_POLICY)).toEqual([])
    })
  })
})

describe("Layer 4 itself", () => {
  /**
   * Run the real suite with a runtime that cannot start, so every scenario
   * fails in milliseconds.
   *
   * The failures are real ones through the production path — the supervisor
   * genuinely cannot be spawned — which is what makes this a test of the
   * suite's own decision rather than of a flag passed to it.
   */
  async function layer4With(overrides: Record<string, unknown>) {
    const kept: Array<{ source: string; startedAt: string }> = []
    let threw: unknown

    try {
      await runLayer4(
        {
          toolchain: identityFor(loadFixture("passed")),
          runtimePath: "/nonexistent/runtime",
          destination: { kind: "id", id: "NO-SUCH-DEVICE" },
          startedAt: "2026-09-15T00:00:00.000Z",
          keepEvidence: (input) => kept.push(input),
          ...overrides,
        } as never,
        () => {},
      )
    } catch (error) {
      threw = error
    }

    return { kept, threw }
  }

  test("keeps its evidence when a scenario fails", async () => {
    const { kept, threw } = await layer4With({})

    expect(threw).toBeUndefined()
    expect(kept).toHaveLength(1)
  }, 60_000)

  test("keeps its evidence when it ends by throwing", async () => {
    // The path nobody plans for, and the one where the workspace is most
    // worth having: a throw says where it happened and nothing about what the
    // runs that led up to it had produced.
    const { kept, threw } = await layer4With({ toolchain: undefined })

    expect(threw).toBeDefined()
    expect(kept).toHaveLength(1)
  }, 60_000)

  test("names a source inside its own workspace, never the user's storage", async () => {
    // What gets copied is the run storage the suite built for itself. Naming
    // anything under the real home here would mean a failing gate copied a
    // user's actual runs into a second place.
    const { kept } = await layer4With({})

    expect(kept[0]?.source).toContain("xcode-test-gate-")
  }, 60_000)
})

describe("what makes a run worth keeping evidence for", () => {
  test("is a failed gating scenario, and only that", () => {
    // The success path, stated where it can be checked. A run that reached the
    // end with nothing gating against it has passed, and a passing run keeps
    // nothing: its workspace is regenerable and its evidence proves only what
    // the report already says.
    expect(countsAsFailure({ name: "passing run", kind: "gating", status: "passed", detail: "" }))
      .toBe(false)
    expect(countsAsFailure({ name: "passing run", kind: "gating", status: "skipped", detail: "" }))
      .toBe(false)
    expect(countsAsFailure({ name: "passing run", kind: "gating", status: "failed", detail: "" }))
      .toBe(true)
  })

  test("is never a report-only scenario, however it went", () => {
    // Cancellation and timeout are report-only per ADR 0001 because they are
    // timing-sensitive by nature. A run whose only disappointment was one of
    // those has passed, and keeping a Result Bundle for it would fill the
    // store from green runs — the failure mode the bound exists to prevent,
    // reached from the other direction.
    expect(
      countsAsFailure({ name: "real cancellation", kind: "report-only", status: "failed", detail: "" }),
    ).toBe(false)
  })
})
