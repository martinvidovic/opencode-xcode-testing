/**
 * The reconciliation pass as production runs it (ADR 0002, issue #42).
 *
 * Startup reconciliation is the only thing standing between a crashed OpenCode
 * and a trusted root that can never be used again, and it is unusually easy to
 * break without noticing: it returns no value anyone reads, it is expected to
 * find nothing on a healthy machine, and a pass that examined nothing at all
 * looks exactly like a pass that found nothing wrong.
 *
 * That is why the wiring lives here instead of inline in the plugin
 * entrypoint. The entrypoint cannot be exercised without a host; this can, so
 * the deadline the pass is given and the clock it compares that deadline
 * against are asserted against each other by a test rather than by inspection.
 */

import { monotonicNow } from "../domain/clock.ts"
import type { ProcessProbe } from "../runner/identity.ts"
import type { Storage } from "../runner/paths.ts"
import { reconcileRoot, type RecoveryReport } from "../runner/recovery.ts"

export type ReconciliationPorts = {
  storage: Storage
  probe: ProcessProbe
  /** An instant on the monotonic clock, and the only clock this pass reads. */
  deadlineMs: number
  timestamp(): string
}

/**
 * Reconcile a root, stopping between runs once `deadlineMs` has passed.
 *
 * The bound is checked *inside* the pass rather than raced against it from
 * outside, because the pass is synchronous filesystem work: a timer cannot fire
 * while the work it is bounding is still on the stack, so a deadline enforced
 * around the call would only ever be observed after the call it was meant to
 * cut short had already finished.
 */
export function reconcileRootBounded(input: ReconciliationPorts): RecoveryReport {
  return reconcileRoot({
    storage: input.storage,
    probe: input.probe,
    timestamp: input.timestamp,
    // A getter, read afresh between runs, and the only place a deadline is
    // compared to a clock. There is nothing to inject: `monotonicNow` is the
    // clock every caller's `deadlineMs` is already built from, so naming it
    // here is what makes "one clock domain" true by construction rather than
    // by agreement between two files.
    signal: {
      get aborted() {
        return monotonicNow() >= input.deadlineMs
      },
    },
  })
}
