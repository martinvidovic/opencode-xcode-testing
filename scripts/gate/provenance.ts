/**
 * Which OpenCode packages this gate actually compiled and ran against (issues
 * #81, #142).
 *
 * The report once named the host version and stopped, which is the least
 * informative of the numbers that matter. The adapter is written against
 * `@opencode/plugin` and the acceptance gates drive a host through
 * `@opencode/client` — and on V2 both are **this checkout's own**: pinned
 * exactly in `package.json` and installed with `bun install` (issue #140). The
 * V1 model, where the host installed the packages under the user's config
 * directory on its own schedule and the checkout only symlinked them, is gone.
 *
 * Three questions, kept separate because they have different answers and
 * different remedies:
 *
 * - **What is installed?** The versions in the checkout's `node_modules`.
 * - **Does the checkout agree with itself?** The manifest says what was
 *   *pinned*, the lockfile what was *resolved*, the installed package what is
 *   *there*. Any disagreement means the next install changes what is being
 *   tested, and nobody would know which run was which.
 * - **Is the host the one the packages were validated against?** A different
 *   major is a problem: the plugin interface may change across it. A different
 *   minor or patch is a caveat — the standing policy is to surface skew, never
 *   to block on it.
 *
 * Deliberately absent: the V1 rule that the packages share one version. That
 * was a fact about a host-managed tree, and nothing about V2 requires it.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { safeFailure } from "../../src/adapter/sanitize.ts"

const REPO = join(import.meta.dir, "..", "..")
const SCOPE = "@opencode"

/** The packages this checkout is written against. */
export const PACKAGES = ["plugin", "client"] as const
export type PackageName = (typeof PACKAGES)[number]

export type PackageFacts = {
  /** Whether a package directory is there at all. */
  installed?: boolean
  /** The version in the installed package's own manifest. */
  version?: string
  /** Why it could not be read, when it could not. */
  unavailable?: string
  /** The exact version the checkout's `package.json` pins. */
  requested?: string
  /** The version the checkout's `bun.lock` resolved it to. */
  locked?: string
}

export type Provenance = {
  packages: Record<PackageName, PackageFacts>
  /** Problems that make the tested package set unknowable. Empty is good. */
  problems: string[]
  /** Skew that is known, supported, and worth saying out loud anyway. */
  caveats: string[]
}

/**
 * Why a gate cannot start, if a package it needs is not installed.
 *
 * Asked before anything boots, and answered with the command that fixes it:
 * a missing prerequisite fails explicitly rather than skipping a scenario.
 */
export function missingPackages(repoRoot = REPO): string | undefined {
  const missing = PACKAGES.filter((name) => !existsSync(join(repoRoot, "node_modules", SCOPE, name)))
  if (missing.length === 0) return undefined
  return `${missing.map((name) => `${SCOPE}/${name}`).join(" and ")} ${missing.length === 1 ? "is" : "are"} not installed in this checkout. Run \`bun install\`.`
}

