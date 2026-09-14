/**
 * Moving the wall clock under work that is already in progress (issue #43).
 *
 * Every deadline in this tool is a duration, and the machines it runs on move
 * their wall clocks: an NTP correction, a daylight change, a user setting the
 * time. A duration measured against a clock that moves is not a duration, and
 * the symptom is not a crash — it is work abandoned early and reported as
 * unfinished, or work allowed to run long past a bound that was supposed to
 * stop it.
 *
 * A forward jump is what these helpers simulate, because it is the direction
 * that produces the misleading answer: a budget that has barely been touched
 * looks entirely spent.
 */

/**
 * Run `work` with `Date.now` jumped an hour forward after its first call.
 *
 * The first call is left alone so that a deadline computed at the start is
 * computed from the real time; everything after it sees the jump. Code that
 * measures monotonically never notices.
 */
export function withJumpingWallClock<T>(work: () => T): T {
  const real = Date.now
  let calls = 0
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    Date.now = real
  }

  Date.now = () => (calls++ === 0 ? real() : real() + 3_600_000)
  try {
    const result = work()
    // Asynchronous work is the case that matters most and the easiest to get
    // wrong: restoring in a `finally` around a call that merely *returns* a
    // promise puts the clock back before the work it is meant to deceive has
    // run at all, and the test then passes for no reason.
    if (result instanceof Promise) return result.finally(restore) as T
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}
