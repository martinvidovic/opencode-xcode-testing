/**
 * The hygiene lint (ADR 0001, extended to goldens by ADR 0002).
 *
 * Public artifacts must stay generic: no absolute paths, no usernames, and no
 * project identifiers outside the generic allowlist. This runs over exactly the
 * artifacts that render or embed real-world facts — fixtures, discovery
 * manifests, scripts, agent templates, and the renderer goldens — because those
 * are where a private path actually leaks into a public repository.
 *
 * It is mechanical on purpose. A convention that only reviewers enforce is a
 * convention that eventually fails.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import { join, relative, resolve } from "node:path"

/** Directories the lint covers, relative to the repository root. */
export const HYGIENE_ROOTS = [
  "test/fixtures",
  "test/golden",
  "scripts",
  "examples/agent",
] as const

/**
 * Base names a committed artifact may use for an Xcode container, scheme,
 * bundle, or reverse-DNS identifier. Anything else is presumed private.
 */
export const GENERIC_IDENTIFIERS = new Set([
  "App",
  "AppTests",
  "AppUITests",
  "Demo",
  "DemoTests",
  "Example",
  "ExampleTests",
  "ExampleUITests",
  "Fixture",
  "FixtureTests",
  "Generic",
  "Sample",
  "SampleTests",
  "SampleUITests",
  "Package",
  "Tests",
  "UITests",
  "app",
  "demo",
  "example",
  "fixture",
  "generic",
  "sample",
  "test",
  "tests",
])

export type HygieneViolation = {
  file: string
  line: number
  rule: "absolutePath" | "homeReference" | "username" | "privateIdentifier"
  match: string
  message: string
}

/**
 * Lint every file beneath each of `roots` that exists. Missing roots are not an
 * error — the skeleton legitimately starts with empty ones.
 */
export function lintHygiene(
  repoRoot: string,
  roots: readonly string[] = HYGIENE_ROOTS,
): HygieneViolation[] {
  const base = resolve(repoRoot)
  const violations: HygieneViolation[] = []

  for (const root of roots) {
    const dir = resolve(base, root)
    if (!exists(dir)) continue
    for (const file of filesUnder(dir)) {
      violations.push(...lintFile(relative(base, file), readFileSync(file, "utf8")))
    }
  }

  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  )
}

/** Lint one file's text. Exported so a test can plant a violation without a fixture. */
export function lintFile(display: string, text: string): HygieneViolation[] {
  const violations: HygieneViolation[] = []
  const username = userInfo().username

  text.split("\n").forEach((rawLine, index) => {
    const line = index + 1
    const push = (rule: HygieneViolation["rule"], match: string, message: string) =>
      violations.push({ file: display, line, rule, match, message })

    for (const match of rawLine.matchAll(ABSOLUTE_PATH)) {
      push("absolutePath", match[0], "committed artifacts must not contain absolute paths")
    }

    for (const match of rawLine.matchAll(HOME_REFERENCE)) {
      push("homeReference", match[0], "committed artifacts must not reference a home directory")
    }

    if (username.length >= 3) {
      for (const match of rawLine.matchAll(wordPattern(username))) {
        push("username", match[0], "committed artifacts must not contain a username")
      }
    }

    for (const match of rawLine.matchAll(XCODE_ARTIFACT)) {
      const name = match[1]
      if (name !== undefined && !GENERIC_IDENTIFIERS.has(name)) {
        push(
          "privateIdentifier",
          match[0],
          `"${name}" is not in the generic-identifier allowlist`,
        )
      }
    }

    for (const match of rawLine.matchAll(REVERSE_DNS)) {
      // Apple's own reserved namespace is a vendor constant, not a private
      // project identifier — `com.apple.product-type.framework` names a fact
      // about Xcode, and nothing about whose repository this is.
      if (VENDOR_NAMESPACES.some((prefix) => match[0].startsWith(prefix))) continue

      const segments = match[0].split(".").slice(1)
      const offending = segments.find((segment) => !GENERIC_IDENTIFIERS.has(segment))
      if (offending !== undefined) {
        push(
          "privateIdentifier",
          match[0],
          `"${offending}" is not in the generic-identifier allowlist`,
        )
      }
    }
  })

  return violations
}

/** `/Users/...`, `/home/...`, `/Volumes/...`, and other machine-local roots. */
const ABSOLUTE_PATH = /\/(?:Users|home|Volumes|private\/var\/folders|var\/folders)\/[^\s"'`,)\]}]*/g

/** `~/…` and an explicit `$HOME`, both of which resolve to a machine-local path. */
const HOME_REFERENCE = /(?:(?<![\w/])~\/[^\s"'`,)\]}]*|\$HOME\b|\$\{HOME\})/g

/** `Something.xcodeproj` and friends — the name is the identifier under test. */
const XCODE_ARTIFACT = /\b([A-Za-z0-9_-]+)\.(?:xcodeproj|xcworkspace|xcscheme|xcresult|xctest)\b/g

/** Reverse-DNS prefixes owned by a vendor rather than by any project. */
const VENDOR_NAMESPACES = ["com.apple."]

/** Reverse-DNS bundle identifiers, whose every segment must read as generic. */
const REVERSE_DNS = /\b(?:com|org|net|io|dev|co|app)(?:\.[A-Za-z0-9_-]+){2,}\b/g

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(word)}(?![A-Za-z0-9_-])`, "g")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Every file beneath `dir`, sorted, skipping nothing — hidden files leak too. */
export function filesUnder(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else found.push(path)
    }
  }
  walk(dir)
  return found
}
