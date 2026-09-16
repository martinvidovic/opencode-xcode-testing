/**
 * The type contract cannot be weakened quietly (issue #74).
 *
 * `tsconfig.json` had been strict and unenforced for the whole life of this
 * repository. Bun strips types rather than checking them, so nothing ever ran
 * the compiler — and 240 errors accumulated behind a configuration everybody
 * could see and nobody could fail. Among them: a scenario-name union that
 * collapsed to `never`, two acceptance-gate types that named identifiers
 * nothing defined, a validator reading a field off a type that has no such
 * field, and a `Focused` constraint no focused test could satisfy.
 *
 * Now that `bun run typecheck` is green, the way it stops being green is not
 * a new error — someone would see that — but a quiet edit here: a tree
 * dropped from `include`, a flag turned off to make one file compile. That is
 * what this file watches, and it is deliberately the one check in the suite
 * that reads a configuration file rather than any code.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")

function tsconfig(): { compilerOptions: Record<string, unknown>; include: string[] } {
  return JSON.parse(readFileSync(join(REPO, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>
    include: string[]
  }
}

function manifest(): { scripts?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
  }
}

/**
 * Every option this repository's type contract rests on.
 *
 * Listed rather than counted, because each buys something specific and a
 * reader turning one off should have to delete its name. `strict` is the
 * headline; the four below it are the ones that caught real defects here —
 * `noUncheckedIndexedAccess` found records read without checking they existed,
 * and `exactOptionalPropertyTypes` found shapes that serialize to something
 * other than what they claim.
 */
const REQUIRED_OPTIONS = [
  "strict",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
] as const

describe("the repository type contract", () => {
  test("keeps every strict option on", () => {
    const { compilerOptions } = tsconfig()

    for (const option of REQUIRED_OPTIONS) {
      expect(`${option}=${String(compilerOptions[option])}`).toBe(`${option}=true`)
    }
  })

  test("checks every tree that ships or gates", () => {
    // Excluding a tree is the other way to make the check pass, and the
    // quieter one: nothing fails, the command still says nothing is wrong,
    // and a whole directory has stopped being checked.
    expect(tsconfig().include.sort()).toEqual(["scripts", "src", "test"])
  })

  test("has a command that runs it, pinned to a version", () => {
    const { scripts, devDependencies } = manifest()

    // Run through Bun rather than through `tsc`'s own shebang: this repository
    // needs nothing but Bun, and a `node` shim on the path is enough to make
    // the bare binary refuse to start.
    expect(scripts?.["typecheck"]).toBe("bun node_modules/typescript/lib/tsc.js --noEmit")

    // Exact, not a range. A type check that resolves a different compiler on
    // a different machine is a check two people can disagree about.
    expect(devDependencies?.["typescript"]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(devDependencies?.["@types/bun"]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("keeps its type tooling out of what ships", () => {
    // The zero-runtime-dependency rule is about the plugin, which is loaded
    // from source and resolves its imports from its own location. A compiler
    // that only ever runs on a developer's machine is not part of that, and
    // saying so is what lets this repository have one at all.
    const { devDependencies } = manifest()
    const all = manifest() as { dependencies?: Record<string, string> }

    expect(all.dependencies).toBeUndefined()
    expect(Object.keys(devDependencies ?? {}).sort()).toEqual(["@types/bun", "typescript"])
  })
})
