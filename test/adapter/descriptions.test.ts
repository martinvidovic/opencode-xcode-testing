/**
 * The description-vs-outcome-vocabulary consistency check (ADR 0002).
 *
 * A tool description that names outcomes the renderer does not emit — or omits
 * ones it does — teaches a model a vocabulary the tool does not speak. That
 * drift is invisible in review, because the two live in different files and
 * neither one is obviously wrong on its own. So it is checked mechanically,
 * against the goldens rather than against a second hand-written list.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { descriptionFor, descriptionPath, TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { TEST_TOOL_OUTCOMES } from "../../src/domain/outcome.ts"
import { INSPECTION_FACETS } from "../../src/domain/inspection.ts"
import { FACET_AVAILABILITIES, NOT_FOUND_SUBJECTS } from "../../src/domain/inspection.ts"

const GOLDEN_DIR = join(import.meta.dir, "..", "golden")

/** Every outcome word the renderer actually puts in a headline. */
function renderedOutcomes(): Set<string> {
  const outcomes = new Set<string>()
  for (const entry of readdirSync(GOLDEN_DIR).filter((name) => name.endsWith(".txt"))) {
    const headline = readFileSync(join(GOLDEN_DIR, entry), "utf8").split("\n")[0] ?? ""
    const match = /^Test Run (\w+)/.exec(headline)
    if (match?.[1] !== undefined) outcomes.add(match[1])
  }
  return outcomes
}

describe("the outcome vocabulary", () => {
  test("is emitted in full by the renderer, across the goldens", () => {
    expect([...renderedOutcomes()].sort()).toEqual([...TEST_TOOL_OUTCOMES].sort())
  })

  test("is named in full by the xcode_test description", () => {
    const description = descriptionFor("xcode_test")
    for (const outcome of renderedOutcomes()) expect(description).toContain(outcome)
  })

  test("is not extended by the description with words the renderer never emits", () => {
    // A description that invents `flaky` or `error` would have a model looking
    // for an outcome that cannot arrive.
    const description = descriptionFor("xcode_test")
    const candidates = description.match(/\b[a-z]+[A-Z][A-Za-z]*\b/g) ?? []
    const known = new Set<string>([
      ...TEST_TOOL_OUTCOMES,
      ...INSPECTION_FACETS,
      ...FACET_AVAILABILITIES,
      "xcodebuild",
    ])
    for (const candidate of candidates) expect(known.has(candidate)).toBe(true)
  })
})

describe("the inspect description", () => {
  test("names every facet the tool accepts", () => {
    const description = descriptionFor("xcode_test_inspect")
    for (const facet of INSPECTION_FACETS) expect(description).toContain(facet)
  })

  test("names every response status a caller has to distinguish", () => {
    const description = descriptionFor("xcode_test_inspect")
    for (const status of ["available", "incomplete", "expired", "notFound", "unsupported"]) {
      expect(description).toContain(status)
    }
    for (const subject of NOT_FOUND_SUBJECTS) expect(typeof subject).toBe("string")
  })
})

describe("the recover description", () => {
  test("names every status recovery can return", () => {
    const description = descriptionFor("xcode_test_recover")
    for (const status of [
      "recovered",
      "alreadyHealthy",
      "busy",
      "stillQuarantined",
      "cancelled",
      "failed",
    ]) {
      expect(description).toContain(status)
    }
  })
})

describe("every description", () => {
  test("exists as a sidecar file, which is what startup verifies", () => {
    for (const id of TOOL_IDS) {
      expect(readFileSync(descriptionPath(id), "utf8").length).toBeGreaterThan(0)
    }
  })

  test("is substantial enough to be worth loading from a file", () => {
    for (const id of TOOL_IDS) expect(descriptionFor(id).length).toBeGreaterThan(200)
  })

  test("carries no absolute path or private identifier", () => {
    for (const id of TOOL_IDS) {
      expect(descriptionFor(id)).not.toMatch(/\/(?:Users|home|Volumes)\//)
    }
  })
})
