/**
 * The seams the interpreter reaches the outside world through.
 *
 * Everything the interpreter needs from a real machine — the frozen
 * `xcresulttool`, the monotonic clock, the caller's cancellation — arrives as a
 * port. That is what lets ADR 0001's Layer 1 drive every classification branch
 * from committed synthetic payloads, with no Xcode and no host present.
 */

import type { ToolchainIdentity } from "../domain/toolchain.ts"
import type { XcresultCommand } from "./anomalies.ts"

/**
 * The toolchain a Result Bundle was produced by and must be read back with.
 *
 * Defined in the domain, because the runner freezes it for the child and the
 * interpreter reads the bundle back with it — both have to mean the same thing
 * by "the same toolchain", and the runner may not import this module.
 */
export type { ToolchainIdentity } from "../domain/toolchain.ts"
export { toolchainIdentityMatches } from "../domain/toolchain.ts"

/** Why a structured read did not produce a payload. */
export type XcresultFailure =
  | "bundleMissing"
  | "bundleUnreadable"
  | "unsupported"
  | "commandFailed"
  | "timedOut"

export type XcresultResponse =
  | { ok: true; payload: unknown }
  | { ok: false; failure: XcresultFailure; message: string }

/**
 * The one wording for a read that ran out of its budget.
 *
 * Here rather than in either half of a staged read, because both halves reach
 * it: the wait can expire before a payload arrives, and the decode can expire
 * turning one into a value. A caller told "the structured read exceeded its
 * remaining budget" should not be able to tell which, because the answer is
 * the same either way — there is no result, and the deadline is why.
 */
export const TIMED_OUT: XcresultResponse = {
  ok: false,
  failure: "timedOut",
  message: "the structured read exceeded its remaining budget",
}

/**
 * The frozen same-Xcode `xcresulttool`. Implementations spawn it in their own
 * process group under the remaining budget; the interpreter only ever asks.
 */
export type XcresultTool = {
  identity: ToolchainIdentity
  /**
   * `subject` is the one command argument that is not fixed: the Xcode test
   * identifier a detail read is about. It comes from Xcode's own payload, and
   * never from a request.
   */
  run(command: XcresultCommand, budgetMs: number, subject?: string): Promise<XcresultResponse>
}

/**
 * The monotonic clock, never the adjustable wall clock — a deadline that a
 * clock adjustment can move is not a deadline.
 */
export type MonotonicClock = { now(): number }

/** The caller's cancellation, checked between steps and never swallowed. */
export type CancellationSignal = { aborted: boolean }

/** What the runner knows about a finished process before anything is decoded. */
export type ExecutionFacts = {
  runId: string
  /** Canonical absolute trusted root, used only to make paths repository-relative. */
  trustedRoot: string
  /** Whether the expected Result Bundle path exists at all. */
  resultBundlePresent: boolean
  /** Stabilization-time digest re-verification, per #8. */
  bundleDigestVerified: "yes" | "no" | "unknown"
  /** The toolchain recorded at execution, compared against the reader's identity. */
  toolchain: ToolchainIdentity
  /** Retained raw-log facts. Content is inspection-only and never classified on. */
  log: { retainedBytes?: number; retainedBytesExact: boolean }
}
