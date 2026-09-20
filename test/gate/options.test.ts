/**
 * The acceptance gate's command line (issue #27).
 *
 * This gate's output is a claim about whether map #1's destination has been
 * reached, so the ways it could make that claim falsely are the subject here.
 * An option misread as a selection, or a selection that turns out to be empty,
 * both end with a green report on a machine where nothing ran — which is worse
 * than no gate, because someone believes it.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseOptions, SUITES } from "../../scripts/gate/options.ts"

function parsed(argv: string[]) {
  const result = parseOptions(argv)
  if (result.status !== "parsed") throw new Error(`expected a parse, got: ${result.message}`)
  return result.options
}

function rejection(argv: string[]): string {
  const result = parseOptions(argv)
  if (result.status !== "rejected") throw new Error("expected a rejection")
  return result.message
}

describe("selecting suites", () => {
  test("runs everything when nothing is named", () => {
    expect(parsed([]).suites).toEqual([...SUITES])
  })

  test("runs exactly what is named, in a stable order", () => {
    // Stable order so two invocations that select the same suites produce
    // comparable reports, whatever order the flags were typed in.
    expect(parsed(["--b2", "--b1"]).suites).toEqual(["b1", "b2"])
    expect(parsed(["--b1", "--b2"]).suites).toEqual(["b1", "b2"])
  })

  test("treats a repeated flag as one selection", () => {
    expect(parsed(["--b1", "--b1"]).suites).toEqual(["b1"])
  })

  test("never yields an empty selection", () => {
    // The property that matters: there is no argv this accepts that would run
    // nothing, because "nothing ran" and "everything passed" must not be the
    // same report.
    for (const argv of [[], ["--b1"], ["--layer4", "--b2"]]) {
      expect(parsed(argv).suites.length).toBeGreaterThan(0)
    }
  })
})

describe("an option the gate does not know", () => {
  test("is refused rather than ignored", () => {
    // `--layer-4` selects nothing and would otherwise run nothing at all.
    expect(rejection(["--layer-4"])).toContain("unknown option")
    expect(rejection(["--B1"])).toContain("unknown option")
    expect(rejection(["--projects", "/tmp"])).toContain("unknown option")
  })

  test("is refused when it is not an option at all", () => {
    expect(rejection(["b1"])).toContain("unexpected argument")
    expect(rejection(["--b1", "stray"])).toContain("unexpected argument")
  })
})

describe("--project", () => {
  function project<T>(work: (path: string) => T): T {
    const path = mkdtempSync(join(tmpdir(), "xcode-test-gate-"))
    try {
      return work(path)
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  }

  test("is canonical, so every layer below decides containment against a real directory", () => {
    project((path) => {
      // `realpath`, not merely absolute. On macOS the temp directory is itself
      // reached through a symlink, so a containment root taken at face value would
      // be compared against something it does not equal — which is the whole
      // of what containment below this depends on.
      expect(parsed(["--project", path]).project).toBe(realpathSync(path))
    })
  })

  test("resolves a relative path the way someone typing one at a shell means it", () => {
    expect(parsed(["--project", "."]).project).toBe(process.cwd())
  })

  test("needs a path, and does not swallow the next flag as one", () => {
    expect(rejection(["--project"])).toContain("needs a path")
    expect(rejection(["--project", "--b1"])).toContain("needs a path")
  })

  test("refuses something that is not an existing directory", () => {
    project((path) => {
      const file = join(path, "not-a-directory")
      writeFileSync(file, "")
      expect(rejection(["--project", file])).toContain("not an existing directory")
    })
    expect(rejection(["--project", "/nope/nowhere"])).toContain("not an existing directory")
  })

  test("does not change which suites run", () => {
    // A real project points the execution suites somewhere else; it is not
    // itself a selection, and must not quietly become the standing gate.
    project((path) => {
      expect(parsed(["--project", path]).suites).toEqual([...SUITES])
      expect(parsed(["--b1", "--project", path]).suites).toEqual(["b1"])
    })
  })
})
