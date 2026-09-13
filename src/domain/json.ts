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

/** An array whose every element passes `check`. */
export function isArrayOf<T>(value: unknown, check: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(check)
}
