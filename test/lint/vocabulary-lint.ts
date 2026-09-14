/**
 * The vocabulary lint (CONTEXT.md, issue #63).
 *
 * `CONTEXT.md` fixes a term for each concept and lists, for each, the words it
 * is *not*. Those `_Avoid_` lines are not style preferences. They exist
 * because this tool's whole claim is that a reader can tell what it did and
 * did not establish, and two names for one thing make a reader wonder whether
 * they are two things — which is exactly the doubt the glossary is written to
 * remove. "Focused Detail" and "focused view" sitting a few lines apart cost
 * nothing to write and something real to read.
 *
 * A source-text lint, like `import-lint` and `hygiene-lint` beside it, and for
 * the same reasons: it has to hold over a tree that does not compile, it must
 * not need a host, and a convention only reviewers enforce is one that
 * eventually fails.
 *
 * Deliberately narrow. It reads the avoided terms out of `CONTEXT.md` rather
 * than carrying its own list — a second copy of the glossary is the mistake it
 * exists to catch — and it checks only the terms a glossary entry actually
 * names, so it can never object to a word nobody has ruled on.
 *
 * It also allows, by name, the places where an avoided phrase is the correct
 * word for something else entirely. A glossary ruling says "do not call *this*
 * that"; it does not reserve the words. Xcode really does have test targets,
 * and a lint that could not say so would be a lint somebody turns off.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export type VocabularyViolation = {
  file: string
  line: number
  /** The word used. */
  found: string
  /** The glossary term it should have been. */
  canonical: string
}

/**
 * The glossary's own rulings: for each avoided word, the term to use instead.
 *
 * Only entries whose avoided word is a phrase are taken. Single words like
 * "lock" or "page" are ordinary English in this codebase — `withLock` is a
 * lock — and a lint that flagged them would be one nobody could keep.
 */
export function avoidedTerms(contextFile: string): Map<string, string> {
  const rulings = new Map<string, string>()
  const lines = readFileSync(contextFile, "utf8").split("\n")

  let term: string | undefined
  for (const line of lines) {
    const heading = /^\*\*(.+?)\*\*:/.exec(line)
    if (heading?.[1] !== undefined) {
      term = heading[1]
      continue
    }

    const avoid = /^_Avoid_:\s*(.+)$/.exec(line)
    if (avoid?.[1] === undefined || term === undefined) continue

    for (const raw of avoid[1].split(",")) {
      const word = raw.trim()
      if (word.length === 0 || !word.includes(" ")) continue
      rulings.set(word.toLowerCase(), term)
    }
  }

  return rulings
}

/**
 * Report every use of an avoided phrase beneath `root`.
 *
 * `CONTEXT.md` itself is not linted: it is where the avoided words are
 * written down, so it is the one file that must contain them.
 */
export function lintVocabulary(root: string, contextFile: string): VocabularyViolation[] {
  const rulings = avoidedTerms(contextFile)
  const violations: VocabularyViolation[] = []

  for (const file of textFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n")

    const display = relative(root, file)
    if (display.includes(SELF)) continue

    lines.forEach((text, index) => {
      const lowered = text.toLowerCase()
      for (const [avoided, canonical] of rulings) {
        if (!mentions(lowered, avoided)) continue
        if (LITERAL_USES.some((use) => display.endsWith(use.file) && use.term === avoided)) continue
        violations.push({ file: display, line: index + 1, found: avoided, canonical })
      }
    })
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

/**
 * Where an avoided phrase is the right word for a different thing.
 *
 * Kept short and stated, in the manner of `hygiene-lint`'s generic-identifier
 * allowlist: an exemption nobody can see is an exemption that grows.
 */
export const LITERAL_USES: ReadonlyArray<{ file: string; term: string; because: string }> = [
  {
    file: "interpreter/log.ts",
    term: "test output",
    because:
      "the literal output of tests, enumerated among what a raw log contains — not a Result Bundle",
  },
  {
    file: "runner/generation.test.ts",
    term: "test target",
    because:
      "an Xcode build target of type bundle.unit-test, which is what the fixture project declares — not a Requested Scope",
  },
]

/**
 * Whether the line uses the phrase, rather than merely containing its letters.
 *
 * Hyphens count as word characters here, which is the whole point: the
 * diagnostic "the xcode-test plugin checkout is incomplete" contains the
 * letters of "test plugin" and uses no such phrase. A lint that flagged it
 * would be teaching people to write around it.
 */
function mentions(line: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(line)
}

/** The lint's own files, which must contain the words they rule on. */
const SELF = "lint/vocabulary"

const LINTED = new Set([".ts", ".txt", ".md"])
const SKIPPED = new Set(["node_modules", ".git", "fixtures", "golden"])

function textFiles(root: string): string[] {
  const found: string[] = []

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory).sort()) {
      if (SKIPPED.has(entry)) continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (LINTED.has(entry.slice(entry.lastIndexOf(".")))) found.push(path)
    }
  }

  walk(root)
  return found
}
