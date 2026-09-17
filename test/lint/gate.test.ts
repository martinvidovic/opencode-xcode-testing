/**
 * The combined quality gate, executed rather than described (issue #100).
 *
 * `typescript-contract.test.ts` beside this one reads `tsconfig.json` and says
 * whether the contract is still strict. That is worth exactly as much as the
 * configuration itself was before anyone ran the compiler over it: strict and
 * unenforced for the whole life of this repository, with 240 errors behind it,
 * and a reader would have looked at it approvingly.
 *
 * So this file runs the command. It builds a tiny project carrying this
 * repository's own scripts, compiler options and `include` list, plants a type
 * error in it, and checks that `bun run check` fails — and that it passes when
 * there is nothing to find, because a gate that fails whatever it is given
 * proves nothing about the run that failed.
 *
 * Tiny, and not this checkout: a suite that ran the real gate inside itself
 * would take minutes and recurse. What is proved is the wiring — that the
 * command reaches a compiler, and that the compiler's answer decides.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..")

function tsconfig(): { compilerOptions: Record<string, unknown>; include: string[] } {
  return JSON.parse(readFileSync(join(REPO, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>
    include: string[]
  }
}

function manifest(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
}


describe("the combined quality gate", () => {
  test("runs the compiler and the suite, and fails if either fails", () => {
    // One command, because two were one too many (issue #100). The README
    // called `bun test` "the single gate" while the compiler it does not run
    // was holding 240 errors — and a contract that names two commands leaves
    // a reader to guess which one the word "gate" meant.
    expect(manifest().scripts?.["check"]).toBe("bun run typecheck && bun test")
  })

  test("keeps each half available on its own", () => {
    // `&&` short-circuits, so the combined command tells you about the
    // compiler or about the suite but never both at once. Someone fixing
    // types while tests are red needs to be able to ask one question.
    const { scripts } = manifest()
    expect(scripts?.["typecheck"]).toBeDefined()
    expect(scripts?.["test"]).toBe("bun test")
  })
})

describe("a planted type error", () => {
  /**
   * The check this file exists for, actually executed (issue #100).
   *
   * Every other test here reads configuration text, which is exactly as much
   * proof as the configuration was before anyone ran the compiler over it:
   * `tsconfig.json` was strict and unenforced for the whole life of this
   * repository, and reading it would have said so approvingly.
   *
   * So this builds a tiny project with the same contract, plants an error in
   * it, and runs the combined command. Tiny because the point is the wiring,
   * not the repository: a suite that ran the real gate inside itself would
   * take minutes and recurse.
   */
  function project(source: string): string {
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-gate-"))
    try {
      build(directory, source)
    } catch (error) {
      // Removed here as well as in the caller's `finally`: a fixture that
      // failed halfway through being built would otherwise leak a temp
      // directory, which is a property this repository measures.
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
    return directory
  }

  function build(directory: string, source: string): void {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "gate-fixture",
        private: true,
        type: "module",
        scripts: manifest().scripts,
      }),
    )
    writeFileSync(
      join(directory, "tsconfig.json"),
      // The repository's own options **and** its own `include`, unaltered.
      // Relaxing either would be checking a contract this repository does not
      // have, which is the failure mode the whole file is about — and the
      // error below is planted under `test`, so a gate that had quietly
      // stopped checking that tree would pass this and should not.
      JSON.stringify({ compilerOptions: tsconfig().compilerOptions, include: tsconfig().include }),
    )
    // Every tree the contract claims to check, so `include` is exercised
    // rather than asserted: a list that had lost one of these would leave the
    // compiler with nothing to find.
    for (const tree of tsconfig().include) mkdirSync(join(directory, tree), { recursive: true })
    writeFileSync(join(directory, "test", "subject.ts"), source)
    writeFileSync(join(directory, "src", "shipped.ts"), "export const shipped = true\n")
    writeFileSync(join(directory, "scripts", "tool.ts"), "export const tool = true\n")

    // A suite with something in it, so the second half of the command has a
    // reason to succeed: `bun test` over an empty project exits non-zero, and
    // a fixture that failed for that would prove nothing about the compiler.
    writeFileSync(
      join(directory, "test", "subject.test.ts"),
      'import { expect, test } from "bun:test"\ntest("runs", () => expect(1).toBe(1))\n',
    )

    // The compiler this repository pins, reached from where it is installed.
    symlinkSync(join(REPO, "node_modules"), join(directory, "node_modules"))
  }

  function check(directory: string): { code: number; output: string } {
    const run = spawnSync("bun", ["run", "check"], { cwd: directory, encoding: "utf8" })
    return { code: run.status ?? -1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` }
  }

  test("fails the combined gate", () => {
    const directory = project("export const answer: number = 'not a number'\n")
    try {
      const { code, output } = check(directory)

      expect(code).not.toBe(0)
      // And fails *because the compiler said so*, rather than for any other
      // reason a command can exit non-zero.
      expect(output).toContain("subject.ts")
      expect(output).toContain("not assignable")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

  test("does not fail the combined gate when there is no error to find", () => {
    // The other half of the claim. A gate that fails whatever it is given
    // proves nothing about the run that failed.
    const directory = project("export const answer: number = 42\n")
    try {
      expect(check(directory).code).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
