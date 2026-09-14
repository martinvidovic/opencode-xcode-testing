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

/**
 * Halve a string, keeping its start.
 *
 * The start survives because that is the part that says what the value is: a
 * message's first clause, an identifier's namespace. Halving rather than
 * measuring-and-cutting because the cost of a string in a JSON response
 * depends on its content — escaping expands some characters sixfold — so
 * there is no length to compute directly, and a few halvings converge.
 */
export function halve(text: string): string {
  return text.slice(0, Math.floor(text.length / 2))
}

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
      // The separator is part of the cost, or a record that fits "exactly"
      // lands a byte over once it is in a list.
      if (used + size > RESPONSE_BYTE_CAP) {
        const shrunk = shrink(record, RESPONSE_BYTE_CAP - used - 1)
        kept.push(shrunk.record)
        fieldTruncated = shrunk.shortened
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
 * Fields a shortened record keeps for as long as it can.
 *
 * #7 names them: identifiers, kinds, statuses and safe numeric fields. They are
 * what a caller *acts* on — a truncated id addresses nothing, and a truncated
 * verdict is a different verdict — while a message that loses its tail is
 * still the same message, shorter.
 *
 * "For as long as it can" is the whole of it, though. The byte cap is not a
 * preference, and a record whose *identifier* is what makes it oversized has
 * to give somewhere: preserving these at all costs would mean returning a
 * response over the cap, which is the one outcome the cap exists to forbid.
 */
const STRUCTURAL_FIELDS = new Set(["id", "testId", "kind", "status", "verdict", "canonical"])

/**
 * Shorten a record until it fits, deterministically.
 *
 * Display strings go first, longest first, so the field costing the most is
 * the one that gives and the same record always shrinks the same way. Only
 * once there is nothing else left do identifiers start to shorten — and the
 * response says `fieldTruncated`, so a caller knows not to trust what it is
 * holding as a complete record.
 */
function shrink<T>(record: T, budget: number): { record: T; shortened: boolean } {
  let current: unknown = structuredClone(record)
  let shortened = false

  for (let attempt = 0; attempt < SHRINK_ATTEMPTS; attempt += 1) {
    if (responseBytes(current) <= budget) break
    // Display strings while any remain; then everything, because the cap wins.
    if (!halveLongestString(current, true) && !halveLongestString(current, false)) break
    shortened = true
  }

  return { record: current as T, shortened }
}

/** Enough halvings to reduce any plausible field to nothing. */
const SHRINK_ATTEMPTS = 512

/**
 * Halve the longest shortenable string. False when there is none left.
 *
 * Ties are broken by key name rather than by iteration order, which JSON does
 * not promise to preserve — so two reads of the same record shrink identically
 * and a caller can compare them.
 */
function halveLongestString(value: unknown, displayOnly: boolean): boolean {
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
        if (entry.length <= 1) continue
        if (displayOnly && STRUCTURAL_FIELDS.has(key)) continue
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

  longest.holder[longest.key] = halve(longest.holder[longest.key] as string)
  return true
}
