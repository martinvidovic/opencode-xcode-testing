/**
 * What every execution layer needs before it can run anything (ADR 0001).
 *
 * One type rather than one per layer: the gate builds it once and hands it
 * down unchanged, and two declarations of the same three fields is two places
 * to forget one when a fourth arrives.
 */

import type { Destination } from "../../src/domain/request.ts"
import type { ToolchainIdentity } from "../../src/domain/toolchain.ts"

export type ExecutionContext = {
  toolchain: ToolchainIdentity
  runtimePath: string
  destination: Destination
}
