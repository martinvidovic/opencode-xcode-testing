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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describeEvidence } from "../../scripts/acceptance-gate.ts"
import {
  EVIDENCE_POLICY,
  evidenceDirectory,
  preserveEvidence,
  pruneEvidence,
} from "../../scripts/gate/forensics.ts"
import { countsAsFailure, runLayer4, type Layer4Options } from "../../scripts/gate/layer4.ts"
import { keyFor, reportPathFor } from "../../scripts/gate/report.ts"
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
  const run = join(source, "runs", "abc")
  mkdirSync(join(run, "result.xcresult"), { recursive: true })
  writeFileSync(join(run, "metadata.json"), "x".repeat(bytes))
  writeFileSync(join(run, "result.xcresult", "Info.plist"), "x".repeat(bytes))
  // World-readable on purpose. `xcodebuild` writes a Result Bundle at
  // 0755/0644, so a copy that carried source modes would land like this — and
  // a test whose source was already private could never tell.
  chmodSync(join(run, "result.xcresult"), 0o755)
  chmodSync(join(run, "result.xcresult", "Info.plist"), 0o644)
  return source
}

/** Every path beneath `root`, and `root` itself. */
function everythingUnder(root: string): string[] {
  const found = [root]
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    found.push(path)
    if (statSync(path).isDirectory()) found.push(...everythingUnder(path).slice(1))
  }
  return found
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
        expect(reportPathFor(startedAt, home)).toContain(keyFor(startedAt))
        expect(setsIn(home)).toEqual([keyFor(startedAt)])
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
        // which is project source in all but name. Checked to the leaves, not
        // at the root: `cpSync` carries the source's modes, and a Result
        // Bundle arrives from `xcodebuild` at 0755/0644. A 0700 root contains
        // those in practice, and "in practice" is not what the rest of this
        // tool's storage promises.
        const root = join(evidenceDirectory(home), "2026-09-15T00-00-00-000Z")
        for (const path of everythingUnder(root)) {
          expect(statSync(path).mode & 0o077).toBe(0)
        }
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
  test("makes room before it copies, not after", () => {
    withHome((home) => {
      // The bound has to hold at every instant, not only once the dust
      // settles. Pruning afterwards would leave a window holding the old store
      // *and* the new set — which for real Result Bundles is hundreds of
      // megabytes, and is the failure this is meant to prevent rather than a
      // moment on the way to preventing it.
      plantSet(home, "already-there", 900, 1_000)
      const source = sourceTree(100)

      try {
        const kept = preserveEvidence(source, {
          startedAt: "2026-09-15T00:00:00.000Z",
          homeDir: home,
          policy: { ...EVIDENCE_POLICY, maxBytes: 1000 },
        })

        // The planted set fits the budget on its own, so a prune that did not
        // know what was coming would have kept it — and then written past the
        // budget.
        expect(kept.status).toBe("preserved")
        expect(setsIn(home)).toEqual(["2026-09-15T00-00-00-000Z"])
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })

  test("counts the set it is about to write against the limit", () => {
    withHome((home) => {
      // The same reservation as for bytes, and needed for the same reason: a
      // prune that made room for three and then wrote a fourth has kept four.
      plantSet(home, "a-oldest", 16, 3_000)
      plantSet(home, "b-middle", 16, 2_000)
      plantSet(home, "c-newest", 16, 1_000)
      const source = sourceTree(16)

      try {
        preserveEvidence(source, {
          startedAt: "2026-09-15T00:00:00.000Z",
          homeDir: home,
          policy: { ...EVIDENCE_POLICY, maxSets: 3 },
        })

        expect(setsIn(home)).toEqual(["2026-09-15T00-00-00-000Z", "b-middle", "c-newest"])
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })

  test("does not treat a set it has just written as old", () => {
    withHome((home) => {
      // Age here is age *in the store*, which works because `cpSync` stamps
      // the copy "now" rather than carrying the source's timestamps. Asking it
      // to preserve them would make every freshly kept set look as old as the
      // run it came from and be pruned on arrival.
      const source = sourceTree(16)
      try {
        preserveEvidence(source, { startedAt: "2026-09-15T00:00:00.000Z", homeDir: home })
        pruneEvidence({ homeDir: home })

        expect(setsIn(home)).toEqual(["2026-09-15T00-00-00-000Z"])
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })

  test("keeps only the newest sets its count allows", () => {
    withHome((home) => {
      plantSet(home, "oldest", 16, 3_000)
      plantSet(home, "middle", 16, 2_000)
      plantSet(home, "newer", 16, 1_000)
      plantSet(home, "newest", 16, 0)

      pruneEvidence({ homeDir: home, policy: { ...EVIDENCE_POLICY, maxSets: 2 } })

      expect(setsIn(home)).toEqual(["newer", "newest"])
    })
  })

  test("drops anything past its age whatever the count allows", () => {
    withHome((home) => {
      plantSet(home, "ancient", 16, 30 * 24 * 60 * 60 * 1000)
      plantSet(home, "recent", 16, 0)

      // Two sets, a limit of three: only age can remove one here, which is
      // what makes this about age rather than about crowding.
      pruneEvidence({ homeDir: home })

      expect(setsIn(home)).toEqual(["recent"])
    })
  })

  test("drops the oldest until the bytes fit", () => {
    withHome((home) => {
      plantSet(home, "old", 900, 2_000)
      plantSet(home, "new", 900, 0)

      pruneEvidence({ homeDir: home, policy: { ...EVIDENCE_POLICY, maxBytes: 1000 } })

      expect(setsIn(home)).toEqual(["new"])
    })
  })

  test("reports nothing to prune rather than failing when there is no store", () => {
    withHome((home) => {
      // The ordinary case on a machine where the gate has never failed.
      expect(pruneEvidence({ homeDir: home })).toEqual([])
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
  async function layer4With(overrides: Partial<Layer4Options>) {
    const kept: string[] = []
    let threw: unknown

    try {
      await runLayer4(
        {
          toolchain: identityFor(loadFixture("passed")),
          runtimePath: "/nonexistent/runtime",
          destination: { kind: "id", id: "NO-SUCH-DEVICE" },
          startedAt: "2026-09-15T00:00:00.000Z",
          keepEvidence: (source) => kept.push(source),
          ...overrides,
        } as Layer4Options,
        () => {},
      )
    } catch (error) {
      threw = error
    }

    return { kept, threw }
  }

  test("keeps its evidence when a scenario fails, from inside its own workspace", async () => {
    const { kept, threw } = await layer4With({})

    expect(threw).toBeUndefined()
    expect(kept).toHaveLength(1)

    // What gets copied is the run storage the suite built for itself. Naming
    // anything under the real home would mean a failing gate copied a user's
    // actual runs into a second place.
    expect(kept[0]).toContain("xcode-test-gate-")
  }, 60_000)

  test("keeps its evidence when it ends by throwing", async () => {
    // The path nobody plans for, and the one where the workspace is most
    // worth having: a throw says where it happened and nothing about what the
    // runs that led up to it had produced.
    // `toolchain` removed rather than set to `undefined`: the option is not
    // optional, and what this arranges is a suite that throws when it reads it.
    const { kept, threw } = await layer4With({ toolchain: undefined as never })

    expect(threw).toBeDefined()
    expect(kept).toHaveLength(1)
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

describe("what the report is told", () => {
  test("names the key and the size when evidence was kept", () => {
    withHome((home) => {
      const source = sourceTree(32)
      try {
        const described = describeEvidence(source, "2026-09-15T00:00:00.000Z", home)

        expect(described).toEqual({ key: "2026-09-15T00-00-00-000Z", bytes: 64 })
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })

  test("survives a store it cannot write to, and says why", () => {
    withHome((home) => {
      // The claim worth checking. This runs on the failing path, often the
      // exceptional one, and losing the account of *why* a run failed in the
      // course of trying to keep more of it would be the wrong trade every
      // time. A file where the storage root should be is the bluntest way to
      // make the store unwritable.
      const blocked = join(home, "blocked")
      writeFileSync(blocked, "not a directory")
      const source = sourceTree(32)

      try {
        const described = describeEvidence(source, "2026-09-15T00:00:00.000Z", blocked)

        expect(described).toHaveProperty("unavailable")
        // Redacted on the way out, like every other diagnostic this gate
        // prints: a reason is not worth a path leak.
        expect(JSON.stringify(described)).not.toContain(blocked)
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    })
  })
})
