/**
 * Reading a cancellation flag that is allowed to change (issue #74).
 *
 * Every one of these signals is a *live view*: the supervisor's is a getter
 * over a control channel, the queue's is checked between lock attempts, and
 * recovery's is checked between runs. A function that reads one twice expects
 * two different answers — that is the entire reason it reads it twice.
 *
 * A compiler cannot know that. It sees a property, narrows it to `false` after
 * the first check, and reports the second as a comparison that can never be
 * true. It was right about the code it could see and wrong about the code that
 * was written, which is the worst kind of warning to suppress with a cast.
 *
 * So the read is a call. A call is not narrowed, the type says out loud that
 * the answer is not a value anyone is holding, and the call site reads as what
 * it is asking rather than as a field access that happens to move.
 */

/** Anything with an `AbortSignal`-shaped flag, including an `AbortSignal`. */
export type Cancellable = { readonly aborted: boolean }

/** Whether this signal is cancelled *now*. */
export function isCancelled(signal: Cancellable | undefined): boolean {
  return signal?.aborted === true
}
