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

import { monotonicNow } from "../domain/clock.ts"
import { storageFor, type Storage } from "../runner/paths.ts"
import type { ConfigurationOutcome } from "../runner/resolution.ts"
import { loadCursorSecret } from "../runner/secrets.ts"
import type { ToolchainIdentity } from "../domain/toolchain.ts"
import { isSupportedXcodeVersion, SUPPORTED_XCODE_MAJORS } from "../interpreter/schema.ts"
import { SELECTIONS, type ToolchainProbe, type ToolchainResolution } from "../runner/toolchain.ts"
import { outputLimitsFromOptions, resolveBudget } from "./budget.ts"
import { toolDefinitions, type ToolDefinition } from "./definitions.ts"
import { DESCRIPTION_FILES } from "./descriptions.ts"
import { readProjectConfiguration, resolveRootRoles, rootContextFromLocation, type HostLocation } from "./root-roles.ts"
import type { RuntimeProbe, RuntimeResolution } from "./runtime.ts"
import { safeFailure } from "./sanitize.ts"
import { describeUnavailable, revalidatingService, type Availability, type Unavailable } from "./availability.ts"
import { createTestToolService } from "./service.ts"
import { HOUSEKEEPING_ENTRYPOINT, SUPERVISOR_ENTRYPOINT } from "./entrypoints.ts"
import { startupPortsFor } from "./startup-ports.ts"
import { hostVersionDiagnostic, probeAgain, runStartup, type ProbeResults } from "./startup.ts"
import type { ToolDeps } from "./tools.ts"


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
  /** How toolchain discovery probes. Defaults to spawning the real tools. */
  toolchainProbe?: ToolchainProbe
  /** Where an inherited `DEVELOPER_DIR` is read from. Defaults to this process's environment. */
  environment?: Readonly<Record<string, string | undefined>>
  /** How a runtime candidate is probed. Defaults to running a real script. */
  runtimeProbe?: RuntimeProbe
  /** The startup ceiling. Defaults to `STARTUP_DEADLINE_MS`. */
  startupDeadlineMs?: number
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

  const configuration: ConfigurationOutcome =
    configurationRoot === undefined ? { status: "absent" } : readProjectConfiguration(configurationRoot)

  const ports = startupPortsFor({
      ...(configurationRoot === undefined ? {} : { configurationRoot }),
      homeDir,
      storage,
      configuration,
      requiredFiles:
        overrides.requiredFiles ?? (() => [SUPERVISOR_ENTRYPOINT, HOUSEKEEPING_ENTRYPOINT, ...DESCRIPTION_FILES]),
      regularFileExists: isRegularFile,
      readHostVersion: async () => host.version,
      ...(overrides.toolchainProbe === undefined ? {} : { toolchainProbe: overrides.toolchainProbe }),
      ...(overrides.runtimeProbe === undefined ? {} : { runtimeProbe: overrides.runtimeProbe }),
      ...(overrides.environment === undefined ? {} : { environment: overrides.environment }),
      ...(overrides.startupDeadlineMs === undefined ? {} : { deadlineMs: overrides.startupDeadlineMs }),
  })
  const outcome = await runStartup(ports)

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

  const context: ServiceContext = { storage, containmentRoot, homeDir, configuration, hostVersion: outcome.hostVersion }
  const atStartup: ProbeResults = {
    ...(outcome.runtime === undefined ? {} : { runtime: outcome.runtime }),
    ...(outcome.toolchain === undefined ? {} : { toolchain: outcome.toolchain }),
  }
  const initial = availabilityFor(context, atStartup, "at startup")
  if (initial.status === "unavailable") say(describeUnavailable(initial))

  // The one way back from a transient failure (issue #162): an explicit
  // recovery probes again what did not answer, and nothing else does.
  const service = revalidatingService(initial, async () => {
    const again = availabilityFor(context, await probeAgain(ports, atStartup), "when probed again")
    if (again.status === "unavailable") say(describeUnavailable(again))
    return again
  })

  const deps: ToolDeps = {
    service,
    budget,
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

/** Everything a working service needs besides what the probes found. */
type ServiceContext = {
  storage: Storage
  containmentRoot: string
  homeDir: string
  configuration: ConfigurationOutcome
  hostVersion: string
}

/** When the probes ran, which is part of what their failure means. */
type ProbeOccasion = "at startup" | "when probed again"

type Probed<T> = { ok: true; value: T } | { ok: false; failure: Unavailable }

/**
 * The working service, or why there is none and whether that could pass.
 *
 * Guard clauses, so the unions narrow on their own. A permanent failure
 * outranks a transient one: when Xcode is unusable, a runtime probe that timed
 * out beside it is not what stands between the caller and a working tool, and
 * calling the whole thing transient would invite a recovery that cannot help
 * (issue #162).
 */
function availabilityFor(context: ServiceContext, probed: ProbeResults, occasion: ProbeOccasion): Availability {
  const toolchain = toolchainProbed(probed.toolchain, occasion)
  const runtime = runtimeProbed(probed.runtime, occasion)

  if (!toolchain.ok && !toolchain.failure.transient) return toolchain.failure
  if (!runtime.ok && !runtime.failure.transient) return runtime.failure
  if (!toolchain.ok) return toolchain.failure
  if (!runtime.ok) return runtime.failure
  return { status: "available", service: createService(context, toolchain.value, runtime.value) }
}

function toolchainProbed(toolchain: ToolchainResolution | undefined, occasion: ProbeOccasion): Probed<ToolchainIdentity> {
  if (toolchain === undefined) {
    return unavailable(true, `Xcode toolchain discovery did not finish in time ${occasion}.`)
  }
  if (toolchain.status !== "resolved") return unavailable(toolchain.timedOut === true, sentence(toolchain.message))
  // Checked here rather than after a Test Run (issue #164): an unsupported
  // Xcode's results can only ever be refused, so a run against it is a run
  // spent finding out what is already known.
  if (!isSupportedXcodeVersion(toolchain.identity.xcodeVersion)) {
    const { name, remedy } = SELECTIONS[toolchain.selectedBy]
    return unavailable(
      false,
      `Xcode ${toolchain.identity.xcodeVersion} is not supported by this Test Tool, which supports Xcode ${SUPPORTED_XCODE_MAJORS.join(" and ")}. It was chosen by ${name}. To use a supported one, ${remedy}.`,
    )
  }
  return { ok: true, value: toolchain.identity }
}

function runtimeProbed(
  runtime: RuntimeResolution | undefined,
  occasion: ProbeOccasion,
): Probed<Extract<RuntimeResolution, { status: "resolved" }>> {
  if (runtime === undefined) {
    return unavailable(
      true,
      occasion === "at startup"
        ? "the runtime could not be probed within the startup deadline."
        : `the runtime could not be probed in time ${occasion}.`,
    )
  }
  if (runtime.status !== "resolved") return unavailable(runtime.timedOut === true, runtimeDiagnostic(runtime))
  return { ok: true, value: runtime }
}

/** A message ending as a sentence does, without doubling a full stop it already has. */
function sentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`
}

function unavailable(transient: boolean, message: string): { ok: false; failure: Unavailable } {
  return { ok: false, failure: { status: "unavailable", transient, message } }
}

function createService(
  input: ServiceContext,
  toolchain: ToolchainIdentity,
  runtime: Extract<RuntimeResolution, { status: "resolved" }>,
) {
  return createTestToolService({
    storage: input.storage,
    containmentRoot: input.containmentRoot,
    homeDir: input.homeDir,
    configuration: input.configuration,
    toolchain,
    runtime: {
      path: runtime.path,
      ...(runtime.version === undefined ? {} : { version: runtime.version }),
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
