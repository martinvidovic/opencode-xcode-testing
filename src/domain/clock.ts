/**
 * The one monotonic clock (issue #42).
 *
 * Every deadline in this tool is a duration — "give up five seconds from now" —
 * and a duration measured against the wall clock is not a duration at all. A
 * clock correction, an NTP step or a daylight change moves `Date.now()`
 * underneath a deadline that has already been computed, which turns a bound
 * into an instant expiry or a wait that never ends.
 *
 * The subtler reason this is a shared function rather than an expression
 * written where it is needed: a deadline is only meaningful to a reader that
 * measures against the *same origin*. `process.hrtime` counts from an
 * arbitrary point near process start, so a deadline built from it and compared
 * against `Date.now()` is not a late deadline or an early one — it is already
 * past by roughly the age of the epoch, every time. Two clocks in one deadline
 * is a silent, total failure, and the way to not have two clocks is to have
 * one.
 */

/** Milliseconds from an arbitrary fixed origin. Never moves backwards. */
export function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}
