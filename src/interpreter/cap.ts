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
 *
 * **Preserved means preserved.** When the display strings run out and the
 * record still does not fit, what gives is the record — not its identifiers.
 * A halved id addresses nothing and a halved status is a different status, and
 * both are worse than absence because both still look like answers: a caller
 * cannot tell a shortened id from a real one, and will ask about a test that
 * does not exist. So the record is reduced to the fields a caller acts on, and
 * if even those do not fit it is omitted and the page says so.
 *
 * Omitting is only safe because the cursor moves past it. A mandatory record
 * that were dropped without advancing the position would freeze paging at
 * exactly the record nobody can read.
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
  /**
   * Records the caller will never see, because they could not be represented
   * at all. Distinct from `dropped`: a dropped record arrives on the next
   * page, and an omitted one does not exist as far as paging is concerned.
   *
   * At most one per page in practice, because only the *first* record is ever
   * made to fit — every later one simply waits for the next page, where it
   * becomes a first record and gets the same chance. A count rather than a
   * flag because that is what it is counting.
   */
  omitted: number
  /**
   * How many input records this page accounts for — kept plus omitted.
   *
   * The cursor advances by this, not by the number returned. Advancing by the
   * returned count would park the cursor forever on a record that cannot be
   * returned, and every subsequent page would be the same empty one.
   */
  consumed: number
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
  let omitted = 0

  for (const record of records) {
    // The separator is part of the cost, or a record that fits "exactly"
    // lands a byte over once it is in a list.
    const size = responseBytes(record) + 1
    const first = kept.length === 0

    if (used + size <= RESPONSE_BYTE_CAP) {
      used += size
      kept.push(record)
      continue
    }

    // Anything but the first record simply waits for the next page. The
    // position has already moved past everything kept, so nothing is lost.
    if (!first) break

    // The first record is the one that cannot wait: returning an empty page
    // would leave the caller at this position forever. So it is made to fit —
    // by shortening what can be shortened, and failing that by keeping only
    // what a caller acts on.
    const shrunk = shrink(record, RESPONSE_BYTE_CAP - used - 1)
    if (shrunk.record !== undefined) {
      kept.push(shrunk.record)
      fieldTruncated = shrunk.shortened
      break
    }

    // Not even its identifiers fit. It is passed over rather than mangled, and
    // the page reports it — the cursor moves on, so the caller reaches the
    // rest of the evidence instead of stalling here.
    omitted += 1
    break
  }

  const consumed = kept.length + omitted
  return { records: kept, dropped: records.length - consumed, fieldTruncated, omitted, consumed }
}

/**
 * Fields a shortened record keeps, whatever it costs to keep them.
 *
 * These are what a caller *acts* on, and none of them survives being
 * shortened: an id addresses a thing, a status is a claim about it, a bundle
 * name says which selection a verdict is about. The cap is still absolute — a
 * record whose identifier alone is oversized is omitted rather than returned —
 * but it is met by leaving the record out, never by returning a corrupted one.
 */
const STRUCTURAL_FIELDS = new Set([
  "id",
  "testId",
  "kind",
  "status",
  "verdict",
  "canonical",
  "bundle",
  "position",
])

/**
 * Shorten a record until it fits, deterministically. `undefined` when it cannot.
 *
 * Display strings only, longest first, so the field costing the most is the
 * one that gives and the same record always shrinks the same way.
 *
 * A structural field is never altered, at any budget. A caller reading a
 * halved id cannot tell it from a whole one; they will ask about a test that
 * does not exist and be told, correctly and uselessly, that it is not there.
 * Nor is a record ever returned stripped down to its identifiers: that would
 * be an object of the declared type with its required fields missing, which is
 * the same lie one level down. Returning nothing is recoverable — the page
 * reports it, and a caller knows there is something here they cannot have.
 */
function shrink<T>(record: T, budget: number): { record?: T; shortened: boolean } {
  let current: unknown = structuredClone(record)
  let shortened = false

  for (let attempt = 0; attempt < SHRINK_ATTEMPTS; attempt += 1) {
    if (responseBytes(current) <= budget) return { record: current as T, shortened }
    if (!halveLongestString(current)) break
    shortened = true
  }

  // Every display string is gone and it still does not fit. There is nothing
  // further to give that would leave a record a caller could use: what remains
  // is identifiers, kinds and statuses, and none of those survives being
  // shortened. So the record is not represented, and the page says so.
  return { shortened: true }
}

/** Enough halvings to reduce any plausible field to nothing. */
const SHRINK_ATTEMPTS = 512

/**
 * Halve the longest **display** string. False when there is none left.
 *
 * Structural fields are never candidates, at any point and for any budget.
 * That is the whole of the guarantee: there is no second pass that relaxes it
 * once the easy savings run out, because a cap met by corrupting an identifier
 * has not been met — it has been swapped for a quieter failure.
 *
 * Ties are broken by key name rather than by iteration order, which JSON does
 * not promise to preserve — so two reads of the same record shrink identically
 * and a caller can compare them.
 */
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
        if (entry.length <= 1) continue
        if (STRUCTURAL_FIELDS.has(key)) continue
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
