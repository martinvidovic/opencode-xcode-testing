/**
 * Which OpenCode packages a run was green against (issues #81, #142).
 *
 * On V1 the packages were the host's: installed under the user's config
 * directory on the host's schedule, and only symlinked into this checkout.
 * On V2 they are this checkout's own — `@opencode/plugin` and
 * `@opencode/client`, pinned exactly in `package.json` and installed with
 * `bun install` (issue #140). So the questions change shape:
 *
 * - **What is installed?** The versions in the checkout's `node_modules`.
 * - **Is it what the checkout pins?** A manifest, a lockfile and an installed
 *   package that disagree mean the next install changes what is being tested.
 * - **Is the host the one they were validated against?** Stated, never
 *   assumed: a different 2.x is a caveat, a different major is a problem.
 *
 * What is gone is the rule that the two packages ship as one version. That was
 * a fact about the V1 host-managed tree, and nothing about V2 requires it.
 *
 * Real directories, because what is being read is a package tree.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { missingPackages, readProvenance } from "../../scripts/gate/provenance.ts"

type Name = "plugin" | "client"

type Tree = {
  installed?: Partial<Record<Name, string | Record<string, unknown>>>
  pinned?: Partial<Record<Name, string>>
  /** What the checkout's `bun.lock` resolved each package to. */
  locked?: Partial<Record<Name, string>>
}

/** A checkout holding exactly the tree described. */
function withCheckout<T>(tree: Tree, work: (repoRoot: string) => T): T {
  const repoRoot = mkdtempSync(join(tmpdir(), "xcode-test-provenance-"))

  try {
    for (const [name, declared] of Object.entries(tree.installed ?? {})) {
      const directory = join(repoRoot, "node_modules", "@opencode", name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, "package.json"),
        typeof declared === "string"
          ? JSON.stringify({ name: `@opencode/${name}`, version: declared })
          : JSON.stringify(declared),
      )
    }

    const devDependencies = Object.fromEntries(
      Object.entries(tree.pinned ?? {}).map(([name, version]) => [`@opencode/${name}`, version]),
    )
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ devDependencies }))

    if (tree.locked !== undefined) {
      const entries = Object.entries(tree.locked)
        .map(([name, version]) => `    "@opencode/${name}": ["@opencode/${name}@${version}", "", {}, "sha512-x"],`)
        .join("\n")
      writeFileSync(join(repoRoot, "bun.lock"), `{\n  "lockfileVersion": 1,\n  "packages": {\n${entries}\n  }\n}\n`)
    }

    return work(repoRoot)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
}

const AGREED: Tree = {
  installed: { plugin: "2.0.25", client: "2.0.25" },
  pinned: { plugin: "2.0.25", client: "2.0.25" },
  locked: { plugin: "2.0.25", client: "2.0.25" },
}

describe("a checkout installed exactly as it pins", () => {
  test("reports both versions and says nothing is wrong", () => {
    withCheckout(AGREED, (repoRoot) => {
      const provenance = readProvenance("2.0.25", repoRoot)
      expect(provenance.packages.plugin).toMatchObject({ version: "2.0.25", requested: "2.0.25" })
      expect(provenance.packages.client).toMatchObject({ version: "2.0.25", requested: "2.0.25" })
      expect(provenance.problems).toEqual([])
      expect(provenance.caveats).toEqual([])
    })
  })

  test("does not require the two packages to share a version", () => {
    // A V1 rule about a host-managed tree. Two exact pins that disagree are
    // still two exact pins.
    const tree: Tree = {
      installed: { plugin: "2.0.25", client: "2.0.24" },
      pinned: { plugin: "2.0.25", client: "2.0.24" },
    }
    withCheckout(tree, (repoRoot) => expect(readProvenance("2.0.25", repoRoot).problems).toEqual([]))
  })
})

describe("a host other than the one the packages were validated against", () => {
  test("is a caveat naming both numbers when only the minor or patch differs", () => {
    withCheckout(AGREED, (repoRoot) => {
      const provenance = readProvenance("2.1.0", repoRoot)
      expect(provenance.problems).toEqual([])
      expect(provenance.caveats.join(" ")).toContain("2.1.0")
      expect(provenance.caveats.join(" ")).toContain("2.0.25")
    })
  })

  test("is a problem when the major differs", () => {
    withCheckout(AGREED, (repoRoot) => {
      expect(readProvenance("1.18.30", repoRoot).problems.join(" ")).toContain("1.18.30")
    })
  })

  test("holds the client to the host's major too, since the gates drive the host through it", () => {
    const tree: Tree = {
      installed: { plugin: "2.0.25", client: "3.0.0" },
      pinned: { plugin: "2.0.25", client: "3.0.0" },
    }
    withCheckout(tree, (repoRoot) => {
      expect(readProvenance("2.0.25", repoRoot).problems.join(" ")).toContain("@opencode/client is 3.0.0")
    })
  })

  test("reads a host version written the way `opencode --version` writes it", () => {
    withCheckout(AGREED, (repoRoot) => {
      expect(readProvenance("opencode v2.0.25", repoRoot)).toMatchObject({ problems: [], caveats: [] })
    })
  })

  test("says so rather than skipping the check when the host version is unreadable", () => {
    withCheckout(AGREED, (repoRoot) => {
      expect(readProvenance("unknown", repoRoot).caveats.join(" ")).toContain("unknown")
    })
  })
})

describe("a checkout that disagrees with itself", () => {
  test("refuses an installed package other than the pinned one", () => {
    const tree: Tree = { installed: { plugin: "2.0.24", client: "2.0.25" }, pinned: { plugin: "2.0.25", client: "2.0.25" } }
    withCheckout(tree, (repoRoot) => {
      const problems = readProvenance("2.0.25", repoRoot).problems.join(" ")
      expect(problems).toContain("2.0.24")
      expect(problems).toContain("bun install")
    })
  })

  test("refuses a lockfile that resolved something other than what is installed", () => {
    const tree: Tree = { ...AGREED, locked: { plugin: "2.0.24", client: "2.0.25" } }
    withCheckout(tree, (repoRoot) => {
      expect(readProvenance("2.0.25", repoRoot).problems.join(" ")).toContain("lockfile")
    })
  })

  test("refuses a package directory that carries no usable manifest", () => {
    const tree: Tree = { ...AGREED, installed: { plugin: { name: "something-else" }, client: "2.0.25" } }
    withCheckout(tree, (repoRoot) => {
      expect(readProvenance("2.0.25", repoRoot).problems.join(" ")).toContain("@opencode/plugin")
    })
  })

  test("redacts a path-shaped name before quoting it", () => {
    const tree: Tree = {
      ...AGREED,
      installed: { plugin: { name: "/Users/someone/secret", version: "2.0.25" }, client: "2.0.25" },
    }
    withCheckout(tree, (repoRoot) => {
      expect(readProvenance("2.0.25", repoRoot).problems.join(" ")).not.toContain("/Users/someone")
    })
  })
})

describe("a checkout nobody has installed", () => {
  test("names each missing package and the command that installs it", () => {
    withCheckout({ pinned: { plugin: "2.0.25", client: "2.0.25" } }, (repoRoot) => {
      const missing = missingPackages(repoRoot)
      expect(missing).toContain("@opencode/plugin")
      expect(missing).toContain("@opencode/client")
      expect(missing).toContain("bun install")
    })
  })

  test("says nothing when everything is there", () => {
    withCheckout(AGREED, (repoRoot) => expect(missingPackages(repoRoot)).toBeUndefined())
  })
})
