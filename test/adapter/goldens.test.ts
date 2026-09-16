/**
 * Renderer goldens (ADR 0002, layer (a)).
 *
 * The model's entire view of a Test Run is this text, so a change to it is a
 * change to what the model believes. Byte-exact goldens make that change a diff
 * in review rather than a discovery in production — which is the whole reason
 * the renderer is a pure function with no I/O or clock to make it wobble.
 *
 * Regenerate deliberately: `UPDATE_GOLDENS=1 bun test`.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { field, isField } from "../../src/adapter/document.ts"
import { renderTestToolResult } from "../../src/adapter/output.ts"
import { SCENARIOS } from "./scenarios.ts"

const GOLDEN_DIR = join(import.meta.dir, "..", "golden")
const UPDATE = process.env["UPDATE_GOLDENS"] === "1"

describe("renderer goldens", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const rendered = renderTestToolResult(await scenario.build())
      const path = join(GOLDEN_DIR, `${scenario.name}.txt`)

      if (UPDATE) {
        mkdirSync(GOLDEN_DIR, { recursive: true })
        writeFileSync(path, rendered.text)
      }

      expect(existsSync(path)).toBe(true)
      expect(rendered.text).toBe(readFileSync(path, "utf8"))

      // An ordinary response never drops a section and never gets cut.
      expect(rendered.droppedBlocks).toBe(0)
      expect(rendered.hardTruncated).toBe(false)
    })
  }

  test("every golden belongs to a scenario, so a renamed one cannot go stale", () => {
    if (!existsSync(GOLDEN_DIR)) return
    const committed = readdirSync(GOLDEN_DIR)
      .filter((entry) => entry.endsWith(".txt"))
      .map((entry) => entry.replace(/\.txt$/, ""))
      .sort()

    expect(committed).toEqual(SCENARIOS.map((scenario) => scenario.name).sort())
  })
})

describe("telling a rendered field from the prose around it", () => {
  /**
   * The acceptance gate quotes the reason beneath a mismatched headline, and
   * finds it by skipping the `label   value` lines above it. That is a
   * question about how `field` lays a line out, so it is asked of the renderer
   * rather than reconstructed from a regex somewhere else — a reconstruction
   * goes silently wrong the moment the column width changes, and a gate that
   * reports an empty reason reports nothing at all.
   */
  test("recognizes what `field` renders, at whatever width it renders it", () => {
    expect(isField(field("run", "abc123"))).toBe(true)
    expect(isField(field("destination", "iPhone 17"))).toBe(true)
    // A label at or past the column still runs into its value with no gap.
    expect(isField(field("a-very-long-label", "value"))).toBe(false)
  })

  test("does not mistake prose for a field, however it is spaced", () => {
    expect(isField("the Requested Scope did not match the tests that were observed")).toBe(false)
    expect(isField("two  spaces inside a sentence do not make it a field")).toBe(false)
    expect(isField("")).toBe(false)
    expect(isField("   ")).toBe(false)
  })
})
