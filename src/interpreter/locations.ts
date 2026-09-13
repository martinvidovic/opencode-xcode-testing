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
  if (path === undefined) return undefined

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
 */
export function safeDisplayPath(path: string, trustedRoot: string): string {
  const root = trustedRoot.endsWith("/") ? trustedRoot : `${trustedRoot}/`
  if (path.startsWith(root)) return path.slice(root.length)
  return basename(path)
}

function decodeFileUrl(value: string): string | undefined {
  if (!value.startsWith("file://")) return value.length > 0 ? value : undefined
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

function basename(path: string): string {
  const at = path.lastIndexOf("/")
  return at === -1 ? path : path.slice(at + 1)
}

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
