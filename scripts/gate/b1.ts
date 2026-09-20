/**
 * The (b1) suite: registration, then installation (issue #70).
 *
 * Two gates, run back to back and independent of each other — a host that will
 * not start says nothing about whether a documented symlink registers the tool
 * family. That independence is why the composite has a module of its own
 * rather than living inside either gate: neither is the other's parent, and a
 * file that ran its peer would read as though one were.
 *
 * It also gives the composite a name a test can drive. The ordering here is a
 * property of the production code, and a test that records the scenarios it
 * expects in the order it expects proves only that the test knows what it
 * wrote down.
 */

import { runInstallationGate } from "./installation.ts"
import type { ScenarioSink } from "./observations.ts"
import { runRegistrationGate } from "./registration.ts"
import { SCENARIO } from "./scenarios.ts"
import type { DrivenRoots } from "./driven-roots.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"

export type B1Gates = {
  registration(): Promise<void>
  installation(): Promise<void>
}

/**
 * `runInstallationGate` runs whatever happened to registration, on purpose:
 * its check is the one that proves the README's instructions work, and a host
 * failure is no reason to stop asking.
 *
 * "Whatever happened" includes a throw (issue #80). The registration gate
 * reports its own failures and is not expected to raise, but expecting is not
 * the same as guaranteeing — and the guarantee belongs here, because this file
 * is where the independence of the two gates is asserted. One that let its
 * first gate's exception cancel its second would be asserting the opposite,
 * on the machines least able to tell.
 */
export async function runB1Suite(
  record: ScenarioSink,
  roots: DrivenRoots,
  gates: B1Gates = {
    registration: () => runRegistrationGate(record, roots),
    installation: () => runInstallationGate(record, roots),
  },
): Promise<void> {
  try {
    await gates.registration()
  } catch (error) {
    // A last resort with a worse diagnostic than the gate's own, which is
    // what makes it a last resort: anything that reaches here got past the
    // handler that knows what it was doing.
    record({
      name: SCENARIO["b1 host registration"],
      kind: "gating",
      status: "failed",
      detail: `the registration gate ended unexpectedly: ${safeFailure(error)}`,
    })
  }

  await gates.installation()
}
