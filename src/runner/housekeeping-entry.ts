/**
 * User-wide housekeeping, run on its own thread (issue #153).
 *
 * Housekeeping is synchronous filesystem work across every registered root:
 * walking each one to size it, renaming and deleting stale roots, evicting
 * runs and reclaiming Shared Build Caches that can be tens of gigabytes. On the
 * host's thread that held the event loop for as long as it took — long enough,
 * with large caches, that startup's own timers could not fire, and items that
 * had finished were reported as having timed out.
 *
 * So it runs here, in a worker, where nothing it does can hold the host. It
 * still stops at the deadline it is handed, checked between roots, because a
 * pass that outlives startup is a pass whose roots go unvisited for an hour
 * either way — better to stop, and say which.
 *
 * Coordination is unchanged by the move. The advisory locks are `flock`s on
 * separate opens of the lock file, which exclude each other between threads of
 * one process exactly as they do between processes.
 *
 * Nothing here is ever terminated from outside: a worker stopped mid-rename or
 * holding a lock would leave exactly the state housekeeping exists to clean up.
 * It ends when its work does — after the reclamations its reconciliations
 * started, so the host is told the pass is over only once it is.
 */

import { parentPort, workerData } from "node:worker_threads"

import { monotonicNow } from "../domain/clock.ts"
import { isRecord } from "../domain/json.ts"
import { runHousekeeping } from "./housekeeping.ts"
import { systemProbe } from "./identity.ts"
import { isRootKey, storageForRootKey } from "./paths.ts"
import { reclaimInBackground, reclamationsSettled } from "./reclamation.ts"
import { reconcileRoot } from "./recovery.ts"

/** What the host hands this thread: where storage is, whose, and for how long. */
export type HousekeepingRequest = { homeDir: string; rootKey: string; budgetMs: number }

/** What this thread answers before it ends. Anything but `failed` is a pass that ran or was skipped. */
export type HousekeepingReply = { status: "ran" | "skipped" | "failed" }

function isHousekeepingRequest(value: unknown): value is HousekeepingRequest {
  return (
    isRecord(value) &&
    typeof value.homeDir === "string" &&
    typeof value.rootKey === "string" &&
    isRootKey(value.rootKey) &&
    typeof value.budgetMs === "number"
  )
}

/** One pass, stopping once `budgetMs` has elapsed on this thread's clock. */
async function housekeep(request: HousekeepingRequest): Promise<HousekeepingReply["status"]> {
  const deadline = monotonicNow() + request.budgetMs
  const storageFor = (rootKey: string) => storageForRootKey(request.homeDir, rootKey)
  const timestamp = () => new Date().toISOString()

  const outcome = runHousekeeping({
    storage: storageFor(request.rootKey),
    now: () => Date.now(),
    storageForRootKey: storageFor,
    // Recovery, asked about every root this pass visits (issue #110).
    // Without it a run that crashed leaves its execution slot held for
    // ever, and retention reads that slot and declines to reclaim the
    // root's build caches — for ever, because recovery otherwise runs
    // only when a root is opened again.
    //
    // No claimant: this pass cannot finalize anything, and adopting a run
    // it has no interpreter for would take it from an instance that has.
    //
    // Leftover isolated DerivedData is reclaimed from here too (issue
    // #161): in a root nobody opens again, this is the only pass that will
    // ever name it.
    reconcile: (storage) => {
      const report = reconcileRoot({ storage, probe: systemProbe, timestamp })
      reclaimInBackground({ storage, timestamp }, report.needsReclamation)
      return report
    },
    expired: () => monotonicNow() >= deadline,
  })
  await reclamationsSettled()
  return outcome.status
}

if (parentPort !== null) {
  const port = parentPort
  const reply = (status: HousekeepingReply["status"]) => port.postMessage({ status } satisfies HousekeepingReply)
  if (isHousekeepingRequest(workerData)) {
    housekeep(workerData).then(reply, () => reply("failed"))
  } else {
    reply("failed")
  }
}
