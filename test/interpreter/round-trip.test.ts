/**
 * The interpreter and its own decoder agree (issue #50).
 *
 * These are two halves of one contract written in two files. The interpreter
 * publishes an index; the decoder reads it back on every later inspection and
 * refuses anything it cannot vouch for. Tightening the decoder is exactly the
 * kind of change that should be safe, and it is the kind that silently is not:
 * a rule that is merely *stricter than the writer* rejects a perfectly good
 * index, and `isNormalizedIndex` is all-or-nothing, so one bad field takes
 * every facet of a real run with it.
 *
 * The failure looks like damaged evidence rather than like a bug. A caller is
 * told the retained evidence for their run could not be read, which is what
 * they would be told if the file had actually been corrupted — so nothing in
 * the message points at the decoder that just started refusing it.
 *
 * This is the check neither side can make alone: interpret every committed
 * fixture, and decode what comes out. It is cheap, and it is the only thing
 * standing between a one-word tightening and a tool that reports every run as
 * unreadable.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"

import { isNormalizedIndex } from "../../src/interpreter/index-model.ts"
import { FAILED_EXIT, interpretFixture } from "./harness.ts"

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "xcresult")

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
}

describe("every index this interpreter publishes", () => {
  const names = fixtureNames()

  test("there are fixtures to check, so an empty sweep cannot pass", () => {
    // A sweep that found nothing would report green having verified nothing,
    // which is the failure this whole file exists to catch one layer up.
    expect(names.length).toBeGreaterThan(10)
  })

  for (const name of names) {
    test(`decodes: ${name}`, async () => {
      const interpreted = await interpretFixture(name, { request: { execution: FAILED_EXIT } })

      // Through JSON, because that is the journey the index actually makes.
      // A field holding `undefined` in memory is a field that is absent on
      // disk, and the decoder only ever sees the second.
      const published = JSON.parse(JSON.stringify(interpreted.index)) as unknown

      expect(isNormalizedIndex(published)).toBe(true)
    })
  }
})

describe("an occurrence with retries", () => {
  test("numbers its attempts from zero, and decodes", async () => {
    // Named separately because it is the case a tightened rule gets wrong in
    // the most plausible way: ordinals read as positions, positions start at
    // one, and these do not.
    const interpreted = await interpretFixture("attempts", { request: { execution: FAILED_EXIT } })
    const retried = interpreted.index.occurrences.find((entry) => entry.attempts.length > 1)

    expect(retried).toBeDefined()
    expect(retried?.attempts[0]?.ordinal).toBe(0)
    expect(isNormalizedIndex(JSON.parse(JSON.stringify(interpreted.index)))).toBe(true)
  })
})
