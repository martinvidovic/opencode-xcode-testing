/**
 * The Containment Root, Configuration Root, and project configuration (ADR 0002, #6).
 *
 * The containment root is `context.worktree` when the host supplies one, else
 * `context.directory`, resolved exactly once and **never influenced by a tool
 * argument**. That is the boundary the whole safety story rests on: if a model
 * could move the root, every path guarantee beneath it would be decorative.
 *
 * The configuration root is tracked separately so configuration-relative
 * behavior cannot be confused with containment. For root-level sessions it is
 * currently the containment root; bounded module discovery is issue #137.
 */

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { DERIVED_DATA_MODES, type ProjectConfiguration } from "../domain/request.ts"
import { MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS } from "../domain/limits.ts"
import { isRecord, oneOf } from "../domain/json.ts"
import { canonicalizeContainmentRoot } from "../runner/paths.ts"

export const CONFIG_DIRECTORY = ".opencode"
export const CONFIG_FILENAME = "xcode-test.json"

export type PluginContext = { worktree?: string; directory: string }

export type RootRolesResolution =
  | { status: "resolved"; containmentRoot: string; configurationRoot: string }
  | { status: "failed"; message: string }

/**
 * Canonicalization failure is a hard resolution error, not a fallback: a root
 * we cannot resolve is a root we cannot make any promise about.
 */
export function resolveRootRoles(context: PluginContext): RootRolesResolution {
  const candidate = usableWorktree(context.worktree) ?? context.directory
  try {
    const containmentRoot = canonicalizeContainmentRoot(candidate)
    return { status: "resolved", containmentRoot, configurationRoot: containmentRoot }
  } catch {
    return {
      status: "failed",
      message: "the containment root could not be resolved to a real directory",
    }
  }
}

/**
 * A host that finds no git worktree does not omit the field — it reports the
 * filesystem root, or an empty string. Taking either at face value would make
 * `/` the containment root, which silently disables the plugin in every non-git
 * project and, worse, would key artifact storage and container discovery to the
 * whole filesystem.
 */
function usableWorktree(worktree: string | undefined): string | undefined {
  const trimmed = worktree?.trim()
  if (trimmed === undefined || trimmed.length === 0 || trimmed === "/") return undefined
  return trimmed
}

export function configurationPath(configurationRoot: string): string {
  return join(configurationRoot, CONFIG_DIRECTORY, CONFIG_FILENAME)
}

/** The file's presence is the per-project enablement marker (ADR 0002). */
export function enablementMarkerExists(configurationRoot: string): boolean {
  try {
    return statSync(configurationPath(configurationRoot)).isFile()
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
export function readProjectConfiguration(configurationRoot: string): ConfigurationResult {
  const path = configurationPath(configurationRoot)

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

  const wrong = fieldProblems(record)
  if (wrong.length > 0) {
    return {
      status: "invalid",
      message: `the project configuration has invalid fields: ${wrong.join("; ")}`,
    }
  }

  // Every field has now been checked against the contract, so this is a
  // narrowing rather than an assertion about something unexamined.
  return { status: "loaded", configuration: record as ProjectConfiguration }
}

/**
 * What is wrong with each field that is present, in the order they are listed.
 *
 * Checking the *names* and then trusting the values is the same mistake as not
 * checking at all, one level down: `"timeoutSeconds": "soon"` has a known key
 * and becomes an effective setting, and a configuration that is wrong in a way
 * nobody is told about is how a project ends up testing something other than
 * what it says. Every problem is reported at once rather than the first, so a
 * reader fixes the file once.
 */
function fieldProblems(record: Record<string, unknown>): string[] {
  const problems: string[] = []
  const check = (field: string, wrong: (value: unknown) => string | undefined) => {
    const value = record[field]
    if (value === undefined) return
    const problem = wrong(value)
    if (problem !== undefined) problems.push(`${field} ${problem}`)
  }

  check("xcodeContainer", containerProblem)
  check("scheme", (value) => nonEmptyStringProblem(value))
  check("destination", destinationProblem)
  check("derivedData", derivedDataProblem)
  check("timeoutSeconds", timeoutProblem)
  // Machine-local, and relative resolves against the configuration root — so the
  // only thing that can be said here is that it is a path-shaped string.
  check("runtime", (value) => nonEmptyStringProblem(value))

  return problems
}

function containerProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object"
  const extra = unknownKeys(value, ["kind", "path"])
  if (extra !== undefined) return extra
  if (!oneOf(value["kind"], CONTAINER_KINDS)) {
    return `must have kind ${CONTAINER_KINDS.join(" or ")}`
  }
  const path = nonEmptyStringProblem(value["path"])
  return path === undefined ? undefined : `path ${path}`
}

const CONTAINER_KINDS = ["workspace", "project"] as const

/**
 * Unknown keys are refused inside nested objects for the same reason as at the
 * top level: a typo'd key that silently does nothing is how a project ends up
 * testing something other than what its configuration says, and nesting does
 * not make that less true.
 */
function unknownKeys(value: Record<string, unknown>, known: readonly string[]): string | undefined {
  const extra = Object.keys(value)
    .filter((key) => !known.includes(key))
    .sort()
  return extra.length === 0 ? undefined : `has unknown fields: ${extra.join(", ")}`
}

function destinationProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object"

  if (value["kind"] === "id") {
    const extra = unknownKeys(value, ["kind", "id"])
    if (extra !== undefined) return extra
    const id = nonEmptyStringProblem(value["id"])
    return id === undefined ? undefined : `id ${id}`
  }
  if (value["kind"] === "named") {
    const extra = unknownKeys(value, ["kind", "platform", "name", "os"])
    if (extra !== undefined) return extra

    for (const field of ["platform", "name"]) {
      const problem = nonEmptyStringProblem(value[field])
      if (problem !== undefined) return `${field} ${problem}`
    }
    // `os` narrows a named destination and is optional; present and wrong is
    // still wrong.
    const os = value["os"]
    if (os !== undefined && nonEmptyStringProblem(os) !== undefined) {
      return "os must be a non-empty string"
    }
    return undefined
  }

  return "must have kind `id` or `named`"
}

function derivedDataProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object"
  const extra = unknownKeys(value, ["mode"])
  if (extra !== undefined) return extra
  return oneOf(value["mode"], DERIVED_DATA_MODES)
    ? undefined
    : `mode must be one of ${DERIVED_DATA_MODES.join(", ")}`
}

function timeoutProblem(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return "must be a whole number"
  return value >= MIN_TIMEOUT_SECONDS && value <= MAX_TIMEOUT_SECONDS
    ? undefined
    : `must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`
}

function nonEmptyStringProblem(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? undefined : "must be a non-empty string"
}
