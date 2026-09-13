#!/usr/bin/env bun
/**
 * Make the host's own `@opencode-ai/plugin` resolvable from this checkout.
 *
 * A source-loaded plugin resolves its imports from its **own** location, not
 * from OpenCode's config directory — so a checkout with no `node_modules` fails
 * to load, and the host swallows the module-load error, leaving the plugin
 * silently registering nothing. That failure mode is invisible from the outside,
 * which is exactly why this is a scripted step rather than a sentence in a
 * README that people skim.
 *
 * This creates a symlink rather than installing a dependency: the package is
 * host-provided at runtime, and the repository commits no manifest for it.
 *
 * Usage: bun scripts/link-host-package.ts [--config <dir>]
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const HOST_SCOPE = "@opencode-ai"

export function defaultConfigDirectory(home = homedir()): string {
  return join(home, ".config", "opencode")
}

export type LinkOutcome =
  | { status: "linked" | "alreadyLinked"; target: string; link: string }
  | { status: "unavailable"; diagnostic: string }

export function linkHostPackage(repoRoot: string, configDirectory: string): LinkOutcome {
  const target = join(configDirectory, "node_modules", HOST_SCOPE)
  const link = join(repoRoot, "node_modules", HOST_SCOPE)

  if (!existsSync(join(target, "plugin"))) {
    return {
      status: "unavailable",
      diagnostic: `${HOST_SCOPE}/plugin was not found under the OpenCode config directory. The host installs it on first run, so start OpenCode once and try again.`,
    }
  }

  mkdirSync(join(repoRoot, "node_modules"), { recursive: true })

  if (existsSync(link) || isBrokenLink(link)) {
    if (isBrokenLink(link) || lstatSync(link).isSymbolicLink()) unlinkSync(link)
    else return { status: "alreadyLinked", target, link }
  }

  symlinkSync(target, link)
  return { status: "linked", target, link }
}

function isBrokenLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path)
  } catch {
    return false
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--config")
  const configDirectory = at === -1 ? defaultConfigDirectory() : (argv[at + 1] ?? defaultConfigDirectory())

  const outcome = linkHostPackage(join(import.meta.dir, ".."), configDirectory)
  if (outcome.status === "unavailable") {
    process.stderr.write(`link-host-package: ${outcome.diagnostic}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`${outcome.status === "linked" ? "linked" : "already linked"}: ${outcome.link}\n`)
  }
}
