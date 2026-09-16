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

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"

import { observedHostVersion } from "./gate/host.ts"
import { defaultConfigDirectory, HOST_SCOPE } from "./gate/host-tree.ts"
import { readProvenance } from "./gate/provenance.ts"

export { defaultConfigDirectory, HOST_SCOPE } from "./gate/host-tree.ts"

export type LinkOutcome =
  | { status: "linked" | "alreadyLinked"; target: string; link: string }
  | { status: "unavailable"; diagnostic: string }

export function linkHostPackage(repoRoot: string, configDirectory: string): LinkOutcome {
  const target = join(configDirectory, "node_modules", HOST_SCOPE)
  const link = join(repoRoot, "node_modules", HOST_SCOPE)

  const problem = packageProblem(join(target, "plugin"))
  if (problem !== undefined) return { status: "unavailable", diagnostic: problem }

  mkdirSync(join(repoRoot, "node_modules"), { recursive: true })

  if (existsSync(link) || isBrokenLink(link)) {
    if (isBrokenLink(link) || lstatSync(link).isSymbolicLink()) unlinkSync(link)
    else return { status: "alreadyLinked", target, link }
  }

  symlinkSync(target, link)
  return { status: "linked", target, link }
}

/**
 * Why this is not the package we mean to link, or `undefined` if it is.
 *
 * A directory called `plugin` is not the same thing as `@opencode-ai/plugin`.
 * Linking whatever happens to sit at that path would produce the exact failure
 * this script exists to prevent — a plugin whose imports resolve to something
 * unexpected, loading into silence — only now with a reassuring "linked"
 * message in front of it. So the manifest is read and the name is checked.
 */
function packageProblem(path: string): string | undefined {
  const absent = `${HOST_SCOPE}/plugin was not found under the OpenCode config directory. The host installs it on first run, so start OpenCode once and try again.`
  if (!existsSync(path)) return absent

  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"))
  } catch {
    return `${path} has no readable package.json, so it is not the host's ${HOST_SCOPE}/plugin.`
  }

  const name = (manifest as { name?: unknown }).name
  return name === `${HOST_SCOPE}/plugin`
    ? undefined
    : `${path} declares itself \`${String(name)}\`, not ${HOST_SCOPE}/plugin. Linking it would resolve this plugin's imports to something else entirely.`
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

    // What was linked, not merely that something was (issue #81). This is the
    // documented way people set this up, so it is the first moment anyone
    // could be told the tree is stale or disagrees with itself — and being
    // told here is worth more than being told by a gate an hour later.
    //
    // Never fatal. Linking succeeded, and refusing to exit zero over a
    // package tree the user has not been asked to fix yet would make the
    // documented setup step look broken.
    const { packages, problems, caveats } = readProvenance(observedHostVersion(), configDirectory)
    process.stdout.write(
      `linked versions: plugin ${packages.plugin.version ?? "unknown"}, sdk ${packages.sdk.version ?? "unknown"}\n`,
    )
    for (const note of [...problems, ...caveats]) process.stderr.write(`link-host-package: ${note}\n`)
  }
}
