/**
 * Reclaiming isolated DerivedData (issue #161).
 *
 * Isolated DerivedData is a per-run directory, not evidence — and it is large:
 * around ten gigabytes and hundreds of thousands of files for an ordinary app. Deleting it with `rmSync` held the host's event loop for as
 * long as the deletion took, which was longer than the OpenCode CLI waits
 * before declaring the service unresponsive and restarting it. The restart
 * took completed results down with it.
 *
 * So deletion here is asynchronous — `fs.promises.rm` does the filesystem work
 * off the event loop — and nothing a caller is waiting on waits for it. A Test
 * Run's terminal result is published, delivered and inspectable whether
 * reclamation is still going, has finished, or has failed.
 *
 * Three guarantees survive the move:
 *
 * - **Only a durably completed run is touched.** The record is read back here
 *   rather than trusted from the caller, so no path can reach the cache of a
 *   run that is still building into it.
 * - **Retention waits for the deletion to finish.** `derivedDataCleaned` is
 *   what makes an isolated run evictable, and it is written only after the
 *   tree is gone. A run whose reclamation is in flight, interrupted or failed
 *   stays retained, and the next reconciliation tries again.
 * - **A failure is a recorded fact, never a relabelled outcome.** It is written
 *   onto the run as the error code and when it happened. The terminal summary
 *   is never rewritten for it, and nothing is thrown at a caller who already
 *   has its result.
 */

import { rm } from "node:fs/promises"
import { join } from "node:path"

import { isRunId, RUN_ARTIFACTS, runDirectory, type Storage } from "./paths.ts"
import { readRunRecord, writeRunRecord, type RunRecord } from "./state.ts"

/** Deletes a directory tree without holding the event loop. */
export type TreeRemover = (path: string) => Promise<void>

export type ReclamationEnvironment = {
  storage: Storage
  timestamp(): string
  /**
   * How the tree is deleted. Defaults to the real thing; overridden only so a
   * slow or failing deletion can be produced on demand.
   */
  removeDerivedData?: TreeRemover
}

/**
 * `maxRetries` absorbs the transient `EBUSY` and `ENOTEMPTY` a concurrent
 * reclamation of the same tree — another OpenCode instance reconciling the same
 * root — can produce. Anything still failing after that is recorded.
 */
export const removeTree: TreeRemover = (path) =>
  rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })

/**
 * Reclamations in flight in this process, by run directory.
 *
 * Process-wide rather than per service, because that is the scope in which two
 * of them could race: every plugin instance this host loads for the same
 * project shares one storage scope.
 */
const inFlight = new Map<string, Promise<void>>()

/**
 * Reclaim one run's isolated DerivedData, if it has any to reclaim.
 *
 * Never rejects; whatever happens is recorded on the run. A reclamation of the
 * same run already in flight in this process is joined rather than repeated —
 * the next Test Run's reconciliation routinely arrives while the last run's
 * deletion is still going.
 */
export function reclaimIsolatedDerivedData(
  environment: ReclamationEnvironment,
  runId: string,
): Promise<void> {
  // A run id that cannot address storage names nothing to reclaim.
  if (!isRunId(runId)) return Promise.resolve()
  const key = runDirectory(environment.storage, runId)
  const existing = inFlight.get(key)
  if (existing !== undefined) return existing

  const reclamation = reclaim(environment, runId).finally(() => inFlight.delete(key))
  inFlight.set(key, reclamation)
  return reclamation
}

/**
 * Start reclaiming each run's isolated DerivedData, and return at once.
 *
 * What every caller outside this module wants: nothing that hands a result to
 * anyone may wait on a deletion. A host that exits before it finishes leaves
 * runs the next reconciliation names again.
 */
export function reclaimInBackground(environment: ReclamationEnvironment, runIds: readonly string[]): void {
  for (const runId of runIds) void reclaimIsolatedDerivedData(environment, runId)
}

/** Resolves once every reclamation in flight in this process has finished. */
export async function reclamationsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all(inFlight.values())
}

async function reclaim(environment: ReclamationEnvironment, runId: string): Promise<void> {
  const { storage } = environment
  const record = readRunRecord(storage, runId)
  if (record === undefined || !isReclaimable(record)) return

  let failure: { at: string; code: string } | undefined
  try {
    await (environment.removeDerivedData ?? removeTree)(
      join(runDirectory(storage, runId), RUN_ARTIFACTS.derivedData),
    )
  } catch (error) {
    failure = { at: environment.timestamp(), code: errorCode(error) }
  }

  // Read back rather than reused: the deletion can take tens of seconds, and
  // writing a copy taken before it would undo anything recorded meanwhile.
  const latest = readRunRecord(storage, runId)
  if (latest === undefined) return
  // Another instance finished the same deletion first. Its success stands; a
  // failure recorded beside it would describe a tree that is already gone.
  if (failure !== undefined && latest.derivedDataCleaned === true) return
  const next = { ...latest }
  delete next.derivedDataReclamationFailure
  try {
    writeRunRecord(
      storage,
      failure === undefined
        ? { ...next, derivedDataCleaned: true }
        : { ...next, derivedDataReclamationFailure: failure },
    )
  } catch {
    // The run directory went while the tree was being deleted. Nothing is left
    // to record onto, and nothing a caller holds depends on it.
  }
}

/** Whether a run is a completed isolated run whose cache is still there to reclaim. */
export function isReclaimable(record: RunRecord): boolean {
  return (
    record.state === "completed" &&
    record.derivedDataMode === "isolated" &&
    record.derivedDataCleaned !== true
  )
}

/** A filesystem error's code, which names what went wrong and no path. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "unknown"
}
