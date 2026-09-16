/**
 * Which OpenCode packages this gate actually compiled and ran against (#81).
 *
 * The report named the host version and stopped there, which is the least
 * informative of the three numbers that matter. The adapter is written against
 * `@opencode-ai/plugin`; the acceptance gates drive a host through
 * `@opencode-ai/sdk`; and both of those are resolved from a package tree the
 * *host* manages under the user's config directory, on its own schedule. A
 * machine can run OpenCode 1.18.29 against plugin 1.15.12 and say nothing
 * about it — which is what this machine was doing.
 *
 * That is not a hypothetical drift. The config manifest pins a range, the
 * install happened once, and upgrading the host does not revisit it. So the
 * evidence a green gate produced was evidence about a package set nobody had
 * named, and "we tested against OpenCode 1.18.29" was true of the host and
 * false of everything the code was linked to.
 *
 * Three questions, kept separate because they have different answers and
 * different remedies:
 *
 * - **What is installed?** The versions in the linked packages themselves.
 * - **Does the tree agree with itself?** A manifest, a lockfile and an
 *   installed package that disagree mean the next install changes what is
 *   being tested, and nobody would know which run was which. The manifest
 *   says what was *asked for*; the lockfile says what was *resolved*; the
 *   installed package says what is *there*. All three can differ, and each
 *   difference means something else went wrong.
 * - **Is that relationship supported?** Stated as a rule rather than assumed,
 *   because "it worked" is not a claim anyone can check later.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { safeFailure } from "../../src/adapter/sanitize.ts"
import { defaultConfigDirectory, HOST_SCOPE } from "../link-host-package.ts"

/** The packages this adapter is written against, and how to say so. */
export const PACKAGES = ["plugin", "sdk"] as const
export type PackageName = (typeof PACKAGES)[number]

export type PackageFacts = {
  /** Whether a package directory is there at all. */
  installed?: boolean
  /** The version in the installed package's own manifest. */
  version?: string
  /** Why it could not be read, when it could not. */
  unavailable?: string
  /** The range the host's config manifest asks for, when it asks for one. */
  requested?: string
  /** The version a lockfile in that directory resolved it to, when one did. */
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
 * What a supported tree looks like.
 *
 * **The two packages ship as a set**, so a tree where they disagree is a tree
 * assembled by hand or interrupted part-way, and neither is something to draw
 * conclusions from.
 *
 * **The major must match the host's.** Across a major, the plugin interface is
 * allowed to change out from under this adapter, and a gate that passed anyway
 * would be proving something about an interface nobody ships.
 *
 * **A trailing minor is a caveat, not a failure.** It is the ordinary state of
 * a host-managed tree — the config manifest pins a range and nothing revisits
 * it on upgrade — and ADR 0002's standing policy for version skew is to
 * surface it rather than block on it. What was missing was the surfacing.
 * Failing here would make the gate unrunnable on a machine whose only problem
 * is that somebody has not re-run an install in a directory this repository
 * does not own.
 */
export function readProvenance(hostVersion: string, configDirectory = defaultConfigDirectory()): Provenance {
  const requested = requestedRanges(configDirectory)
  const locked = lockedVersions(configDirectory)
  const packages = {} as Record<PackageName, PackageFacts>
  const problems: string[] = []
  const caveats: string[] = []

  for (const name of PACKAGES) {
    packages[name] = {
      ...readPackage(configDirectory, name),
      ...ranged(requested, name),
      ...(locked[name] === undefined ? {} : { locked: locked[name] }),
    }

    // A package that is simply not installed is not a disagreement — there is
    // nothing yet for anything to disagree with, and the gates that need one
    // say so themselves, in words about what they were trying to do. A
    // package that *is* there and cannot be read is a different matter: the
    // tree exists and cannot be characterized, so nothing drawn from it can
    // be attributed to a version.
    const { unavailable, installed } = packages[name]
    if (unavailable !== undefined && installed === true) {
      problems.push(`${HOST_SCOPE}/${name}: ${unavailable}`)
    }
  }

  const plugin = packages.plugin.version
  const sdk = packages.sdk.version

  if (plugin !== undefined && sdk !== undefined && plugin !== sdk) {
    problems.push(
      `${HOST_SCOPE}/plugin is ${plugin} and ${HOST_SCOPE}/sdk is ${sdk}; they ship as a set, so a tree where they disagree was assembled by hand or interrupted part-way.`,
    )
  }

  for (const name of PACKAGES) {
    const { version, requested: range, locked: resolved } = packages[name]
    if (version === undefined) continue

    if (range !== undefined && !satisfiesCaret(version, range)) {
      problems.push(
        `${HOST_SCOPE}/${name} is ${version}, which does not satisfy the \`${range}\` its config manifest asks for; the next install in that directory would change what is being tested.`,
      )
    }

    // The manifest says what was asked for; the lock says what was resolved;
    // the package says what is there. A lock that disagrees with the package
    // means somebody installed by hand or an install was interrupted, and the
    // next one silently puts back a different version from the one every
    // report so far was written about.
    if (resolved !== undefined && resolved !== version) {
      problems.push(
        `${HOST_SCOPE}/${name} is ${version} on disk and ${resolved} in the lockfile beside it; the next install in that directory would restore ${resolved}.`,
      )
    }
  }

  const host = majorOf(hostVersion)
  if (host !== undefined && plugin !== undefined) {
    const packageMajor = majorOf(plugin)
    if (packageMajor !== host) {
      problems.push(
        `the host is ${hostVersion} and its packages are ${plugin}; across a major the plugin interface may change, so a gate passing against these proves nothing about the one the host ships.`,
      )
    } else if (plugin !== hostVersion && olderThan(plugin, hostVersion)) {
      caveats.push(
        `the host is ${hostVersion} and its packages are ${plugin}. The config manifest pins a range and upgrading the host does not revisit it, so these were installed once and left. \`bun install\` in the OpenCode config directory refreshes them.`,
      )
    }
  }

  return { packages, problems, caveats }
}

/** What each installed package says about itself. */
function readPackage(configDirectory: string, name: PackageName): PackageFacts {
  const directory = join(configDirectory, "node_modules", HOST_SCOPE, name)
  if (!existsSync(directory)) {
    return { unavailable: "it is not installed under the OpenCode config directory" }
  }

  try {
    const parsed = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name?: unknown
      version?: unknown
    }
    if (parsed.name !== `${HOST_SCOPE}/${name}`) {
      return { installed: true, unavailable: `the package there declares itself \`${String(parsed.name)}\`` }
    }
    if (typeof parsed.version !== "string") {
      return { installed: true, unavailable: "the package there declares no version" }
    }
    return { installed: true, version: parsed.version }
  } catch (error) {
    // Sanitized: a parse error quotes the file, and the file is under the
    // user's home by construction.
    return { installed: true, unavailable: `its manifest could not be read: ${safeFailure(error)}` }
  }
}

