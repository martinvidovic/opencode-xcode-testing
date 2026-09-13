/**
 * The restricted-agent templates (ADR 0002).
 *
 * The acceptance gate asserts these through a real host, which is the check
 * that matters. These assertions are the cheap local ones that fail the moment
 * somebody edits a template, rather than an hour later in a headless instance:
 * a permission regression silently widens what an agent can reach, and that is
 * the kind of change nobody notices by reading a diff.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const TEMPLATE_DIR = join(import.meta.dir, "..", "..", "examples", "agent")

/** The tool family the templates exist to expose. */
const FAMILY = ["xcode_test", "xcode_test_inspect", "xcode_test_recover"]

type Template = {
  name: string
  frontmatter: string
  body: string
  /** Permission entries in source order — order is part of the contract. */
  permissions: Array<{ pattern: string; action: string }>
}

function templates(): Template[] {
  return readdirSync(TEMPLATE_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => parse(entry, readFileSync(join(TEMPLATE_DIR, entry), "utf8")))
}

/**
 * A deliberately tiny frontmatter reader. The project has zero dependencies,
 * and the shape under test is two levels deep — a YAML library would be a
 * dependency taken to parse eight lines.
 */
function parse(name: string, source: string): Template {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (match === null) throw new Error(`${name} has no frontmatter`)

  const frontmatter = match[1] as string
  const permissions: Array<{ pattern: string; action: string }> = []

  let inPermission = false
  for (const line of frontmatter.split("\n")) {
    if (/^permission:\s*$/.test(line)) {
      inPermission = true
      continue
    }
    if (inPermission && /^\S/.test(line)) break
    if (!inPermission) continue

    const entry = /^\s+("?)([^":]+)\1:\s*(\S+)\s*$/.exec(line)
    if (entry !== null) permissions.push({ pattern: entry[2] as string, action: entry[3] as string })
  }

  return { name, frontmatter, body: match[2] as string, permissions }
}

describe("the shipped templates", () => {
  test("are the two the documentation names", () => {
    expect(templates().map((template) => template.name)).toEqual([
      "xcode-developer.md",
      "xcode-test-runner.md",
    ])
  })

  for (const template of templates()) {
    describe(template.name, () => {
      test("opens with a catch-all deny, which is what hides a tool rather than blocking it", () => {
        // Rules are last-match-wins with key order preserved, so a catch-all
        // placed after the specifics would deny everything.
        expect(template.permissions[0]).toEqual({ pattern: "*", action: "deny" })
      })

      test("exposes the whole tool family", () => {
        const allowed = template.permissions
          .filter((entry) => entry.action === "allow")
          .map((entry) => entry.pattern)
        for (const tool of FAMILY) expect(allowed).toContain(tool)
      })

      test("hides bash by never allowing it back", () => {
        const patterns = template.permissions.map((entry) => entry.pattern)
        expect(patterns).not.toContain("bash")
      })

      test("uses permission rules, never the deprecated tools map", () => {
        // `tools` is normalized into `permission` and then overridden by any
        // explicit `permission` block, so mixing them silently loses one.
        expect(template.frontmatter).not.toMatch(/^tools:/m)
      })

      test("declares a description, since that is what the host lists it by", () => {
        expect(template.frontmatter).toMatch(/^description:\s+\S/m)
      })

      test("declares a mode", () => {
        expect(template.frontmatter).toMatch(/^mode:\s+(primary|subagent|all)\s*$/m)
      })

      test("carries no absolute path, so it is portable and committable", () => {
        for (const line of `${template.frontmatter}\n${template.body}`.split("\n")) {
          expect(line).not.toMatch(/(?:^|[\s"'(])[~/](?:Users|home|Volumes|absolute)\b/)
        }
      })

      test("tells the model what the outcomes mean, not just which tools exist", () => {
        // A restricted agent that reports `infrastructureFailed` as a pass is
        // worse than no agent at all.
        expect(template.body).toContain("infrastructureFailed")
      })
    })
  }
})

describe("the two templates", () => {
  test("differ in reach, not in what they hide", () => {
    const [developer, runner] = templates() as [Template, Template]
    const allowed = (template: Template) =>
      template.permissions.filter((entry) => entry.action === "allow").map((entry) => entry.pattern)

    // The runner is the strict one: the family and nothing else.
    expect(allowed(runner).sort()).toEqual([...FAMILY].sort())
    // The developer can read and edit, and still has no shell.
    expect(allowed(developer)).toContain("edit")
    expect(allowed(developer)).toContain("read")
    expect(allowed(developer)).not.toContain("bash")
  })
})
