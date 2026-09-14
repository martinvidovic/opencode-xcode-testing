/**
 * The host-package linker (issue #27).
 *
 * This script exists because a source-loaded plugin that cannot resolve its
 * imports loads into silence — the host swallows the error, and the result is
 * indistinguishable from a project that never opted in. A linker that pointed
 * at the wrong package would produce that same silence, with a reassuring
 * "linked" message in front of it, which is strictly worse than not running.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HOST_SCOPE, linkHostPackage } from "../../scripts/link-host-package.ts"

type Sandbox = { repo: string; config: string }

function sandbox<T>(work: (paths: Sandbox) => T): T {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-link-"))
  try {
    return work({ repo: join(root, "repo"), config: join(root, "config") })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A `@opencode-ai/plugin` in the host's config directory, as the host installs it. */
function hostPackage(config: string, name: string = `${HOST_SCOPE}/plugin`): string {
  const path = join(config, "node_modules", HOST_SCOPE, "plugin")
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0" }))
  return path
}

describe("linking", () => {
  test("points the checkout at the package the host installed", () => {
    sandbox(({ repo, config }) => {
      hostPackage(config)
      mkdirSync(repo, { recursive: true })

      const outcome = linkHostPackage(repo, config)
      expect(outcome.status).toBe("linked")
      if (outcome.status === "unavailable") return

      expect(readlinkSync(outcome.link)).toBe(join(config, "node_modules", HOST_SCOPE))
    })
  })

  test("is idempotent, and says which it did", () => {
    sandbox(({ repo, config }) => {
      hostPackage(config)
      mkdirSync(repo, { recursive: true })

      expect(linkHostPackage(repo, config).status).toBe("linked")
      expect(linkHostPackage(repo, config).status).toBe("linked")
    })
  })

  test("replaces a link that points nowhere", () => {
    sandbox(({ repo, config }) => {
      hostPackage(config)
      mkdirSync(join(repo, "node_modules"), { recursive: true })
      symlinkSync(join(config, "gone"), join(repo, "node_modules", HOST_SCOPE))

      // A checkout whose link broke — the config directory moved, say — must
      // heal rather than report success over a dangling link.
      expect(linkHostPackage(repo, config).status).toBe("linked")
    })
  })
})

describe("refusing to link", () => {
  test("when the host has not installed the package yet", () => {
    sandbox(({ repo, config }) => {
      mkdirSync(repo, { recursive: true })
      const outcome = linkHostPackage(repo, config)

      expect(outcome.status).toBe("unavailable")
      if (outcome.status !== "unavailable") return
      // The diagnostic has to say what to do, because the alternative is a
      // reader who concludes the tool is broken.
      expect(outcome.diagnostic).toContain("start OpenCode once")
    })
  })

  test("when the directory is not the package it is named after", () => {
    sandbox(({ repo, config }) => {
      // A directory called `plugin` is not `@opencode-ai/plugin`. Linking it
      // resolves this plugin's imports to something else entirely.
      hostPackage(config, "some-other-package")
      mkdirSync(repo, { recursive: true })

      const outcome = linkHostPackage(repo, config)
      expect(outcome.status).toBe("unavailable")
      if (outcome.status !== "unavailable") return
      expect(outcome.diagnostic).toContain("some-other-package")
    })
  })

  test("when there is no manifest to identify it by", () => {
    sandbox(({ repo, config }) => {
      mkdirSync(join(config, "node_modules", HOST_SCOPE, "plugin"), { recursive: true })
      mkdirSync(repo, { recursive: true })

      const outcome = linkHostPackage(repo, config)
      expect(outcome.status).toBe("unavailable")
      if (outcome.status !== "unavailable") return
      expect(outcome.diagnostic).toContain("package.json")
    })
  })
})