/**
 * The ranges the host's own config manifest asks for.
 *
 * Read from the manifest rather than the lockfile. A lockfile records a
 * resolution; the manifest records the intent, and it is intent against
 * installed reality that says whether the next install would move.
 */
function requestedRanges(configDirectory: string): Record<string, string> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(configDirectory, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown> }
    const found: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed.dependencies ?? {})) {
      if (typeof value === "string") found[key] = value
    }
    return found
  } catch {
    // A host that has never installed anything has no manifest, which is not
    // a disagreement — there is nothing yet to disagree with.
    return {}
  }
}

/**
 * What a lockfile in the config directory resolved each package to.
 *
 * Both formats are read because both turn up: OpenCode installs with Bun, and
 * a machine where somebody has run `npm install` in that directory has the
 * other. Neither is this repository's to own, so what they are consulted for
 * is agreement, never authority.
 *
 * `bun.lock` is JSONC — it carries trailing commas, which `JSON.parse`
 * refuses — so its entries are read by pattern rather than parsed. Narrow on
 * purpose: this reads two known keys out of a file somebody else's tool
 * writes, and a tolerant parser for the whole thing would be a much larger
 * claim about a format that is not ours.
 */
function lockedVersions(configDirectory: string): Partial<Record<PackageName, string>> {
  const found: Partial<Record<PackageName, string>> = {}

  const bun = read(join(configDirectory, "bun.lock"))
  if (bun !== undefined) {
    for (const name of PACKAGES) {
      const entry = new RegExp(`"${HOST_SCOPE}/${name}":\\s*\\["${HOST_SCOPE}/${name}@([^"]+)"`).exec(bun)
      if (entry?.[1] !== undefined) found[name] = entry[1]
    }
  }

  const npm = read(join(configDirectory, "package-lock.json"))
  if (npm !== undefined) {
    try {
      const parsed = JSON.parse(npm) as {
        packages?: Record<string, { version?: unknown }>
      }
      for (const name of PACKAGES) {
        const version = parsed.packages?.[`node_modules/${HOST_SCOPE}/${name}`]?.version
        // Bun's answer wins where both exist: it is the one OpenCode writes.
        if (typeof version === "string" && found[name] === undefined) found[name] = version
      }
    } catch {
      // A lockfile nobody can parse says nothing, which is what it said
      // before this function existed.
    }
  }

  return found
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function ranged(requested: Record<string, string>, name: PackageName): PackageFacts {
  const range = requested[`${HOST_SCOPE}/${name}`]
  return range === undefined ? {} : { requested: range }
}

/** `^x.y.z`, as the host's manifest writes it. Anything else is not judged. */
function satisfiesCaret(version: string, range: string): boolean {
  if (!range.startsWith("^")) return true
  const wanted = parse(range.slice(1))
  const found = parse(version)
  if (wanted === undefined || found === undefined) return true
  if (found[0] !== wanted[0]) return false
  return !olderThan(version, range.slice(1))
}

function majorOf(version: string): number | undefined {
  return parse(version)?.[0]
}

function olderThan(version: string, other: string): boolean {
  const a = parse(version)
  const b = parse(other)
  if (a === undefined || b === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left < right
  }
  return false
}

/** The numeric head of a version, ignoring any pre-release suffix. */
function parse(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
