/**
 * The shipped tree uses the glossary's words (issue #63).
 *
 * `CONTEXT.md` names each concept once and lists what it is *not*. That is not
 * a style preference: this tool's claim is that a reader can tell what it did
 * and did not establish, and two names for one thing make a reader wonder
 * whether they are two things — the exact doubt the glossary removes.
 *
 * Linted rather than reviewed, for the reason `hygiene-lint` gives about
 * itself: a convention only reviewers enforce is one that eventually fails.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { avoidedTerms, lintVocabulary } from "./vocabulary-lint.ts"

const REPO = join(import.meta.dir, "..", "..")
const CONTEXT = join(REPO, "CONTEXT.md")

describe("the repository", () => {
  test("uses the glossary's terms throughout", () => {
    // One sweep from the root rather than one per tree, so every path is
    // unique and an exemption for `src/interpreter/log.ts` cannot silently
    // also exempt `test/interpreter/log.ts`. It also means nothing is outside
    // the lint by having been left off a list.
    const violations = lintVocabulary(REPO, CONTEXT)

    // Named rather than counted: the point of failing is to say where, and
    // what to write instead.
    expect(
      violations.map((v) => `${v.file}:${v.line} "${v.found}" → ${v.canonical}`),
    ).toEqual([])
  })
})

describe("the lint itself", () => {
  test("takes its rulings from the glossary rather than repeating them", () => {
    // A second copy of the glossary is precisely the mistake this exists to
    // catch, so the rulings are read from `CONTEXT.md` at run time.
    const rulings = avoidedTerms(CONTEXT)

    expect(rulings.get("detail page")).toBe("Focused Detail")
    expect(rulings.get("log page")).toBe("Log Chunk")
  })

  test("rules only on phrases, never on ordinary single words", () => {
    // `Execution Slot` avoids "lock", and this codebase is full of locks that
    // really are locks. A lint that flagged them is one nobody could keep, and
    // an unkeepable lint is a disabled lint.
    const rulings = avoidedTerms(CONTEXT)

    for (const avoided of rulings.keys()) expect(avoided).toContain(" ")
  })

  test("catches an avoided phrase wherever it is written", () => {
    // The negative control: without this, every assertion above would pass on
    // a lint that found nothing because it looked nowhere.
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-vocab-"))
    try {
      writeFileSync(join(directory, "a.ts"), "// returns a detail page\nexport const x = 1\n")

      expect(lintVocabulary(directory, CONTEXT)).toEqual([
        { file: "a.ts", line: 1, found: "detail page", canonical: "Focused Detail" },
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
