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

import {
  prepareStorage,
  storageFor,
  storageForRootKey,
  type Storage,
} from "../runner/paths.ts"
import { loadCursorSecret } from "../runner/secrets.ts"
import { noteRootSeen, runHousekeeping } from "../runner/housekeeping.ts"
import { systemProbe } from "../runner/identity.ts"
import { resolveToolchain } from "../runner/toolchain.ts"
import type { ConfigurationOutcome } from "../runner/resolution.ts"
import { monotonicNow } from "../domain/clock.ts"
import { readOutputLimits, resolveBudget } from "./budget.ts"
import { descriptionFor, DESCRIPTION_FILES } from "./descriptions.ts"
import {
  cachedRuntime,
  rememberRuntime,
  resolveRuntime,
  type RuntimeResolution,
} from "./runtime.ts"
import { reconcileRootBounded } from "./reconciliation.ts"
import { createTestToolService, unavailableService } from "./service.ts"
import { inspectArguments, recoverArguments, testArguments, type ZodNamespace } from "./schema.ts"
import { hostVersionDiagnostic, runStartup, HOST_VERSION_BUDGET_MS } from "./startup.ts"
import { executeInspect, executeRecover, executeTest, type ToolDeps } from "./tools.ts"
import {
  enablementMarkerExists,
  readProjectConfiguration,
  resolveTrustedRoot,
} from "./trusted-root.ts"
import { probeRuntimeCandidate, bunOnPath } from "./probe.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const SUPERVISOR_ENTRYPOINT = join(HERE, "..", "runner", "supervisor-entry.ts")

export const server: Plugin = async (input) => {
  const root = resolveTrustedRoot({ worktree: input.worktree, directory: input.directory })
  if (root.status !== "resolved") return {}

  const trustedRoot = root.trustedRoot
  const homeDir = homedir()
  const storage = storageFor(homeDir, trustedRoot)

  let runtime: RuntimeResolution | undefined
  const configuration = readProjectConfiguration(trustedRoot)

  const outcome = await runStartup({
    markerExists: () => enablementMarkerExists(trustedRoot),
    requiredFiles: () => [SUPERVISOR_ENTRYPOINT, ...DESCRIPTION_FILES],
    regularFileExists: (path) => isRegularFile(path),

    async probeRuntime() {
      const configured =
        configuration.status === "loaded" ? configuration.configuration.runtime : undefined

      // The cache answers only where discovery would have run anyway. A
      // configured runtime is probed every time: ADR 0002 makes a set-but-
      // unusable value a hard error, and a cache answering on its behalf would
      // turn that into a silent fallback to some other binary.
      const cached = configured === undefined ? cachedRuntime(storage) : undefined
      if (cached !== undefined) {
        runtime = cached
        return runtime
      }

      const pathCandidate = await bunOnPath()
      runtime = await resolveRuntime({
        trustedRoot,
        ...(configured === undefined ? {} : { configured }),
        hostExecutable: process.execPath,
        ...(pathCandidate === undefined ? {} : { pathCandidate }),
        probe: probeRuntimeCandidate,
      })
      // Only a discovered runtime is worth remembering; a configured one is
      // deliberately re-probed.
      if (configured === undefined && runtime.status === "resolved") {
        rememberRuntime(storage, runtime)
      }
      return runtime
    },

    readHostVersion: () => readHostVersion(input.serverUrl),

    async reconcileRoot(deadlineMs: number) {
      prepareStorage(storage)
      noteRootSeen(storage, Date.now())

      // `deadlineMs` was built from `now` below, and `reconcileRootBounded`
      // reads the same clock. Handing it to something that measured against
      // the wall clock instead would not make the pass late — it would make it
      // cancelled before it began, on every start.
      reconcileRootBounded({
        storage,
        probe: systemProbe,
        deadlineMs,
        timestamp: () => new Date().toISOString(),
      })
    },

    async runHousekeeping() {
      runHousekeeping({
        storage,
        now: () => Date.now(),
        storageForRootKey: (rootKey) => storageForRootKey(homeDir, rootKey),
      })
    },

    now: monotonicNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })

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
  const hostOutputLimits = once(() => readOutputLimits(input.client))

  const skew = hostVersionDiagnostic(outcome.hostVersion)
  if (skew !== undefined) process.stderr.write(`xcode-test: ${skew}\n`)

  const service = serviceFor({
    storage,
    trustedRoot,
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
  trustedRoot: string
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
    trustedRoot: input.trustedRoot,
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
