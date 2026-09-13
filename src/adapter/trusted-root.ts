/**
 * The trusted root and the project configuration (ADR 0002, #6).
 *
 * The trusted root is `context.worktree` when the host supplies one, else
 * `context.directory`, resolved exactly once and **never influenced by a tool
 * argument**. That is the boundary the whole safety story rests on: if a model
 * could move the root, every path guarantee beneath it would be decorative.
 *
 * Configuration lookup is exactly `<trusted-root>/.opencode/xcode-test.json`
 * with no upward search — a search would let a file two directories up quietly
 * decide what a project tests.
 */

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { ProjectConfiguration } from "../domain/request.ts"
import { canonicalizeTrustedRoot } from "../runner/paths.ts"

export const CONFIG_DIRECTORY = ".opencode"
export const CONFIG_FILENAME = "xcode-test.json"

export type PluginContext = { worktree?: string; directory: string }

export type TrustedRootResolution =
  | { status: "resolved"; trustedRoot: string }
  | { status: "failed"; message: string }

/**
 * Canonicalization failure is a hard resolution error, not a fallback: a root
 * we cannot resolve is a root we cannot make any promise about.
 */
export function resolveTrustedRoot(context: PluginContext): TrustedRootResolution {
  const candidate = context.worktree ?? context.directory
  try {
    return { status: "resolved", trustedRoot: canonicalizeTrustedRoot(candidate) }
  } catch {
    return { status: "failed", message: "the trusted root could not be resolved to a real directory" }
  }
}

export function configurationPath(trustedRoot: string): string {
  return join(trustedRoot, CONFIG_DIRECTORY, CONFIG_FILENAME)
}

/** The file's presence is the per-project enablement marker (ADR 0002). */
export function enablementMarkerExists(trustedRoot: string): boolean {
  try {
    return statSync(configurationPath(trustedRoot)).isFile()
  } catch {
    return false
  }
}

export type ConfigurationResult =
  | { status: "absent" }
  | { status: "loaded"; configuration: ProjectConfiguration }
  | { status: "invalid"; message: string }

const KNOWN_FIELDS = new Set([
  "schemaVersion",
  "xcodeContainer",
  "scheme",
  "destination",
  "derivedData",
  "timeoutSeconds",
  "runtime",
])

/**
 * A present but invalid configuration is never ignored. Malformed JSON, an
 * unsupported schema version and an unknown field are all hard errors — a
 * typo'd key that silently does nothing is how a project ends up testing
 * something other than what its configuration says.
 */
export function readProjectConfiguration(trustedRoot: string): ConfigurationResult {
  const path = configurationPath(trustedRoot)

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return { status: "absent" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: "invalid", message: "the project configuration is not valid JSON" }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", message: "the project configuration is not an object" }
  }

  const record = parsed as Record<string, unknown>
  if (record["schemaVersion"] !== 1) {
    return {
      status: "invalid",
      message: "the project configuration declares an unsupported schemaVersion",
    }
  }

  const unknown = Object.keys(record).filter((key) => !KNOWN_FIELDS.has(key))
  if (unknown.length > 0) {
    return {
      status: "invalid",
      message: `the project configuration has unknown fields: ${unknown.sort().join(", ")}`,
    }
  }

  return { status: "loaded", configuration: record as unknown as ProjectConfiguration }
}
