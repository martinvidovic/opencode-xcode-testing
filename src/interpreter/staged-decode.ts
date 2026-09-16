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
import { TIMED_OUT, type XcresultResponse } from "./ports.ts"

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
    // `commandFailed`, not `unsupported` (issue #84). The two are statements
    // about different things, and only one of them is about the caller.
    //
    // `unsupported` says the caller's Result Bundle holds a schema this tool
    // does not understand — a real answer, reached by reading a payload and
    // failing to recognize what is in it. Text that is not JSON at all was
    // never a payload: either `xcresulttool` did not emit one, or this tool
    // did not finish staging the one it was given. Both are the tool's own
    // difficulty, and reporting them as a bundle's schema sends a caller to
    // inspect evidence that is perfectly sound.
    //
    // The byte count goes with it, because it is what tells the two causes
    // apart afterwards: nothing staged at all reads very differently from a
    // payload cut off part-way through.
    return {
      ok: false,
      failure: "commandFailed",
      message: `the structured output was not JSON: the tool staged ${text.length} byte${
        text.length === 1 ? "" : "s"
      } it could not parse`,
    }
  }

  // Decided last, and deliberately after a successful parse: an overrun is a
  // fact about the read, not about the payload.
  return expired() ? TIMED_OUT : { ok: true, payload }
}
