/** User-facing contracts that must not drift from the module behavior. */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const README = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8")

describe("configuration discovery documentation", () => {
  test("states the bounded nearest-configuration and storage-scope contracts", () => {
    expect(README).toContain("nearest directory")
    expect(README).toContain("canonical launch directory through the\ncontainment root, inclusive")
    expect(README).toContain("never reads above containment")
    expect(README).toContain("launch directory as both boundaries")
    expect(README).toContain("registers nothing and says nothing")
    expect(README).toContain("Each containment/configuration pair")
    expect(README).toContain("existing storage identity")
  })
})
