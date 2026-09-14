/**
 * The registration gate's schema comparison (issue #27).
 *
 * The comparison is the thing under test here, not the schemas: it runs only
 * against a live host, so a defect in it would show up as a gate that passes
 * for the wrong reason and nowhere else. Each test names a way the host's
 * rendering could go wrong and asserts the gate would notice.
 */

import { describe, expect, test } from "bun:test"

import { EXPECTED_SCHEMAS, schemaComplaints } from "../../scripts/gate/schemas.ts"

/** The contract's own shape, which must of course pass. */
function faithful(toolId: string): Record<string, unknown> {
  const expectation = EXPECTED_SCHEMAS[toolId]
  if (expectation === undefined) throw new Error(`no expectation for ${toolId}`)

  const properties: Record<string, Record<string, unknown>> = {}
  for (const [name, property] of Object.entries(expectation.properties)) {
    properties[name] = {
      ...(property.described === true ? { description: `what ${name} means` } : {}),
      ...(property.type === undefined ? {} : { type: property.type }),
      ...(property.enum === undefined ? {} : { enum: [...property.enum] }),
      ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
      ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
      ...(property.variants === undefined
        ? {}
        : { anyOf: Array.from({ length: property.variants }, () => ({ type: "object" })) }),
    }
  }

  return { type: "object", properties, required: [...expectation.required] }
}

describe("a faithful rendering", () => {
  for (const toolId of Object.keys(EXPECTED_SCHEMAS)) {
    test(`${toolId} passes`, () => {
      expect(schemaComplaints(toolId, faithful(toolId))).toEqual([])
    })
  }
})

describe("the comparison notices", () => {
  test("a host that marks every field required", () => {
    // ADR 0002 records being bitten by exactly this: under the legacy
    // JSON-Schema fallback a model would have to invent a destination on
    // every call. A snapshot test would have passed the day it started.
    const schema = faithful("xcode_test")
    schema["required"] = Object.keys(EXPECTED_SCHEMAS["xcode_test"]?.properties ?? {})

    expect(schemaComplaints("xcode_test", schema).join(" ")).toContain("requires")
  })

  test("a field that quietly disappeared", () => {
    const schema = faithful("xcode_test_inspect")
    delete (schema["properties"] as Record<string, unknown>)["cursor"]

    expect(schemaComplaints("xcode_test_inspect", schema).join(" ")).toContain("exposes")
  })

  test("an argument invented for a tool that takes none", () => {
    expect(
      schemaComplaints("xcode_test_recover", {
        type: "object",
        properties: { runId: { type: "string" } },
        required: [],
      }).join(" "),
    ).toContain("exposes")
  })

  test("a facet set that stopped being closed", () => {
    // An open facet lets a model ask for something that does not exist and
    // receive a plausible-looking empty answer.
    const schema = faithful("xcode_test_inspect")
    delete ((schema["properties"] as Record<string, Record<string, unknown>>)["facet"] ?? {})["enum"]

    expect(schemaComplaints("xcode_test_inspect", schema).join(" ")).toContain("allows (anything)")
  })

  test("a numeric bound that moved", () => {
    const schema = faithful("xcode_test_inspect")
    ;((schema["properties"] as Record<string, Record<string, unknown>>)["maxBytes"] ?? {})["maximum"] = 1_000_000

    expect(schemaComplaints("xcode_test_inspect", schema).join(" ")).toContain("maximum")
  })

  test("a union collapsed to a single shape", () => {
    const schema = faithful("xcode_test")
    ;((schema["properties"] as Record<string, Record<string, unknown>>)["scope"] ?? {})["anyOf"] = [
      { type: "object" },
    ]

    expect(schemaComplaints("xcode_test", schema).join(" ")).toContain("variants")
  })

  test("a field that lost the prose a model reads", () => {
    const schema = faithful("xcode_test")
    delete ((schema["properties"] as Record<string, Record<string, unknown>>)["scheme"] ?? {})["description"]

    expect(schemaComplaints("xcode_test", schema).join(" ")).toContain("carries no description")
  })

  test("a tool that exposed no schema at all", () => {
    expect(schemaComplaints("xcode_test", undefined).join(" ")).toContain("no object schema")
  })
})
