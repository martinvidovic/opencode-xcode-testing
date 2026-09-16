/**
 * Which OpenCode packages a run was green against (issue #81).
 *
 * The report named the host version and stopped there, which is the least
 * informative of the three numbers that matter. The adapter is written against
 * `@opencode-ai/plugin`; the gates drive a host through `@opencode-ai/sdk`;
 * and both are resolved from a tree the host manages under the user's config
 * directory, on its own schedule.
 *
 * On the machine this was written on, the host was 1.18.29 and both packages
 * were 1.15.12 — three minors behind, installed once and left, because the
 * config manifest pins a range and upgrading the host does not revisit it. So
 * "tested against OpenCode 1.18.29" was true of the host and false of
 * everything the code was linked to, and nothing said so.
 *
 * Real directories, because what is being read is a package tree.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readProvenance } from "../../scripts/gate/provenance.ts"

type Tree = {
  plugin?: string | Record<string, unknown>
  sdk?: string | Record<string, unknown>
  requested?: Record<string, string>
  /** What a `bun.lock` beside them resolved each package to. */
  locked?: Partial<Record<"plugin" | "sdk", string>>
  /** The same, written as npm does it. */
  npmLocked?: Partial<Record<"plugin" | "sdk", string>>
}

/** A config directory holding exactly the tree described. */
function withTree<T>(tree: Tree, work: (configDirectory: string) => T): T {
  const configDirectory = mkdtempSync(join(tmpdir(), "xcode-test-provenance-"))

  try {
    for (const name of ["plugin", "sdk"] as const) {
      const declared = tree[name]
      if (declared === undefined) continue
      const directory = join(configDirectory, "node_modules", "@opencode-ai", name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, "package.json"),
        typeof declared === "string"
          ? JSON.stringify({ name: `@opencode-ai/${name}`, version: declared })
          : JSON.stringify(declared),
      )
    }

    if (tree.requested !== undefined) {
      writeFileSync(
        join(configDirectory, "package.json"),
        JSON.stringify({ dependencies: tree.requested }),
      )
    }

    if (tree.locked !== undefined) {
      // With the trailing commas Bun writes, because that is why the entries
      // are read by pattern rather than parsed — a lock this test wrote as
      // strict JSON would exercise a file Bun never produces.
      const entries = Object.entries(tree.locked)
        .map(([name, version]) => `    "@opencode-ai/${name}": ["@opencode-ai/${name}@${version}", "", {}, "sha512-x"],`)
        .join("\n")
      writeFileSync(
        join(configDirectory, "bun.lock"),
        `{\n  "lockfileVersion": 1,\n  "packages": {\n${entries}\n  },\n}\n`,
      )
    }

    if (tree.npmLocked !== undefined) {
      const packages: Record<string, { version: string }> = {}
      for (const [name, version] of Object.entries(tree.npmLocked)) {
        packages[`node_modules/@opencode-ai/${name}`] = { version: version as string }
      }
      writeFileSync(join(configDirectory, "package-lock.json"), JSON.stringify({ packages }))
    }

    return work(configDirectory)
  } finally {
    rmSync(configDirectory, { recursive: true, force: true })
  }
}

describe("a tree that matches the host", () => {
  test("reports both versions and says nothing is wrong", () => {
    withTree(
      { plugin: "1.18.29", sdk: "1.18.29", requested: { "@opencode-ai/plugin": "^1.18.0" } },
      (directory) => {
        const provenance = readProvenance("1.18.29", directory)

        expect(provenance.packages.plugin.version).toBe("1.18.29")
        expect(provenance.packages.sdk.version).toBe("1.18.29")
        expect(provenance.packages.plugin.requested).toBe("^1.18.0")
        expect(provenance.problems).toEqual([])
        expect(provenance.caveats).toEqual([])
      },
    )
  })
})

