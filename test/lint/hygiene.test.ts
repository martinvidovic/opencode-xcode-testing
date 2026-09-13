import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

import { lintFile, lintHygiene } from "./hygiene-lint.ts"

const REPO_ROOT = join(import.meta.dir, "..", "..")

describe("the committed artifacts", () => {
  test("satisfy the hygiene lint", () => {
    expect(lintHygiene(REPO_ROOT)).toEqual([])
  })
})

describe("the hygiene lint", () => {
  test("rejects an absolute home path", () => {
    expect(rulesFor(`"container": "/Users/someone/Code/Thing.xcodeproj"`)).toContain("absolutePath")
  })

  test("rejects other machine-local absolute roots", () => {
    expect(rulesFor(`derivedData: /private/var/folders/ab/cd/T/DerivedData`)).toContain(
      "absolutePath",
    )
    expect(rulesFor(`path: /Volumes/External/work`)).toContain("absolutePath")
  })

  test("rejects home-directory references", () => {
    expect(rulesFor(`runtime: ~/.bun/bin/bun`)).toEqual(["homeReference"])
    expect(rulesFor(`runtime: $HOME/.bun/bin/bun`)).toEqual(["homeReference"])
  })

  test("rejects the current username", () => {
    const username = userInfo().username
    expect(rulesFor(`author: ${username}`)).toContain("username")
  })

  test("rejects an Xcode container outside the generic allowlist", () => {
    expect(rulesFor(`workspace: AcmePayments.xcworkspace`)).toEqual(["privateIdentifier"])
  })

  test("rejects a reverse-DNS bundle identifier outside the allowlist", () => {
    expect(rulesFor(`bundleId: com.acme.payments`)).toEqual(["privateIdentifier"])
  })

  test("accepts generic identifiers", () => {
    const generic = [
      `workspace: Example.xcworkspace`,
      `project: Example.xcodeproj`,
      `scheme: App`,
      `bundle: AppTests.xctest`,
      `bundleId: com.example.app`,
      `container: Sample.xcodeproj`,
    ].join("\n")
    expect(lintFile("fixture.yaml", generic)).toEqual([])
  })

  test("reports the line each violation sits on", () => {
    const violations = lintFile("fixture.json", `{\n  "ok": 1,\n  "path": "/Users/someone/x"\n}\n`)
    expect(violations).toEqual([expect.objectContaining({ line: 3, rule: "absolutePath" })])
  })

  test("walks every covered root and skips ones that do not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "xcode-test-hygiene-lint-"))
    try {
      mkdirSync(join(root, "test", "golden"), { recursive: true })
      writeFileSync(join(root, "test", "golden", "passed.txt"), "Ran 3 tests in Example.xctest\n")
      writeFileSync(join(root, "test", "golden", "failed.txt"), "at /Users/someone/App.swift:12\n")

      const violations = lintHygiene(root, ["test/golden", "examples/agent"])
      expect(violations).toEqual([
        expect.objectContaining({ file: join("test", "golden", "failed.txt"), rule: "absolutePath" }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function rulesFor(text: string): string[] {
  return lintFile("fixture", text).map((violation) => violation.rule)
}
