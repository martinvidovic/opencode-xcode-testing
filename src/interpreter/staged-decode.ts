/**
 * Reading a staged structured payload back (#8, issue #56).
 *
 * The other half of a staged read, and a boundary in its own right rather
 * than a piece of `xcresulttool.ts` prised out for a test. Staging splits one
 * operation into two with genuinely different characters: getting bytes out of
 * a subprocess, which is asynchronous, signal-driven and cancellable; and
 * turning a file into a payload, which is synchronous, uninterruptible, and
 * bounded by size rather than by anything a timer can do. They fail in
 * different ways and are reasoned about separately, so they live apart.
 *
 * That the second half is then directly testable is a consequence of the
 * split, not the reason for it. It is worth saying because driving these
 * checks through the whole read is not merely awkward but unsound: a budget
 * small enough to expire during a decode expires during the wait instead, and
 * the read's own timer answers first — so a test written that way passes
 * whether or not any of this exists.
 */

import { readFileSync } from "node:fs"

import { monotonicNow } from "../domain/clock.ts"
import type { XcresultResponse } from "./ports.ts"

/** The one wording for an expired read, used wherever the deadline is checked. */
export const TIMED_OUT: XcresultResponse = {
  ok: false,
  failure: "timedOut",
  message: "the structured read exceeded its remaining budget",
}

/**
 * Turn a staged file into a payload, or into the reason it could not be one.
 *
 * The deadline is checked three times, and the third is the one that makes it
 * a bound rather than a gesture.
 *
 * *Before* the read, because a decode that starts with no budget left should
 * not start. *Before* the parse, because reading hundreds of megabytes off a
 * disk is itself work the budget was meant to cover. And *after* the parse,
 * because a synchronous parse cannot be interrupted once it has begun —
 * nothing else runs while it is on the stack, timers included — so the only
 * honest thing left to do about one that overran is to decline to report its
 * result as an answer arrived at in time.
 *
 * That last check is what stops a successful decode outliving its budget. The
 * caller asked for an answer within a deadline; an answer produced after it is
 * not that answer, and returning it anyway would make every deadline here
 * advisory. The work was wasted either way — the difference is whether the
 * caller is told so.
 */
export function decodeStaged(staged: string, deadline: number): XcresultResponse {
  const expired = () => monotonicNow() >= deadline
  if (expired()) return TIMED_OUT

  let text: string
  try {
    text = readFileSync(staged, "utf8")
  } catch {
    return {
      ok: false,
      failure: "commandFailed",
      message: "the staged structured output could not be read back",
    }
  }

  if (expired()) return TIMED_OUT

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return {
      ok: false,
      failure: "unsupported",
      message: "the structured output could not be parsed as JSON",
    }
  }

  // Decided last, and deliberately after a successful parse: an overrun is a
  // fact about the read, not about the payload.
  return expired() ? TIMED_OUT : { ok: true, payload }
}
