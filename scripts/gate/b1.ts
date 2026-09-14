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

/**
 * `runInstallationGate` runs whatever happened to registration, on purpose:
 * its check is the one that proves the README's instructions work, and a host
 * failure is no reason to stop asking.
 */
export async function runB1Suite(record: ScenarioSink): Promise<void> {
  await runRegistrationGate(record)
  await runInstallationGate(record)
}