export function readProvenance(hostVersion: string, repoRoot = REPO): Provenance {
  const pinned = pinnedVersions(repoRoot)
  const locked = lockedVersions(repoRoot)
  const packages = {} as Record<PackageName, PackageFacts>
  const problems: string[] = []
  const caveats: string[] = []

  for (const name of PACKAGES) {
    const facts: PackageFacts = {
      ...readPackage(repoRoot, name),
      ...(pinned[name] === undefined ? {} : { requested: pinned[name] }),
      ...(locked[name] === undefined ? {} : { locked: locked[name] }),
    }
    packages[name] = facts

    // A package that is simply not installed is not a disagreement; the gates
    // that need one say so through `missingPackages`. One that is there and
    // cannot be read is: nothing drawn from it can be attributed to a version.
    if (facts.unavailable !== undefined && facts.installed === true) {
      problems.push(`${SCOPE}/${name}: ${facts.unavailable}`)
    }

    const { version, requested, locked: resolved } = facts
    if (version === undefined) continue

    if (requested !== undefined && version !== requested) {
      problems.push(
        `${SCOPE}/${name} is ${version}, but this checkout pins ${requested}. Run \`bun install\` so the run is against what the checkout says it is.`,
      )
    }
    if (resolved !== undefined && resolved !== version) {
      problems.push(
        `${SCOPE}/${name} is ${version} on disk and ${resolved} in the checkout's lockfile; the next install would restore ${resolved}.`,
      )
    }
  }

  const plugin = packages.plugin.version
  const host = parse(hostVersion)

  if (host === undefined && plugin !== undefined) {
    // Said rather than skipped: a host whose version cannot be read must not
    // quietly stop the one rule that catches an incompatible package set.
    caveats.push(
      `the host version is \`${hostVersion}\`, which cannot be compared against the packages (${plugin}); the major-version rule was not applied.`,
    )
  }

  // The client is held to the same major as the host as the plugin is: the
  // gates drive the host through it, and its routes may change across a major
  // just as the plugin interface may.
  for (const name of PACKAGES) {
    const version = packages[name].version
    const parsed = version === undefined ? undefined : parse(version)
    if (host !== undefined && parsed !== undefined && host[0] !== parsed[0]) {
      problems.push(
        `the host is ${render(host)} and ${SCOPE}/${name} is ${version}; across a major the interface may change, so a gate passing against these proves nothing about the one the host ships.`,
      )
    }
  }

  const packageVersion = plugin === undefined ? undefined : parse(plugin)
  if (host !== undefined && plugin !== undefined && packageVersion !== undefined && host[0] === packageVersion[0]) {
    if (render(host) !== render(packageVersion)) {
      caveats.push(
        `the host is ${render(host)} and the packages are pinned to ${plugin}. The Test Tool is validated against exactly ${plugin}; this run is evidence about ${render(host)}, not a widening of that claim.`,
      )
    }
  }

  return { packages, problems, caveats }
}

/** What each installed package says about itself. */
function readPackage(repoRoot: string, name: PackageName): PackageFacts {
  const directory = join(repoRoot, "node_modules", SCOPE, name)
  if (!existsSync(directory)) return { unavailable: "it is not installed in this checkout" }

  try {
    const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name?: unknown
      version?: unknown
    }
    if (parsed.name !== `${SCOPE}/${name}`) {
      // Quoted back, and therefore redacted first: it lands in a report.
      return { installed: true, unavailable: `the package there declares itself \`${redact(parsed.name)}\`` }
    }
    if (typeof parsed.version !== "string") {
      return { installed: true, unavailable: "the package there declares no version" }
    }
    return { installed: true, version: parsed.version }
  } catch (error) {
    return { installed: true, unavailable: `its manifest could not be read: ${safeFailure(error)}` }
  }
}

/** The exact versions the checkout pins. */
function pinnedVersions(repoRoot: string): Partial<Record<PackageName, string>> {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, unknown>
      dependencies?: Record<string, unknown>
    }
    const declared = { ...parsed.dependencies, ...parsed.devDependencies }
    const found: Partial<Record<PackageName, string>> = {}
    for (const name of PACKAGES) {
      const value = declared[`${SCOPE}/${name}`]
      if (typeof value === "string") found[name] = value
    }
    return found
  } catch {
    return {}
  }
}

/**
 * What the checkout's `bun.lock` resolved each package to.
 *
 * `bun.lock` is JSONC — it carries trailing commas, which `JSON.parse`
 * refuses — so its entries are read by pattern rather than parsed.
 */
function lockedVersions(repoRoot: string): Partial<Record<PackageName, string>> {
  const found: Partial<Record<PackageName, string>> = {}
  let text: string
  try {
    text = readFileSync(join(repoRoot, "bun.lock"), "utf8")
  } catch {
    return found
  }
  for (const name of PACKAGES) {
    const entry = new RegExp(`"${SCOPE}/${name}":\\s*\\["${SCOPE}/${name}@([^"]+)"`).exec(text)
    if (entry?.[1] !== undefined) found[name] = entry[1]
  }
  return found
}

/**
 * A value from somebody else's manifest, safe to quote back: paths and private
 * identifiers out, first line only, bounded.
 */
function redact(value: unknown): string {
  return safeFailure(new Error(String(value))).replace(/^Error: /, "").slice(0, NAME_CHAR_CAP)
}

/** Longer than a package name by a wide margin, and still a name. */
const NAME_CHAR_CAP = 100

/**
 * The numeric head of a version, ignoring any prefix or pre-release suffix.
 * `opencode --version` answers `opencode v2.0.25`, and that is the same
 * version as `2.0.25`.
 */
function parse(version: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function render(version: [number, number, number]): string {
  return version.join(".")
}
