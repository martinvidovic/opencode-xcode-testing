import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LAYERS, lintImports, type ImportViolation } from "./import-lint.ts"

const REPO_SRC = join(import.meta.dir, "..", "..", "src")

describe("the shipped source tree", () => {
  test("satisfies the import lint", () => {
    expect(lintImports(REPO_SRC)).toEqual([])
  })
})

describe("the import lint", () => {
  test("rejects a package that is neither node:* nor the host package", () => {
    expect(rulesFor({ "domain/a.ts": `import { z } from "zod"\n` })).toEqual(["forbiddenPackage"])
  })

  test("permits node:* built-ins in every layer", () => {
    const tree = Object.fromEntries(
      LAYERS.map((layer) => [`${layer}/a.ts`, `import { readFileSync } from "node:fs"\n`]),
    )
    expect(rulesFor(tree)).toEqual([])
  })

  test("permits the host package in the adapter", () => {
    expect(rulesFor({ "adapter/a.ts": `import { tool } from "@opencode-ai/plugin"\n` })).toEqual([])
  })

  test("rejects the host package outside the adapter", () => {
    const tree = {
      "domain/a.ts": `import type { Tool } from "@opencode-ai/plugin"\n`,
      "runner/a.ts": `import { tool } from "@opencode-ai/plugin"\n`,
      "interpreter/a.ts": `export { tool } from "@opencode-ai/plugin"\n`,
    }
    expect(rulesFor(tree)).toEqual([
      "hostPackageOutsideAdapter",
      "hostPackageOutsideAdapter",
      "hostPackageOutsideAdapter",
    ])
  })

  test("rejects a cross-seam import between the runner and the interpreter", () => {
    const tree = {
      "runner/a.ts": `import { x } from "../interpreter/b.ts"\n`,
      "interpreter/b.ts": `export const x = 1\n`,
    }
    expect(rulesFor(tree)).toEqual(["crossLayer"])
  })

  test("rejects the interpreter reaching back into the runner", () => {
    const tree = {
      "interpreter/a.ts": `export { x } from "../runner/b.ts"\n`,
      "runner/b.ts": `export const x = 1\n`,
    }
    expect(rulesFor(tree)).toEqual(["crossLayer"])
  })

  test("rejects the domain importing any other layer", () => {
    const tree = {
      "domain/a.ts": `import { x } from "../runner/b.ts"\nimport { y } from "../adapter/c.ts"\n`,
      "runner/b.ts": `export const x = 1\n`,
      "adapter/c.ts": `export const y = 1\n`,
    }
    expect(rulesFor(tree)).toEqual(["crossLayer", "crossLayer"])
  })

  test("permits the one-way direction it is meant to allow", () => {
    const tree = {
      "domain/a.ts": `export const x = 1\n`,
      "runner/b.ts": `import { x } from "../domain/a.ts"\n`,
      "interpreter/c.ts": `import { x } from "../domain/a.ts"\n`,
      "adapter/d.ts": `import { x } from "../domain/a.ts"\nimport "../runner/b.ts"\nexport * from "../interpreter/c.ts"\n`,
    }
    expect(rulesFor(tree)).toEqual([])
  })

  test("rejects a relative import that leaves the source tree", () => {
    expect(rulesFor({ "adapter/a.ts": `import { x } from "../../test/helper.ts"\n` })).toEqual([
      "outsideSourceTree",
    ])
  })

  test("rejects require(), which Bun would happily execute", () => {
    expect(rulesFor({ "runner/a.ts": `const fs = require("node:fs")\n` })).toEqual(["require"])
  })

  test("rejects dynamic import()", () => {
    expect(rulesFor({ "adapter/a.ts": `const m = await import("node:fs")\n` })).toEqual([
      "dynamicImport",
    ])
  })

  test("does not mistake import.meta.url for a dynamic import", () => {
    expect(rulesFor({ "runner/a.ts": `export const here = import.meta.url\n` })).toEqual([])
  })

  test("reports the file and line of each violation", () => {
    const violations = lint({ "domain/a.ts": `export const x = 1\n\nimport "left-pad"\n` })
    expect(violations).toEqual([
      expect.objectContaining({ file: "domain/a.ts", line: 3, specifier: "left-pad" }),
    ])
  })
})

function lint(files: Record<string, string>): ImportViolation[] {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-import-lint-"))
  try {
    for (const layer of LAYERS) mkdirSync(join(root, layer), { recursive: true })
    for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents)
    return lintImports(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function rulesFor(files: Record<string, string>): string[] {
  return lint(files).map((violation) => violation.rule)
}
