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

import { existsSync, statfsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { tool, type Plugin, type PluginModule, type ToolDefinition } from "@opencode-ai/plugin"

import { prepareStorage, storageFor } from "../runner/paths.ts"
import { loadCursorSecret } from "../runner/secrets.ts"
import { noteRootSeen, runHousekeeping } from "../runner/housekeeping.ts"
import { reconcileRoot } from "../runner/recovery.ts"
import { systemProbe } from "../runner/identity.ts"
import { resolveToolchain } from "../runner/toolchain.ts"
import { resolveBudget } from "./budget.ts"
import { descriptionFor, DESCRIPTION_FILES } from "./descriptions.ts"
import { resolveRuntime, type RuntimeResolution } from "./runtime.ts"
import { createTestToolService } from "./service.ts"
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
    fileExists: (path) => existsSync(path),

    async probeRuntime() {
      runtime = resolveRuntime({
        trustedRoot,
        ...(configuration.status === "loaded" && configuration.configuration.runtime !== undefined
          ? { configured: configuration.configuration.runtime }
          : {}),
        hostExecutable: process.execPath,
        ...(bunOnPath() === undefined ? {} : { pathCandidate: bunOnPath() as string }),
        probe: probeRuntimeCandidate,
      })
      return runtime
    },

    readHostVersion: () => readHostVersion(input.serverUrl),

    async reconcileRoot() {
      prepareStorage(storage)
      noteRootSeen(storage, Date.now())
      reconcileRoot({
        storage,
        probe: systemProbe,
        timestamp: () => new Date().toISOString(),
      })
    },

    async runHousekeeping() {
      runHousekeeping({
        storage,
        now: () => Date.now(),
        storageForRootKey: (rootKey) => ({ ...storage, rootKey }),
      })
    },

    now: () => Number(process.hrtime.bigint() / 1_000_000n),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })

  if (outcome.status === "disabled") return {}
  if (outcome.status === "structuralFailure") {
    process.stderr.write(`xcode-test: ${outcome.diagnostic}\n`)
    return {}
  }

  const skew = hostVersionDiagnostic(outcome.hostVersion)
  if (skew !== undefined) process.stderr.write(`xcode-test: ${skew}\n`)

  const toolchain = resolveToolchain()
  if (toolchain.status !== "resolved" || runtime?.status !== "resolved") {
    // Registering tools that provably cannot run is worse than registering none.
    process.stderr.write(
      `xcode-test: ${toolchain.status !== "resolved" ? toolchain.message : (runtime as { message: string }).message}\n`,
    )
    return {}
  }

  const service = createTestToolService({
    storage,
    trustedRoot,
    homeDir,
    ...(configuration.status === "loaded" ? { configuration: configuration.configuration } : {}),
    toolchain: toolchain.identity,
    runtimePath: runtime.path,
    supervisorEntrypoint: SUPERVISOR_ENTRYPOINT,
    now: () => Number(process.hrtime.bigint() / 1_000_000n),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes: freeBytesOn(storage.toolRoot),
    cursorSecret: loadCursorSecret(storage),
  })

  // Effective limits are read once: the host's configuration is not
  // hot-reloaded, so re-reading per call could only invent a disagreement.
  const deps: ToolDeps = {
    service,
    budget: resolveBudget(undefined),
    now: () => Number(process.hrtime.bigint() / 1_000_000n),
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
