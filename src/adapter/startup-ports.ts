/**
 * The startup ports, as production builds them (issue #52).
 *
 * `runStartup` is a sequence with no host in it, and it has been testable for
 * that reason since ADR 0002. What was not testable is the *wiring* — the
 * object of closures the plugin entrypoint hands it — and the wiring is where
 * the interesting failures have actually been.
 *
 * The one that shipped is the shape of the problem: startup built a deadline
 * from the monotonic clock and passed it to a pass that compared it against
 * the wall clock. Neither half was wrong on its own. Both were right in a test
 * that exercised only one of them. And the result was reconciliation cancelled
 * before it looked at anything, on every start, silently — a healthy machine
 * and a broken one produce the same output, because a pass that examines
 * nothing looks exactly like a pass that finds nothing wrong.
 *
 * So the ports live here rather than inline in the entrypoint, which keeps
 * that file the thin host binding it claims to be and makes this object
 * something a test can build, run and assert against with no host at all.
 */

import { Worker } from "node:worker_threads"

import { monotonicNow } from "../domain/clock.ts"
import type { HousekeepingReply, HousekeepingRequest } from "../runner/housekeeping-entry.ts"
import { noteRootSeen } from "../runner/housekeeping.ts"
import { systemProbe } from "../runner/identity.ts"
import { reclaimInBackground } from "../runner/reclamation.ts"
import { resolveToolchain, type ToolchainProbe } from "../runner/toolchain.ts"
import { prepareStorage, type Storage } from "../runner/paths.ts"
import type { ConfigurationOutcome } from "../runner/resolution.ts"
import { HOUSEKEEPING_ENTRYPOINT } from "./entrypoints.ts"
import { bunOnPath, probeRuntimeCandidate } from "./probe.ts"
import { reconcileRootBounded } from "./reconciliation.ts"
import {
  cachedRuntime,
  rememberRuntime,
  resolveRuntime,
  type RuntimeProbe,
  type RuntimeResolution,
} from "./runtime.ts"
import type { StartupPorts } from "./startup.ts"
import { enablementMarkerExists } from "./root-roles.ts"

export type StartupWiring = {
  configurationRoot?: string
  homeDir: string
  storage: Storage
  configuration: ConfigurationOutcome
  /** Files a static import graph cannot protect: entrypoint and sidecars. */
  requiredFiles(): string[]
  regularFileExists(path: string): boolean
  readHostVersion(): Promise<string>
  /** Told what the probe resolved, since the caller needs it after startup. */
  onRuntime(runtime: RuntimeResolution): void
  /** How toolchain discovery probes. Defaults to spawning the real tools. */
  toolchainProbe?: ToolchainProbe
  /** How a runtime candidate is probed. Defaults to running a real script. */
  runtimeProbe?: RuntimeProbe
  /** The startup ceiling. Defaults to `STARTUP_DEADLINE_MS`. */
  deadlineMs?: number
}

export function startupPortsFor(wiring: StartupWiring): StartupPorts {
  return {
    markerExists: () =>
      wiring.configurationRoot !== undefined && enablementMarkerExists(wiring.configurationRoot),
    requiredFiles: wiring.requiredFiles,
    regularFileExists: wiring.regularFileExists,
    readHostVersion: wiring.readHostVersion,

    async probeRuntime() {
      const configured =
        wiring.configuration.status === "loaded"
          ? wiring.configuration.configuration.runtime
          : undefined

      // The cache answers only where discovery would have run anyway. A
      // configured runtime is probed every time: ADR 0002 makes a set-but-
      // unusable value a hard error, and a cache answering on its behalf would
      // turn that into a silent fallback to some other binary.
      const cached = configured === undefined ? cachedRuntime(wiring.storage) : undefined
      if (cached !== undefined) {
        wiring.onRuntime(cached)
        return cached
      }

      const pathCandidate = await bunOnPath()
      const runtime = await resolveRuntime({
        configurationRoot: wiring.configurationRoot ?? wiring.storage.rootDir,
        ...(configured === undefined ? {} : { configured }),
        hostExecutable: process.execPath,
        ...(pathCandidate === undefined ? {} : { pathCandidate }),
        probe: wiring.runtimeProbe ?? probeRuntimeCandidate,
      })
      // Only a discovered runtime is worth remembering; a configured one is
      // deliberately re-probed.
      if (configured === undefined && runtime.status === "resolved") {
        rememberRuntime(wiring.storage, runtime)
      }
      wiring.onRuntime(runtime)
      return runtime
    },

    resolveToolchain: (signal) =>
      resolveToolchain({
        signal,
        ...(wiring.toolchainProbe === undefined ? {} : { probe: wiring.toolchainProbe }),
      }),

    async reconcileRoot(deadlineMs: number) {
      prepareStorage(wiring.storage)
      noteRootSeen(wiring.storage, Date.now())

      // `deadlineMs` came from `now` below and is read against `monotonicNow`
      // inside the pass. Two clocks here would not make the pass late — they
      // would make it cancelled before it began, on every start.
      const timestamp = () => new Date().toISOString()
      const report = reconcileRootBounded({
        storage: wiring.storage,
        probe: systemProbe,
        deadlineMs,
        timestamp,
      })
      // Recovery names a crash's leftover isolated DerivedData and leaves the
      // deletion to its caller, which must not wait for it (issue #161).
      reclaimInBackground({ storage: wiring.storage, timestamp }, report.needsReclamation)
    },

    // On its own thread (issue #153): see `housekeeping-entry.ts`. The budget
    // crosses as a duration, not an instant, so the two threads never have to
    // agree on a clock origin.
    runHousekeeping: (deadlineMs) =>
      housekeepOffThread({
        homeDir: wiring.homeDir,
        rootKey: wiring.storage.rootKey,
        budgetMs: deadlineMs - monotonicNow(),
      }),

    now: monotonicNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...(wiring.deadlineMs === undefined ? {} : { deadlineMs: wiring.deadlineMs }),
  }
}

/**
 * Run one housekeeping pass on a worker, settling when the worker is done.
 *
 * Unreferenced, so a host shutting down is never held by maintenance it will
 * simply pick up next time. A worker that cannot be started, throws, or says
 * its pass failed is a failed item — never a reason to fall back to doing this
 * work on the host's own thread, which is the whole of what moving it was for.
 */
function housekeepOffThread(request: HousekeepingRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(HOUSEKEEPING_ENTRYPOINT, { workerData: request })
    } catch (error) {
      reject(error)
      return
    }
    worker.unref()
    let failed = false
    worker.on("message", (reply: HousekeepingReply) => {
      if (reply.status === "failed") failed = true
    })
    worker.once("error", reject)
    worker.once("exit", () => (failed ? reject(new Error("housekeeping failed")) : resolve()))
  })
}
