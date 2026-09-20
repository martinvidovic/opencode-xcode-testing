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

import { monotonicNow } from "../domain/clock.ts"
import { noteRootSeen, runHousekeeping } from "../runner/housekeeping.ts"
import { systemProbe } from "../runner/identity.ts"
import { reconcileRoot } from "../runner/recovery.ts"
import { prepareStorage, storageForRootKey, type Storage } from "../runner/paths.ts"
import type { ConfigurationOutcome } from "../runner/resolution.ts"
import { bunOnPath, probeRuntimeCandidate } from "./probe.ts"
import { reconcileRootBounded } from "./reconciliation.ts"
import { cachedRuntime, rememberRuntime, resolveRuntime, type RuntimeResolution } from "./runtime.ts"
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
        probe: probeRuntimeCandidate,
      })
      // Only a discovered runtime is worth remembering; a configured one is
      // deliberately re-probed.
      if (configured === undefined && runtime.status === "resolved") {
        rememberRuntime(wiring.storage, runtime)
      }
      wiring.onRuntime(runtime)
      return runtime
    },

    async reconcileRoot(deadlineMs: number) {
      prepareStorage(wiring.storage)
      noteRootSeen(wiring.storage, Date.now())

      // `deadlineMs` came from `now` below and is read against `monotonicNow`
      // inside the pass. Two clocks here would not make the pass late — they
      // would make it cancelled before it began, on every start.
      reconcileRootBounded({
        storage: wiring.storage,
        probe: systemProbe,
        deadlineMs,
        timestamp: () => new Date().toISOString(),
      })
    },

    async runHousekeeping() {
      runHousekeeping({
        storage: wiring.storage,
        now: () => Date.now(),
        storageForRootKey: (rootKey) => storageForRootKey(wiring.homeDir, rootKey),
        // Recovery, asked about every root this pass visits (issue #110).
        // Without it a run that crashed leaves its execution slot held for
        // ever, and retention reads that slot and declines to reclaim the
        // root's build caches — for ever, because recovery otherwise runs
        // only when a root is opened again.
        //
        // No claimant: this pass cannot finalize anything, and adopting a run
        // it has no interpreter for would take it from an instance that has.
        reconcile: (storage) =>
          reconcileRoot({
            storage,
            probe: systemProbe,
            timestamp: () => new Date().toISOString(),
          }),
      })
    },

    now: monotonicNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
