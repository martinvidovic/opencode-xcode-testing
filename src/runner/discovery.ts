/**
 * Container and scheme discovery (#6).
 *
 * Discovery is deliberately conservative. It answers "found", "ambiguous" or
 * "none" and never guesses between candidates: picking one of two workspaces
 * for the caller would mean silently testing the wrong app, and a structured
 * ambiguity the caller can resolve is strictly better than a coin flip.
 *
 * Symlinked directories are not followed. A repository that links to a sibling
 * checkout would otherwise let discovery wander outside the trusted root.
 */

import { lstatSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

import { DISCOVERY_EXCLUDED_DIRECTORIES, type XcodeContainer } from "../domain/request.ts"

export type DiscoveryOutcome<T> =
  | { status: "found"; value: T }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" }

const EXCLUDED = new Set<string>(DISCOVERY_EXCLUDED_DIRECTORIES)

/**
 * Workspaces win outright. Projects are considered only when no workspace was
 * found anywhere, because a project inside a workspace is a component of it,
 * not an alternative to it.
 */
export function discoverContainer(trustedRoot: string): DiscoveryOutcome<XcodeContainer> {
  const found = scan(trustedRoot)

  if (found.workspaces.length === 1) {
    return { status: "found", value: { kind: "workspace", path: found.workspaces[0] as string } }
  }
  if (found.workspaces.length > 1) return { status: "ambiguous", candidates: found.workspaces }

  if (found.projects.length === 1) {
    return { status: "found", value: { kind: "project", path: found.projects[0] as string } }
  }
  if (found.projects.length > 1) return { status: "ambiguous", candidates: found.projects }

  return { status: "none" }
}

export type ContainerScan = { workspaces: string[]; projects: string[] }

/** Walk the trusted root once, collecting both container kinds. */
export function scan(trustedRoot: string): ContainerScan {
  const workspaces: string[] = []
  const projects: string[] = []

  const walk = (directory: string) => {
    let entries: string[]
    try {
      entries = readdirSync(directory).sort()
    } catch {
      return
    }

    for (const entry of entries) {
      const path = join(directory, entry)
      const stats = safeLstat(path)
      // Not following a symlinked directory is what keeps discovery inside the
      // trusted root; a linked vendor checkout is not this repository's project.
      if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) continue

      if (entry.endsWith(".xcworkspace")) {
        workspaces.push(relative(trustedRoot, path))
        continue
      }
      if (entry.endsWith(".xcodeproj")) {
        projects.push(relative(trustedRoot, path))
        continue
      }
      if (entry.startsWith(".") || EXCLUDED.has(entry)) continue

      walk(path)
    }
  }

  walk(trustedRoot)
  return { workspaces: workspaces.sort(), projects: projects.sort() }
}

/**
 * Only checked-in shared schemes are discoverable. A user-specific scheme under
 * `xcuserdata` exists on one machine and would make discovery depend on whose
 * laptop it ran on; an explicitly requested or configured scheme may still name
 * anything `xcodebuild` can see.
 */
export function discoverScheme(
  trustedRoot: string,
  container: XcodeContainer,
): DiscoveryOutcome<string> {
  const searched = [join(trustedRoot, container.path)]

  // A workspace's schemes usually live in the projects it wraps, so those count
  // too — but only the shared ones, and only inside the trusted root.
  if (container.kind === "workspace") {
    for (const project of scan(trustedRoot).projects) searched.push(join(trustedRoot, project))
  }

  const schemes = new Set<string>()
  for (const base of searched) {
    for (const scheme of sharedSchemesIn(base)) schemes.add(scheme)
  }

  const candidates = [...schemes].sort()
  if (candidates.length === 1) return { status: "found", value: candidates[0] as string }
  if (candidates.length > 1) return { status: "ambiguous", candidates }
  return { status: "none" }
}

export function sharedSchemesIn(containerPath: string): string[] {
  const directory = join(containerPath, "xcshareddata", "xcschemes")
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith(".xcscheme"))
      .map((entry) => entry.slice(0, -".xcscheme".length))
      .sort()
  } catch {
    return []
  }
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}
