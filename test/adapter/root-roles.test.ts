/**
 * The Containment Root, Configuration Root, and enablement marker (ADR 0002, #6).
 *
 * The root is the boundary every path guarantee rests on. If a tool argument
 * could move it, the rest of the safety story would be decorative — so it is
 * resolved once, from host handles only, and canonicalized.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  configurationPath,
  enablementMarkerExists,
  readProjectConfiguration,
  resolveRootRoles,
} from "../../src/adapter/root-roles.ts"

function project(configure?: (root: string) => void): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-root-"))
  configure?.(root)
  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function withProject<T>(work: (root: string) => T, configure?: (root: string) => void): T {
  const created = project(configure)
  try {
    return work(created.root)
  } finally {
    created.dispose()
  }
}

function writeConfiguration(root: string, contents: string): void {
  mkdirSync(join(root, ".opencode"), { recursive: true })
  writeFileSync(configurationPath(root), contents)
}

describe("the root roles", () => {
  test("prefers the worktree the host supplies", () => {
    withProject((root) => {
      const nested = join(root, "nested")
      mkdirSync(nested)
      const outcome = resolveRootRoles({ worktree: root, directory: nested })
      expect(outcome).toEqual({
        status: "resolved",
        containmentRoot: realpathSync(root),
        configurationRoot: realpathSync(root),
      })
    })
  })

  test("falls back to the directory when there is no worktree", () => {
    withProject((root) => {
      expect(resolveRootRoles({ directory: root })).toEqual({
        status: "resolved",
        containmentRoot: realpathSync(root),
        configurationRoot: realpathSync(root),
      })
    })
  })

  test("treats a root or empty worktree as absent, not as the filesystem root", () => {
    // A host that finds no git worktree reports "/" — observed in the headless
    // gate, where it silently disabled the plugin in every non-git project and
    // would have keyed artifact storage and discovery to the whole filesystem.
    withProject((root) => {
      for (const worktree of ["", "   ", "/"]) {
        expect(resolveRootRoles({ worktree, directory: root })).toEqual({
          status: "resolved",
          containmentRoot: realpathSync(root),
          configurationRoot: realpathSync(root),
        })
      }
    })
  })

  test("canonicalizes once, so a link swapped later cannot redirect storage", () => {
    withProject((root) => {
      const real = join(root, "real")
      mkdirSync(real)
      const link = join(root, "link")
      symlinkSync(real, link)

      expect(resolveRootRoles({ directory: link })).toEqual({
        status: "resolved",
        containmentRoot: realpathSync(real),
        configurationRoot: realpathSync(real),
      })
    })
  })

  test("fails hard when it cannot be resolved, rather than guessing", () => {
    expect(resolveRootRoles({ directory: "/nonexistent/path" })).toMatchObject({
      status: "failed",
    })
  })
})

describe("the enablement marker", () => {
  test("is the configuration file's presence, and nothing else", () => {
    withProject((root) => {
      expect(enablementMarkerExists(root)).toBe(false)
      writeConfiguration(root, '{ "schemaVersion": 1 }')
      expect(enablementMarkerExists(root)).toBe(true)
    })
  })

  test("is looked up at exactly one path, with no upward search", () => {
    // An upward search would let a file two directories up decide what a
    // project tests.
    withProject((root) => {
      const nested = join(root, "nested")
      mkdirSync(nested)
      writeConfiguration(root, '{ "schemaVersion": 1 }')
      expect(enablementMarkerExists(nested)).toBe(false)
    })
  })
})

describe("the project configuration", () => {
  test("is absent when the file is not there", () => {
    withProject((root) => {
      expect(readProjectConfiguration(root)).toEqual({ status: "absent" })
    })
  })

  test("loads when the minimum one line is present", () => {
    withProject((root) => {
      writeConfiguration(root, '{ "schemaVersion": 1 }')
      expect(readProjectConfiguration(root)).toEqual({
        status: "loaded",
        configuration: { schemaVersion: 1 },
      })
    })
  })

  test("loads every optional field it recognizes", () => {
    withProject((root) => {
      writeConfiguration(
        root,
        JSON.stringify({
          schemaVersion: 1,
          scheme: "App",
          destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
          derivedData: { mode: "isolated" },
          timeoutSeconds: 300,
          runtime: "tools/bun",
        }),
      )
      const outcome = readProjectConfiguration(root)
      expect(outcome.status).toBe("loaded")
      if (outcome.status !== "loaded") return
      expect(outcome.configuration.runtime).toBe("tools/bun")
      expect(outcome.configuration.derivedData?.mode).toBe("isolated")
    })
  })

  test("rejects malformed JSON rather than treating it as absent", () => {
    withProject((root) => {
      writeConfiguration(root, "{ not json")
      expect(readProjectConfiguration(root)).toMatchObject({ status: "invalid" })
    })
  })

  test("rejects an unsupported schema version", () => {
    withProject((root) => {
      writeConfiguration(root, '{ "schemaVersion": 2 }')
      expect(readProjectConfiguration(root)).toMatchObject({ status: "invalid" })
    })
  })

  test("rejects an unknown field, so a typo cannot silently do nothing", () => {
    withProject((root) => {
      writeConfiguration(root, '{ "schemaVersion": 1, "schemeName": "App" }')
      const outcome = readProjectConfiguration(root)
      expect(outcome.status).toBe("invalid")
      if (outcome.status !== "invalid") return
      expect(outcome.message).toContain("schemeName")
    })
  })

  test("rejects a file that is not an object", () => {
    withProject((root) => {
      writeConfiguration(root, "[1, 2, 3]")
      expect(readProjectConfiguration(root)).toMatchObject({ status: "invalid" })
    })
  })
})
