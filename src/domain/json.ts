/**
 * Reading values that arrived as JSON.
 *
 * Every durable file this tool writes is read back from a filesystem it does
 * not exclusively control, so each one is validated before it is believed.
 * Those validators all start the same way — "is this even an object?" — and
 * that one shared question lives here so the answer is written once.
 *
 * Deliberately not a schema library: the checks that matter are specific to
 * each record, and a dependency that made them generic would also make them
 * harder to read than the thing being checked.
 */

/** A non-null JSON object, narrowed so its fields can be read without casts. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A value from a closed set, not merely a string of the right type.
 *
 * The difference is what a caller does next. These values are read back from
 * durable files and handed onward, and one outside its set — a verdict of
 * `"definitely fine"`, a mode of `"wat"` — reads as authoritative while
 * meaning nothing this tool ever produced. The set is the check.
 */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

/** An array whose every element passes `check`. */
export function isArrayOf<T>(value: unknown, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(check)
}

/**
 * A count: an integer, not negative, and small enough to still be exact.
 *
 * `typeof value === "number"` admits `NaN`, `Infinity`, `-1` and `1e308`, and
 * every one of them reaches a caller as a count. `NaN` is the worst of them,
 * because it compares false against everything — a page that asks whether it
 * has returned all of them would answer "no" forever — but a negative count
 * or one past `Number.MAX_SAFE_INTEGER` is a number that has stopped meaning
 * what its name says.
 */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * An elapsed time in milliseconds: finite, not negative, possibly fractional.
 *
 * The one quantity here that is legitimately not whole. `NaN` renders as
 * "NaN ms" and a negative one describes a test that finished before it
 * started; both are numbers that have stopped meaning what their name says.
 */
export function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * A position within a source file: an integer, and at least one.
 *
 * Editors count from one, so a zero or a negative line is not a location a
 * caller can act on — it is a number that will send someone to the wrong
 * place, or to no place at all.
 */
export function isPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

/**
 * Text that identifies something: a run id, a digest, a canonical test name.
 *
 * Emptiness is the case worth naming. `""` is a string, so a shape check
 * passes, and it then reaches a caller as an identifier that addresses
 * nothing — indistinguishable, at the point of use, from one that was never
 * there.
 */
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}
