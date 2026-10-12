import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LAYERS, lintImports, type ImportViolation } from "./import-lint.ts"

const REPO = join(import.meta.dir, "..", "..")
const REPO_SRC = join(REPO, "src")
/**
 * Every root entrypoint shipped beside `src` — `server.ts` today, and whatever
 * else the host may resolve a plugin directory to tomorrow (issue #157).
 */
const ROOT_ENTRYPOINTS = readdirSync(REPO)
  .filter((entry) => entry.endsWith(".ts"))
  .map((entry) => join(REPO, entry))

describe("the shipped source tree", () => {
  test("satisfies the import lint, root entrypoint included", () => {
    expect(ROOT_ENTRYPOINTS).toContain(join(REPO, "server.ts"))
    expect(lintImports(REPO_SRC, { entrypoints: ROOT_ENTRYPOINTS })).toEqual([])
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
    expect(rulesFor({ "adapter/a.ts": `import { Plugin } from "@opencode/plugin"\n` })).toEqual([])
  })

  test("rejects the host package outside the adapter", () => {
    const tree = {
      "domain/a.ts": `import type { Plugin } from "@opencode/plugin"\n`,
      "runner/a.ts": `import { Plugin } from "@opencode/plugin"\n`,
      "interpreter/a.ts": `export { Plugin } from "@opencode/plugin"\n`,
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

  test("rejects a forbidden import the formatter split across lines, at the specifier's line", () => {
    // The shape a long import list is formatted into, and the one a pattern
    // that stops at a newline never inspected (issue #157).
    const violations = lint({
      "runner/a.ts": `import {\n  x,\n  y,\n} from "../interpreter/b.ts"\n`,
      "interpreter/b.ts": `export const x = 1\nexport const y = 2\n`,
    })
    expect(violations).toEqual([
      expect.objectContaining({ file: "runner/a.ts", line: 4, rule: "crossLayer", specifier: "../interpreter/b.ts" }),
    ])
  })

  test("rejects forbidden multiline type imports and re-exports of every form", () => {
    const tree = {
      "domain/a.ts": [
        `import type {\n  X,\n} from "../runner/b.ts"`,
        `export {\n  y,\n} from "../runner/b.ts"`,
        `export * from "../adapter/c.ts"`,
        `export * as all from\n  "../adapter/c.ts"`,
        `import "zod"`,
        "",
      ].join("\n"),
      "runner/b.ts": `export type X = number\nexport const y = 1\n`,
      "adapter/c.ts": `export const z = 1\n`,
    }
    expect(lint(tree).map(({ line, rule }) => `${line} ${rule}`)).toEqual([
      "3 crossLayer",
      "6 crossLayer",
      "7 crossLayer",
      "9 crossLayer",
      "10 forbiddenPackage",
    ])
  })

  test("does not mistake an import written in a comment or a string for one", () => {
    const tree = {
      "domain/a.ts": `// import { x } from "../runner/b.ts"\nexport const s = 'import "zod"'\n`,
      "runner/b.ts": `export const x = 1\n`,
    }
    expect(rulesFor(tree)).toEqual([])
  })

  test("rejects a file that does not parse, rather than trusting what the parser recovered", () => {
    // Recovered into an object literal, this import is invisible to the walk.
    const tree = {
      "domain/a.ts": `const s = {\nimport { y } from "../runner/b.ts"\n`,
      "runner/b.ts": `export const y = 1\n`,
    }
    expect(rulesFor(tree)).toContain("unparseable")
  })

  test("lints a root entrypoint, which may reach only the adapter", () => {
    const tree = {
      "adapter/plugin.ts": `export default 1\n`,
      "runner/b.ts": `export const x = 1\n`,
    }
    const entrypoint = [
      `export { default } from "./src/adapter/plugin.ts"`,
      `export {\n  x,\n} from "./src/runner/b.ts"`,
      `import "./test/helper.ts"`,
      `import "@opencode/plugin"`,
      "",
    ].join("\n")

    expect(lint(tree, entrypoint).map(({ file, line, rule }) => `${file}:${line} ${rule}`)).toEqual([
      "server.ts:4 crossLayer",
      "server.ts:5 outsideSourceTree",
      "server.ts:6 hostPackageOutsideAdapter",
    ])
  })

  test("reports the file and line of each violation", () => {
    const violations = lint({ "domain/a.ts": `export const x = 1\n\nimport "left-pad"\n` })
    expect(violations).toEqual([
      expect.objectContaining({ file: "domain/a.ts", line: 3, specifier: "left-pad" }),
    ])
  })
})

/** Lint `files` as a `src` tree, with `entrypoint` as the `server.ts` beside it. */
function lint(files: Record<string, string>, entrypoint?: string): ImportViolation[] {
  const checkout = mkdtempSync(join(tmpdir(), "xcode-test-import-lint-"))
  const root = join(checkout, "src")
  try {
    for (const layer of LAYERS) mkdirSync(join(root, layer), { recursive: true })
    for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents)
    if (entrypoint === undefined) return lintImports(root)
    writeFileSync(join(checkout, "server.ts"), entrypoint)
    return lintImports(root, { entrypoints: [join(checkout, "server.ts")] })
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
}

function rulesFor(files: Record<string, string>): string[] {
  return lint(files).map((violation) => violation.rule)
}
