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
 *
 * **Nesting is not a demotion.** `suite`, `test` and `sourceIdentifier` sit
 * one level down inside an identity or a selection, and being nested made them
 * the cheapest strings in the record to halve — so they were the first to go,
 * which is precisely backwards. A test name is what `-only-testing` takes and
 * what a reader types into Xcode; half of one is a filter that runs nothing.
 * The rule is about what a field *is*, not where it sits.
 *
 * One consequence, said out loud because it is easy to miss: a scope
 * attestation and a test record are now *entirely* identifiers, so neither has
 * a string left that may be shortened. For those two facets an oversized first
 * record is always omitted and `fieldTruncated` is unreachable. That is the
 * intended reading of "preserve identifiers" for records that are nothing else.
 */
export const STRUCTURAL_FIELDS = new Set([
  "id",
  "testId",
  "kind",
  "status",
  "verdict",
  "canonical",
  "bundle",
  "suite",
  "test",
  "sourceIdentifier",
  "position",
  // A location is somewhere to go and look. Half a path names a file that
  // does not exist, and the reader who follows it learns nothing except that
  // this tool is wrong about where things are.
  "path",
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

/**
 * Which protected fields are the reason a record will not fit.
 *
 * A record that has shed everything sheddable and is still oversized is being
 * held up by something, and a caller deserves to be told which. "It does not
 * fit" is equally true of a two-hundred-kilobyte test name and a path with
 * twenty thousand directories in it, and those are different things to go and
 * look at.
 *
 * The answer is *what would have to give*: the largest protected fields, taken
 * in turn until the rest would fit. That is the question a reader is actually
 * asking, and it is why this is not "every protected field that is implicated"
 * — an identity and a canonical form that are each oversized implicate each
 * other, so a strict test of individual responsibility names neither, and a
 * joint one names the record's `id` and `status` alongside them as though a
 * four-character status were the problem.
 */
export function blockingFields(record: unknown, budget: number): string[] {
  const paths = protectedPaths(record).sort((a, b) => b.bytes - a.bytes)

  const blocking: string[] = []
  let remaining: unknown = record

  for (const { path } of paths) {
    if (responseBytes(remaining) <= budget) break
    remaining = without(remaining, path)
    blocking.push(path.join("."))
  }

  return blocking
}

/** Every protected leaf in the record, as a path from its root and its cost. */
function protectedPaths(record: unknown): Array<{ path: string[]; bytes: number }> {
  const found: Array<{ path: string[]; bytes: number }> = []

  const visit = (node: unknown, trail: string[]) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, [...trail, String(index)]))
      return
    }
    if (typeof node !== "object" || node === null) return

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && STRUCTURAL_FIELDS.has(key)) {
        found.push({ path: [...trail, key], bytes: Buffer.byteLength(value, "utf8") })
        continue
      }
      visit(value, [...trail, key])
    }
  }

  visit(record, [])
  return found
}

/** The record without one field, for asking whether that field was the problem. */
function without(record: unknown, path: string[]): unknown {
  const copy = structuredClone(record) as Record<string, unknown>
  let holder: Record<string, unknown> | undefined = copy

  for (const step of path.slice(0, -1)) {
    const next: unknown = holder?.[step]
    holder = typeof next === "object" && next !== null ? (next as Record<string, unknown>) : undefined
  }

  const leaf = path[path.length - 1]
  if (holder !== undefined && leaf !== undefined) delete holder[leaf]
  return copy
}
