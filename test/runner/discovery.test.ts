/**
 * Container and scheme discovery (#6), driven by declarative manifests
 * (ADR 0001, Layer 2).
 *
 * The trees are declared rather than committed because git cannot carry what
 * these cases are about: it mangles or ignores symlinks and hidden directories,
 * and an empty `.xcodeproj` is not a thing a repository can hold. Materializing
 * each manifest into a temp directory at test time gives the real filesystem
 * shapes discovery has to cope with.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { discoverContainer, discoverScheme, scan } from "../../src/runner/discovery.ts"

const MANIFEST_DIR = join(import.meta.dir, "..", "fixtures", "discovery")

type Manifest = {
  provenance: { scenario: string; covers: string }
  tree: { dirs?: string[]; files?: Record<string, string>; symlinks?: Record<string, string> }
  expect: {
    container:
      | { status: "found"; kind: "workspace" | "project"; path: string }
      | { status: "ambiguous"; candidates: string[] }
      | { status: "none" }
    scheme?:
      | { status: "found"; value: string }
      | { status: "ambiguous"; candidates: string[] }
      | { status: "none" }
  }
}

function manifestNames(): string[] {
  return readdirSync(MANIFEST_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => name.replace(/\.json$/, ""))
}

function loadManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, `${name}.json`), "utf8")) as Manifest
}

/** Materialize a declared tree into a real temp directory. */
export function materialize(manifest: Manifest): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-discovery-"))

  for (const dir of manifest.tree.dirs ?? []) mkdirSync(join(root, dir), { recursive: true })
  for (const [path, contents] of Object.entries(manifest.tree.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  for (const [link, target] of Object.entries(manifest.tree.symlinks ?? {})) {
    mkdirSync(dirname(join(root, link)), { recursive: true })
    symlinkSync(target, join(root, link))
  }

  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function withTree<T>(manifest: Manifest, work: (root: string) => T): T {
  const tree = materialize(manifest)
  try {
    return work(tree.root)
  } finally {
    tree.dispose()
  }
}

describe("every discovery manifest", () => {
  test("declares what it covers, so the set is auditable at a glance", () => {
    const names = manifestNames()
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const manifest = loadManifest(name)
      expect(manifest.provenance.scenario).toBe(name)
      expect(manifest.provenance.covers.length).toBeGreaterThan(0)
    }
  })

  for (const name of manifestNames()) {
    const manifest = loadManifest(name)

    test(`${name}: ${manifest.provenance.covers}`, () => {
      withTree(manifest, (root) => {
        const container = discoverContainer(root)
        expect(container.status).toBe(manifest.expect.container.status)

        if (manifest.expect.container.status === "found" && container.status === "found") {
          expect(container.value).toEqual({
            kind: manifest.expect.container.kind,
            path: manifest.expect.container.path,
          })
        }
        if (manifest.expect.container.status === "ambiguous" && container.status === "ambiguous") {
          expect(container.candidates).toEqual(manifest.expect.container.candidates)
        }

        const expectedScheme = manifest.expect.scheme
        if (expectedScheme === undefined || container.status !== "found") return

        const scheme = discoverScheme(root, container.value)
        expect(scheme.status).toBe(expectedScheme.status)
        if (expectedScheme.status === "found" && scheme.status === "found") {
          expect(scheme.value).toBe(expectedScheme.value)
        }
        if (expectedScheme.status === "ambiguous" && scheme.status === "ambiguous") {
          expect(scheme.candidates).toEqual(expectedScheme.candidates)
        }
      })
    })
  }
})

describe("the scan itself", () => {
  test("never descends through a symlinked directory", () => {
    withTree(loadManifest("symlinked-directory"), (root) => {
      const found = scan(root)
      // The project exists once, at its real path — not again through the link.
      expect(found.projects).toEqual(["outside/Sample.xcodeproj"])
    })
  })

  test("does not treat a symlink named like a container as one", () => {
    withTree(loadManifest("symlinked-container"), (root) => {
      expect(scan(root).projects).toEqual(["real/Example.xcodeproj"])
    })
  })

  test("skips hidden, vendor and build directories", () => {
    withTree(loadManifest("excluded-directories"), (root) => {
      expect(scan(root).projects).toEqual(["Example.xcodeproj"])
    })
  })

  test("reports candidates in a stable order", () => {
    withTree(loadManifest("multiple-projects"), (root) => {
      expect(scan(root).projects).toEqual(scan(root).projects.slice().sort())
    })
  })
})
