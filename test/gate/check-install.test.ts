/**
 * The installation check (issue #143).
 *
 * The V1 checkout needed a scripted symlink before its plugin could load at
 * all. On V2 the host supplies `@opencode/plugin` to the plugin at runtime, so
 * loading needs nothing installed — but the checkout pins exact packages for
 * type-checking and the acceptance gates, and a reader setting it up should
 * be told plainly what is missing, what disagrees, and what fixes it.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installationReport } from "../../scripts/check-install.ts"

function withCheckout<T>(installed: Record<string, string>, work: (repoRoot: string) => T): T {
  const repoRoot = mkdtempSync(join(tmpdir(), "xcode-test-install-check-"))
  try {
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ devDependencies: { "@opencode/plugin": "2.0.25", "@opencode/client": "2.0.25" } }),
    )
    for (const [name, version] of Object.entries(installed)) {
      const directory = join(repoRoot, "node_modules", "@opencode", name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@opencode/${name}`, version }))
    }
    return work(repoRoot)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
}

describe("a checkout installed as it pins, on the validated host", () => {
  test("is ready, and says what it was checked against", () => {
    withCheckout({ plugin: "2.0.25", client: "2.0.25" }, (repoRoot) => {
      const report = installationReport("2.0.25", repoRoot)
      expect(report.ready).toBe(true)
      expect(report.lines.join("\n")).toContain("OpenCode 2.0.25")
      expect(report.lines.join("\n")).toContain("plugin 2.0.25, client 2.0.25")
    })
  })
})

describe("a checkout nobody has installed", () => {
  test("is not ready, and names the command that fixes it", () => {
    withCheckout({}, (repoRoot) => {
      const report = installationReport("2.0.25", repoRoot)
      expect(report.ready).toBe(false)
      expect(report.lines.join("\n")).toContain("bun install")
    })
  })
})

describe("a checkout installed against something else", () => {
  test("is not ready when an installed package is not the pinned one", () => {
    withCheckout({ plugin: "2.0.24", client: "2.0.25" }, (repoRoot) => {
      const report = installationReport("2.0.25", repoRoot)
      expect(report.ready).toBe(false)
      expect(report.lines.join("\n")).toContain("2.0.24")
    })
  })

  test("is not ready on a host of another major", () => {
    withCheckout({ plugin: "2.0.25", client: "2.0.25" }, (repoRoot) => {
      expect(installationReport("1.18.30", repoRoot).ready).toBe(false)
    })
  })

  test("is ready on another 2.x host, and says it is untested there", () => {
    withCheckout({ plugin: "2.0.25", client: "2.0.25" }, (repoRoot) => {
      const report = installationReport("2.1.0", repoRoot)
      expect(report.ready).toBe(true)
      expect(report.lines.join("\n")).toContain("2.1.0")
    })
  })

  test("is not ready when no OpenCode is on PATH", () => {
    withCheckout({ plugin: "2.0.25", client: "2.0.25" }, (repoRoot) => {
      const report = installationReport("unknown", repoRoot)
      expect(report.ready).toBe(false)
      expect(report.lines.join("\n")).toContain("opencode")
    })
  })
})