describe("a tree the host has outgrown", () => {
  test("is a caveat naming both numbers and the command that fixes it", () => {
    // The state of the machine this was written on, and the ordinary state of
    // a host-managed install. Never gating: failing here would make the gate
    // unrunnable because of an install nobody has re-run in a directory this
    // repository does not own.
    withTree({ plugin: "1.15.12", sdk: "1.15.12" }, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toEqual([])
      expect(provenance.caveats).toHaveLength(1)
      expect(provenance.caveats[0]).toContain("1.18.29")
      expect(provenance.caveats[0]).toContain("1.15.12")
      expect(provenance.caveats[0]).toContain("bun install")
    })
  })

  test("is a problem when the major differs, not a caveat", () => {
    // Across a major the plugin interface may change out from under this
    // adapter, and a gate passing against these would be proving something
    // about an interface nobody ships.
    withTree({ plugin: "0.9.0", sdk: "0.9.0" }, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toHaveLength(1)
      expect(provenance.problems[0]).toContain("across a major")
    })
  })

  test("is neither when the packages are ahead of the host", () => {
    // Not stale, and not a mismatch either. Saying "stale" about a tree that
    // is newer than the host would send a reader to run the command that
    // produced it.
    withTree({ plugin: "1.19.0", sdk: "1.19.0" }, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toEqual([])
      expect(provenance.caveats).toEqual([])
    })
  })
})

describe("a tree that disagrees with itself", () => {
  test("refuses when the two packages are different versions", () => {
    // They ship as a set, so a tree where they differ was assembled by hand or
    // interrupted part-way — and neither is something to draw conclusions
    // from.
    withTree({ plugin: "1.18.29", sdk: "1.15.12" }, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toHaveLength(1)
      expect(provenance.problems[0]).toContain("ship as a set")
    })
  })

  test("refuses when what is installed is not what the manifest asks for", () => {
    // The next install in that directory would change what is being tested,
    // and nobody afterwards could say which run was which.
    withTree(
      { plugin: "1.15.12", sdk: "1.15.12", requested: { "@opencode-ai/plugin": "^1.18.0" } },
      (directory) => {
        const provenance = readProvenance("1.18.29", directory)

        expect(provenance.problems.some((entry) => entry.includes("does not satisfy"))).toBe(true)
      },
    )
  })

  test("refuses a package directory that carries no usable manifest", () => {
    // The tree exists and cannot be characterized, which is worse than its
    // being absent: absent is a machine nobody has set up, and this is a
    // machine whose packages cannot be attributed to a version at all.
    withTree({ plugin: { name: "something-else", version: "1.18.29" } }, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toHaveLength(1)
      expect(provenance.problems[0]).toContain("declares itself")
    })
  })

  test("says nothing about a package that is simply not installed", () => {
    // Not a disagreement — there is nothing yet for anything to disagree
    // with. The gates that need one say so themselves, in words about what
    // they were trying to do.
    withTree({}, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toEqual([])
      expect(provenance.packages.plugin.version).toBeUndefined()
    })
  })
})

describe("a lockfile beside the packages", () => {
  test("agreeing with what is installed says nothing", () => {
    withTree(
      { plugin: "1.18.29", sdk: "1.18.29", locked: { plugin: "1.18.29", sdk: "1.18.29" } },
      (directory) => {
        const provenance = readProvenance("1.18.29", directory)

        expect(provenance.packages.plugin.locked).toBe("1.18.29")
        expect(provenance.problems).toEqual([])
      },
    )
  })

  test("disagreeing with what is installed is a problem, not a caveat", () => {
    // Somebody installed by hand, or an install was interrupted. Either way
    // the next install in that directory silently restores a different
    // version from the one every report so far was written about.
    withTree({ plugin: "1.18.29", sdk: "1.18.29", locked: { plugin: "1.15.12" } }, (directory) => {
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toHaveLength(1)
      expect(provenance.problems[0]).toContain("on disk")
      expect(provenance.problems[0]).toContain("in the lockfile")
    })
  })

  test("is read in npm's format too, where that is what the directory has", () => {
    // OpenCode installs with Bun, but a machine where somebody has run `npm
    // install` in that directory has the other file — and a check that only
    // read one would report agreement it had not looked for.
    withTree(
      { plugin: "1.18.29", sdk: "1.18.29", npmLocked: { plugin: "1.15.12" } },
      (directory) => {
        const provenance = readProvenance("1.18.29", directory)

        expect(provenance.problems).toHaveLength(1)
        expect(provenance.problems[0]).toContain("in the lockfile")
      },
    )
  })

  test("that nobody can parse says nothing rather than failing", () => {
    // It is not this repository's file. An unreadable one leaves the check
    // exactly where it was before the check existed.
    withTree({ plugin: "1.18.29", sdk: "1.18.29" }, (directory) => {
      writeFileSync(join(directory, "package-lock.json"), "{ not json")
      const provenance = readProvenance("1.18.29", directory)

      expect(provenance.problems).toEqual([])
    })
  })
})
