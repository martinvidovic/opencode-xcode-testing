/**
 * Turning Xcode's source references into locations that are safe to show a
 * model (#7).
 *
 * Repository-contained paths become repository-relative. Everything else is
 * reduced to a display name: an absolute path outside the repository tells the
 * model nothing it can use and leaks the shape of the machine it ran on.
 */

import type { SafeLocation } from "../domain/inspection.ts"

/**
 * Parse Xcode's `file://…#…StartingLineNumber=…` source reference into a safe
 * location. Returns `undefined` when there is nothing trustworthy to report.
 */
export function safeLocationFromSourceURL(
  sourceURL: string | undefined,
  trustedRoot: string,
): SafeLocation | undefined {
  if (sourceURL === undefined) return undefined

  const [pathPart, fragment] = splitOnce(sourceURL, "#")
  const path = decodeFileUrl(pathPart)
  if (path === undefined || path.length === 0) return undefined

  const line = fragmentNumber(fragment, "StartingLineNumber")
  const column = fragmentNumber(fragment, "StartingColumnNumber")

  return {
    path: safeDisplayPath(path, trustedRoot),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  }
}

/**
 * A repository-contained path, relative to the trusted root; otherwise the
 * basename alone. Xcode line numbers are 1-based and passed through as given.
 *
 * Starting with the root is not the same as being inside it. A path like
 * `<root>/../../etc/passwd` passes a prefix test and then reads, once the
 * prefix is stripped, as a repository-relative path that walks straight out of
 * the repository — so the remainder is checked for traversal, and anything
 * that leaves is reduced to a display name like any other outside path.
 */
export function safeDisplayPath(path: string, trustedRoot: string): string {
  const root = trustedRoot.endsWith("/") ? trustedRoot : `${trustedRoot}/`
  if (!path.startsWith(root)) return basename(path)

  const relative = path.slice(root.length)
  return staysInside(relative) ? relative : basename(path)
}

/** Purely lexical, and deliberately so: this is about what is *displayed*. */
function staysInside(relative: string): boolean {
  if (relative.startsWith("/")) return false

  let depth = 0
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue
    if (part !== "..") {
      depth += 1
      continue
    }
    depth -= 1
    if (depth < 0) return false
  }
  return true
}

function decodeFileUrl(value: string): string | undefined {
  if (!value.startsWith("file://")) return value
  try {
    return decodeURIComponent(value.slice("file://".length))
  } catch {
    return undefined
  }
}

function fragmentNumber(fragment: string | undefined, key: string): number | undefined {
  if (fragment === undefined) return undefined
  for (const pair of fragment.split("&")) {
    const [name, raw] = splitOnce(pair, "=")
    if (name !== key || raw === undefined) continue
    const parsed = Number.parseInt(raw, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator)
  if (at === -1) return [value, undefined]
  return [value.slice(0, at), value.slice(at + separator.length)]
}

/**
 * The last component that is actually a name.
 *
 * `.` and `..` are navigation, not names: returning one as a "display name"
 * would put a traversal marker in front of a model as though it were a file,
 * which is the thing this module exists to prevent.
 */
function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== "." && part !== "..")
  return parts[parts.length - 1] ?? UNNAMED
}

/** Shown when a path has no nameable component at all. */
const UNNAMED = "(unnamed source)"

/** Deterministic ordering key for a location: path, then line, then column. */
export function compareLocations(
  a: SafeLocation | undefined,
  b: SafeLocation | undefined,
): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0)
  return (a.column ?? 0) - (b.column ?? 0)
}
