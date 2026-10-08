/**
 * Plugin setup, with no host in it (issue #141).
 *
 * `plugin.ts` hands this the three host handles it needs — the Location, the
 * host version and the plugin options — as plain data, and registers whatever
 * comes back. Every decision about whether this Location gets a Test Tool at
 * all is made here, so the adapter test layer can drive it with nothing
 * installed.
 *
 * Verified host facts (issue #140) this is built around:
 *
 * - `setup` runs once per Location, in the background, and that Location's
 *   prompts wait for it. Startup work stays bounded by `runStartup`.
 * - A throw from `setup` marks the plugin `failed` with its full stack —
 *   private paths included — readable by any client that lists plugins. So
 *   nothing here throws: every failure is contained and reported on stderr,
 *   sanitized.
 * - No marker is a normal state, not a diagnostic. A global install loads in
 *   every Location the host opens, including a home directory.
 */

import { lstatSync, statfsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { monotonicNow } from "../domain/clock.ts"
import { storageFor, type Storage } from "../runner/paths.ts"
import type { ConfigurationOutcome } from "../runner/resolution.ts"
import { loadCursorSecret } from "../runner/secrets.ts"
import { resolveToolchain } from "../runner/toolchain.ts"
import { outputLimitsFromOptions, resolveBudget } from "./budget.ts"
import { toolDefinitions, type ToolDefinition } from "./definitions.ts"
import { DESCRIPTION_FILES } from "./descriptions.ts"
import { readProjectConfiguration, resolveRootRoles, rootContextFromLocation, type HostLocation } from "./root-roles.ts"
import type { RuntimeResolution } from "./runtime.ts"
import { safeFailure } from "./sanitize.ts"
import { createTestToolService, unavailableService } from "./service.ts"
import { startupPortsFor } from "./startup-ports.ts"
import { hostVersionDiagnostic, runStartup } from "./startup.ts"
import type { ToolDeps } from "./tools.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
export const SUPERVISOR_ENTRYPOINT = join(HERE, "..", "runner", "supervisor-entry.ts")

/** What `setup` reads off the host context. */
export type HostHandles = {
  location: HostLocation
  /** `ctx.app.version`. */
  version: string
  /** `ctx.options`: whatever the user wrote beside the plugin entry. */
  options: Readonly<Record<string, unknown>>
}

/** Seams for the test layer. Production passes none. */
export type SetupOverrides = {
  homeDir?: string
  requiredFiles?(): string[]
  /** One diagnostic line, already prefixed. Defaults to stderr. */
  write?(line: string): void
}

/**
 * The tool definitions this Location should register: three, or none.
 *
 * Never throws (see above). A failure it did not anticipate is reported
 * without its detail's private paths, and registers nothing — registering
 * tools that cannot work is worse than registering none.
 */
export async function prepareTools(host: HostHandles, overrides: SetupOverrides = {}): Promise<ToolDefinition[]> {
  const write = overrides.write ?? ((line: string) => void process.stderr.write(`${line}\n`))
  const say = (message: string) => write(`xcode-test: ${message}`)

  try {
    return await prepare(host, overrides, say)
  } catch (error) {
    say(`setup failed and registered no tools: ${safeFailure(error)}`)
    return []
  }
}

async function prepare(
  host: HostHandles,
  overrides: SetupOverrides,
  say: (message: string) => void,
): Promise<ToolDefinition[]> {
  const roots = resolveRootRoles(rootContextFromLocation(host.location))
  if (roots.status !== "resolved") return []

  const { containmentRoot, configurationRoot } = roots
  const homeDir = overrides.homeDir ?? homedir()
  const storage = storageFor(homeDir, containmentRoot, configurationRoot)

  let runtime: RuntimeResolution | undefined
  const configuration: ConfigurationOutcome =
    configurationRoot === undefined ? { status: "absent" } : readProjectConfiguration(configurationRoot)

  const outcome = await runStartup(
    startupPortsFor({
      ...(configurationRoot === undefined ? {} : { configurationRoot }),
      homeDir,
      storage,
      configuration,
      requiredFiles: overrides.requiredFiles ?? (() => [SUPERVISOR_ENTRYPOINT, ...DESCRIPTION_FILES]),
      regularFileExists: isRegularFile,
      readHostVersion: async () => host.version,
      onRuntime: (resolved) => {
        runtime = resolved
      },
    }),
  )

  if (outcome.status === "disabled") return []
  if (outcome.status === "structuralFailure") {
    say(outcome.diagnostic)
    return []
  }

  const skew = hostVersionDiagnostic(outcome.hostVersion)
  if (skew !== undefined) say(skew)

  // Announced, once per plugin instance (issue #82). A conservative guess
  // nobody is told about is still a guess: the adapter's invariant is that host
  // truncation is unreachable, and with limits it cannot read it can only keep
  // that under a floor it chose for itself.
  const limits = outputLimitsFromOptions(host.options)
  if (limits.status === "unreadable") {
    say(
      `the plugin option \`tool_output\` could not be read (${limits.detail}), so responses are held to a conservative floor. If your host \`tool_output\` limits are lower than that, they may still be exceeded.`,
    )
  }
  const budget = resolveBudget(limits)

  const service = serviceFor(
    {
      storage,
      containmentRoot,
      homeDir,
      configuration,
      toolchain: resolveToolchain(),
      runtime,
      hostVersion: outcome.hostVersion,
    },
    say,
  )

  const deps: ToolDeps = {
    service,
    budget: async () => budget,
    now: monotonicNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timestamp: () => new Date().toISOString(),
  }

  return toolDefinitions(deps)
}

/**
 * Free bytes on the artifact volume. A runtime without `statfs` reports
 * "enough" rather than blocking every run on a check it cannot perform — the
 * minimum-free-space rule is a guard against a full disk, not a gate.
 */
function freeBytesOn(path: string): () => number {
  return () => {
    try {
      const stats = statfsSync(path)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  }
}

/**
 * The runtime failure, naming the candidates behind it.
 *
 * `resolveRuntime` records every path it tried precisely so the reader does
 * not have to guess which Bun the tool was looking at; dropping that list
 * leaves "no usable Bun runtime was found" unanswerable.
 */
function runtimeDiagnostic(failure: Extract<RuntimeResolution, { status: "failed" }>): string {
  if (failure.probed.length === 0) return failure.message
  return `${failure.message} Probed: ${failure.probed.join(", ")}.`
}

/**
 * A readable regular file, not merely something at that path. A directory or a
 * dangling symlink where the supervisor entrypoint should be is a broken
 * checkout, and registering tools against it would fail confusingly later.
 */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The service, or one that explains why there isn't one.
 *
 * Written as guard clauses so the discriminated unions narrow on their own —
 * a ternary over three outcomes throws away the narrowing and pays for it in
 * assertions.
 */
function serviceFor(
  input: {
    storage: Storage
    containmentRoot: string
    homeDir: string
    configuration: ConfigurationOutcome
    toolchain: ReturnType<typeof resolveToolchain>
    runtime: RuntimeResolution | undefined
    hostVersion: string
  },
  say: (message: string) => void,
) {
  const refuse = (message: string) => {
    say(message)
    return unavailableService(message)
  }

  if (input.toolchain.status !== "resolved") return refuse(input.toolchain.message)
  if (input.runtime === undefined) {
    return refuse("the runtime could not be probed within the startup deadline")
  }
  if (input.runtime.status !== "resolved") return refuse(runtimeDiagnostic(input.runtime))

  return createTestToolService({
    storage: input.storage,
    containmentRoot: input.containmentRoot,
    homeDir: input.homeDir,
    configuration: input.configuration,
    toolchain: input.toolchain.identity,
    runtime: {
      path: input.runtime.path,
      ...(input.runtime.version === undefined ? {} : { version: input.runtime.version }),
      hostVersion: input.hostVersion,
    },
    supervisorEntrypoint: SUPERVISOR_ENTRYPOINT,
    now: monotonicNow,
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes: freeBytesOn(input.storage.toolRoot),
    cursorSecret: loadCursorSecret(input.storage),
  })
}
