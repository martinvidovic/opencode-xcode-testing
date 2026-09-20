/**
 * The OpenCode v1 plugin entrypoint (ADR 0002).
 *
 * This is the **only** file in the codebase permitted to import
 * `@opencode-ai/plugin`, and it is deliberately thin: it wires host handles to
 * modules that are testable without a host. Everything with a decision in it —
 * the startup sequence, runtime resolution, the renderer, the budget — lives
 * elsewhere precisely so that layer (a) can drive it with no host installed.
 *
 * The factory is awaited before every other host service, so it registers
 * nothing and stays silent in a project that has not opted in. "This is not an
 * Xcode project" is a normal state, not a diagnostic.
 */

import { lstatSync, statfsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { tool, type Plugin, type PluginModule, type ToolDefinition } from "@opencode-ai/plugin"

import { storageFor, type Storage } from "../runner/paths.ts"
import { loadCursorSecret } from "../runner/secrets.ts"
import { resolveToolchain } from "../runner/toolchain.ts"
import type { ConfigurationOutcome } from "../runner/resolution.ts"
import { monotonicNow } from "../domain/clock.ts"
import { readOutputLimits, resolveBudget } from "./budget.ts"
import { descriptionFor, DESCRIPTION_FILES } from "./descriptions.ts"
import type { RuntimeResolution } from "./runtime.ts"
import { createTestToolService, unavailableService } from "./service.ts"
import { inspectArguments, recoverArguments, testArguments, type ZodNamespace } from "./schema.ts"
import { startupPortsFor } from "./startup-ports.ts"
import { hostVersionDiagnostic, runStartup, HOST_VERSION_BUDGET_MS } from "./startup.ts"
import { executeInspect, executeRecover, executeTest, type ToolDeps } from "./tools.ts"
import { readProjectConfiguration, resolveRootRoles } from "./root-roles.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_ENTRYPOINT = join(HERE, "..", "runner", "supervisor-entry.ts")

export const server: Plugin = async (input) => {
  const roots = resolveRootRoles({ worktree: input.worktree, directory: input.directory })
  if (roots.status !== "resolved") return {}

  const { containmentRoot, configurationRoot } = roots
  const homeDir = homedir()
  const storage = storageFor(homeDir, containmentRoot)

  let runtime: RuntimeResolution | undefined
  const configuration = readProjectConfiguration(configurationRoot)

  const outcome = await runStartup(
    startupPortsFor({
      configurationRoot,
      homeDir,
      storage,
      configuration,
      requiredFiles: () => [SUPERVISOR_ENTRYPOINT, ...DESCRIPTION_FILES],
      regularFileExists: isRegularFile,
      readHostVersion: () => readHostVersion(input.serverUrl),
      onRuntime: (resolved) => {
        runtime = resolved
      },
    }),
  )

  if (outcome.status === "disabled") return {}
  if (outcome.status === "structuralFailure") {
    process.stderr.write(`xcode-test: ${outcome.diagnostic}\n`)
    return {}
  }

  // Read once, but **not here**. The factory runs inside the host's own
  // bootstrap, and asking the host a question before that bootstrap finishes
  // deadlocks it: the config route cannot answer until the plugin it is
  // waiting on returns. Deferring to first use keeps the read-once property —
  // the host's configuration is not hot-reloaded, so two calls in one session
  // can never disagree — without the factory depending on a server that is
  // still starting.
  const hostOutputLimits = once(async () => {
    const limits = await readOutputLimits(input.client)

    // Announced, once, the first time it matters (issue #82). A conservative
    // guess nobody is told about is still a guess: the adapter's invariant is
    // that host truncation is unreachable, and without the limits it can only
    // keep that under a floor it chose for itself. Saying so is what turns an
    // assumption into something the person running it can act on.
    if (limits.status === "unreadable") {
      process.stderr.write(
        `xcode-test: the host's output limits could not be read (${limits.detail}), so responses are held to a conservative floor. If your \`tool_output\` limits are lower than that, they may still be exceeded.\n`,
      )
    }
    return limits
  })

  const skew = hostVersionDiagnostic(outcome.hostVersion)
  if (skew !== undefined) process.stderr.write(`xcode-test: ${skew}\n`)

  const service = serviceFor({
    storage,
    containmentRoot,
    homeDir,
    configuration,
    toolchain: resolveToolchain(),
    runtime,
    hostVersion: outcome.hostVersion,
  })


  // Effective limits are read once: the host's configuration is not
  // hot-reloaded, so re-reading per call could only invent a disagreement.
  const deps: ToolDeps = {
    service,
    budget: async () => resolveBudget(await hostOutputLimits()),
    now: monotonicNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timestamp: () => new Date().toISOString(),
  }

  const z = tool.schema as unknown as ZodNamespace

  return {
    tool: {
      xcode_test: tool({
        description: descriptionFor("xcode_test"),
        args: testArguments(z) as never,
        execute: (args, context) =>
          executeTest(args as never, context, deps),
      }) as ToolDefinition,

      xcode_test_inspect: tool({
        description: descriptionFor("xcode_test_inspect"),
        args: inspectArguments(z) as never,
        execute: (args, context) => executeInspect(args as never, context, deps),
      }) as ToolDefinition,

      xcode_test_recover: tool({
        description: descriptionFor("xcode_test_recover"),
        args: recoverArguments(z) as never,
        execute: (args, context) => executeRecover(args as never, context, deps),
      }) as ToolDefinition,
    },

    /**
     * A best-effort backstop only — nothing may depend on it running. It never
     * attempts process cleanup or reconciliation: those are crash-tolerant
     * paths that must work when this never fires at all.
     */
    async dispose() {
      return
    },
  }
}

/**
 * The host version is not on `PluginInput`, so it is read with a bounded
 * `fetch`. Unreachable, erroring or unparseable all degrade to `unknown`, and
 * registration is never blocked on it.
 */
async function readHostVersion(serverUrl: URL): Promise<string> {
  try {
    const response = await fetch(new URL("/global/health", serverUrl), {
      signal: AbortSignal.timeout(HOST_VERSION_BUDGET_MS),
    })
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === "string" ? body.version : "unknown"
  } catch {
    return "unknown"
  }
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

const plugin: PluginModule = { id: "xcode-test", server }
export default plugin

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
function serviceFor(input: {
  storage: Storage
  containmentRoot: string
  homeDir: string
  configuration: ConfigurationOutcome
  toolchain: ReturnType<typeof resolveToolchain>
  runtime: RuntimeResolution | undefined
  hostVersion: string
}) {
  const refuse = (message: string) => {
    process.stderr.write(`xcode-test: ${message}\n`)
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

/**
 * Evaluate once, on first use, and hand every later caller the same answer.
 *
 * Not a cache for speed: it is what lets a value be "read once per session"
 * without that read having to happen at a moment when it cannot succeed.
 */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= read())
}
