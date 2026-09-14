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
 * and a cursor that cannot move leaves the caller no way to reach the rest of
 * the evidence at all.
 *
 * That makes one record mandatory, and a mandatory record can still be too
 * big on its own. #7 says what happens then, and it is not "return it anyway":
 * identifiers, kinds, statuses and numbers are preserved, and display strings
 * are truncated deterministically until it fits.
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
  /** A record's display strings were shortened to fit. Rare, and reported. */
  fieldTruncated: boolean
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
  let fieldTruncated = false

  for (const record of records) {
    const size = responseBytes(record) + 1

    // The first record is mandatory: returning an empty page would freeze the
    // cursor at this position forever, and the caller could never reach
    // anything beyond it. So it goes in — shortened if it has to be, never
    // dropped.
    if (kept.length === 0) {
      if (used + size > RESPONSE_BYTE_CAP) {
        kept.push(shrink(record, RESPONSE_BYTE_CAP - used))
        fieldTruncated = true
        break
      }
      used += size
      kept.push(record)
      continue
    }

    if (used + size > RESPONSE_BYTE_CAP) break
    used += size
    kept.push(record)
  }

  return { records: kept, dropped: records.length - kept.length, fieldTruncated }
}

/**
 * Fields a shortened record keeps whatever it costs.
 *
 * #7 names them: identifiers, kinds, statuses and safe numeric fields. They are
 * what a caller *acts* on — a truncated id addresses nothing, and a truncated
 * verdict is a different verdict — while a message that loses its tail is
 * still the same message, shorter.
 */
const STRUCTURAL_FIELDS = new Set(["id", "testId", "kind", "status", "verdict", "canonical"])

/**
 * Shorten a record's display strings until it fits, deterministically.
 *
 * The longest non-structural string is halved, then the next longest, and so
 * on — so the same record always shrinks the same way, and the field that is
 * costing the most is the one that gives. Ties are broken by key name rather
 * than by iteration order, which JSON does not promise to preserve.
 */
function shrink<T>(record: T, budget: number): T {
  let current: unknown = structuredClone(record)

  for (let attempt = 0; attempt < SHRINK_ATTEMPTS; attempt += 1) {
    if (responseBytes(current) <= budget) break
    if (!halveLongestString(current)) break
  }

  return current as T
}

/** Enough halvings to reduce any plausible field to nothing. */
const SHRINK_ATTEMPTS = 64

/** False when there is no display string left worth shortening. */
function halveLongestString(value: unknown): boolean {
  let longest: { holder: Record<string, unknown>; key: string; length: number } | undefined

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (typeof node !== "object" || node === null) return

    const holder = node as Record<string, unknown>
    for (const key of Object.keys(holder).sort()) {
      const entry = holder[key]
      if (typeof entry === "string") {
        if (STRUCTURAL_FIELDS.has(key) || entry.length <= 1) continue
        if (longest === undefined || entry.length > longest.length) {
          longest = { holder, key, length: entry.length }
        }
        continue
      }
      visit(entry)
    }
  }

  visit(value)
  if (longest === undefined) return false

  const text = longest.holder[longest.key] as string
  // The start survives, because that is the part that says what this is.
  longest.holder[longest.key] = text.slice(0, Math.floor(text.length / 2))
  return true
}
