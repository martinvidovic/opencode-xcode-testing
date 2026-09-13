/**
 * The pinned tool/schema pair the interpreter is written against (#8).
 *
 * Support is capability-based within one Xcode major: unknown additive fields
 * are ignored, but every classification-critical path must validate. Generated
 * schemas are reference material only — these decoders are hand-written and
 * tested against observed payloads, so the version pair below is a contract
 * with the fixtures, not a description of a file on disk.
 */

/** Explicitly requested on every structured `xcresulttool` invocation. */
export const REQUESTED_SCHEMA_VERSION = "0.1.0"

/** Bumped whenever a decoder's normalization or defect allowlist changes. */
export const DECODER_VERSION = 1

/** The one Xcode major this decoder set claims. Other majors are rejected. */
export const SUPPORTED_XCODE_MAJOR = 26

/** Eager interpretation budget, measured on the monotonic clock (#8). */
export const EAGER_DEADLINE_MS = 120_000

/** Per-operation budget for lazy, bundle-backed detail (#8). */
export const LAZY_DEADLINE_MS = 60_000

/** True when a recorded Xcode product version falls in the supported major. */
export function isSupportedXcodeVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10)
  return Number.isInteger(major) && major === SUPPORTED_XCODE_MAJOR
}
