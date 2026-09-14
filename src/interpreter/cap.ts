/**
 * The domain response cap (#7).
 *
 * `RESPONSE_BYTE_CAP` is a promise about the typed response itself, not about
 * the text the adapter renders from it: a caller reading the contract must be
 * able to size a page without knowing how it will later be printed. The
 * adapter's own output budget is a second, tighter bound applied afterwards —
 * two caps for two different readers, and neither substitutes for the other.
 *
 * Shrinking is by whole records, and the first record is never dropped. A page
 * that returned nothing would report `hasMore` forever at the same position,
 * and a cursor that cannot move is worse than a page that is too big: the
 * caller has no way to reach the rest of the evidence at all.
 */

import { RESPONSE_BYTE_CAP, RESPONSE_ENVELOPE_BYTES } from "../domain/limits.ts"

/** Serialized UTF-8 bytes of a value, as the contract counts them. */
export function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
}

export type CappedPage<T> = {
  records: T[]
  /** Records dropped to fit. Zero for every ordinary page. */
  dropped: number
}

/**
 * The longest prefix of `records` that fits, keeping at least one.
 *
 * `RESPONSE_ENVELOPE_BYTES` is the room reserved for everything else the
 * response carries: the status, the facet tag, the truncation state, a cursor.
 */
export function capRecords<T>(records: T[]): CappedPage<T> {
  let used = RESPONSE_ENVELOPE_BYTES
  const kept: T[] = []

  for (const record of records) {
    const size = responseBytes(record) + 1
    // The first record goes in whatever it costs. Returning an empty page
    // would freeze the cursor, and an oversized single record is at least
    // progress the caller can act on.
    if (kept.length > 0 && used + size > RESPONSE_BYTE_CAP) break
    used += size
    kept.push(record)
  }

  return { records: kept, dropped: records.length - kept.length }
}
