/**
 * The restricted-agent templates (ADR 0002, ADR 0003).
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

type Rule = { action: string; resource: string; effect: string }

type Template = {
  name: string
  frontmatter: string
  body: string
  /** V2 permission rules in source order — order is part of the contract. */
  permissions: Rule[]
}

function templates(): Template[] {
  return readdirSync(TEMPLATE_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map((entry) => parse(entry, readFileSync(join(TEMPLATE_DIR, entry), "utf8")))
}

/**
 * A deliberately tiny frontmatter reader for the one shape under test: a
 * `permissions:` list of `action` / `resource` / `effect` mappings. A YAML
 * library would be a dependency taken to parse a dozen lines.
 */
function parse(name: string, source: string): Template {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
  if (match === null) throw new Error(`${name} has no frontmatter`)

  const frontmatter = match[1] as string
  const permissions: Rule[] = []
  let current: Partial<Rule> | undefined
  const flush = () => {
    if (current === undefined) return
    if (current.action === undefined || current.resource === undefined || current.effect === undefined) {
      throw new Error(`${name} has an incomplete permission rule`)
    }
    permissions.push(current as Rule)
    current = undefined
  }

  let inPermissions = false
  for (const line of frontmatter.split("\n")) {
    if (/^permissions:\s*$/.test(line)) {
      inPermissions = true
      continue
    }
    if (inPermissions && /^\S/.test(line)) break
    if (!inPermissions) continue

    const field = /^\s+(-\s+)?(action|resource|effect):\s*"?([^"]*?)"?\s*$/.exec(line)
    if (field === null) continue
    if (field[1] !== undefined) {
      flush()
      current = {}
    }
    if (current !== undefined) current[field[2] as keyof Rule] = field[3] as string
  }
  flush()

  return { name, frontmatter, body: match[2] as string, permissions }
}

const allowed = (template: Template) =>
  template.permissions.filter((rule) => rule.effect === "allow").map((rule) => rule.action)

describe("the shipped templates", () => {
  test("are the two the documentation names", () => {
    expect(templates().map((template) => template.name)).toEqual([
      "xcode-developer.md",
      "xcode-test-runner.md",
    ])
  })

  for (const template of templates()) {
    describe(template.name, () => {
      test("opens with a catch-all deny, so nothing is reachable unless named after it", () => {
        // The last matching rule wins (issue #140), so a catch-all placed
        // after the specifics would deny everything.
        expect(template.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
      })

      test("exposes the whole tool family, each on its own key", () => {
        for (const tool of FAMILY) {
          expect(template.permissions).toContainEqual({ action: tool, resource: "*", effect: "allow" })
        }
      })

      test("never allows the shell back, and grants no Code Mode authority", () => {
        // On V2 the shell's action is `shell`, and `execute` is Code Mode —
        // which would reach every tool through a route the rules above do not
        // shape. Neither is needed to run tests.
        expect(allowed(template)).not.toContain("shell")
        expect(allowed(template)).not.toContain("bash")
        expect(allowed(template)).not.toContain("execute")
      })

      test("uses V2 permission rules, never the V1 map or the deprecated tools map", () => {
        expect(template.frontmatter).not.toMatch(/^permission:/m)
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

    // The runner is the strict one: the family and nothing else.
    expect(allowed(runner).sort()).toEqual([...FAMILY].sort())
    // The developer can read and edit — `edit` covers write and patch on V2 —
    // and still has no shell.
    expect(allowed(developer)).toContain("edit")
    expect(allowed(developer)).toContain("read")
    expect(allowed(developer)).not.toContain("shell")
  })
})
