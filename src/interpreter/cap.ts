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

import { RESPONSE_BYTE_CAP } from "../domain/limits.ts"
import type { TruncationState } from "../domain/inspection.ts"

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
 * `overhead` is whatever the response carries besides the records themselves —
 * the envelope, the truncation state, the cursor — measured by the caller,
 * because only the caller knows the shape it is about to build.
 */
export function capRecords<T>(records: T[], overhead: number): CappedPage<T> {
  let used = overhead
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

/**
 * Fold a shrink into the truncation state the response reports.
 *
 * `responseTruncated` and `collectionTruncated` mean different things and both
 * can be true: the first says the cap cut this page, the second says more
 * records exist. A caller deciding whether to ask again needs the second; a
 * caller deciding whether the page is a faithful picture needs the first.
 */
export function withResponseTruncation(
  truncation: TruncationState,
  dropped: number,
  nextCursor: string | undefined,
): TruncationState {
  if (dropped === 0) return truncation
  return {
    ...truncation,
    responseTruncated: true,
    collectionTruncated: true,
    hasMore: true,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}
