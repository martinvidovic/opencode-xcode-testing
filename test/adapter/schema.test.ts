/**
 * Input schemas (issue #141, superseding ADR 0002's Zod rule).
 *
 * The V2 host takes plain JSON Schema and validates it before a tool runs:
 * a missing required key, a too-short string or a wrong type is refused with
 * a message the model can act on, and unknown keys are stripped (issue #140).
 * So these schemas are the first gate a call meets — and they are plain data,
 * which is what lets this layer assert their exact shape with no host at all.
 *
 * The property that matters most is still optionality. Container, scheme,
 * destination and timeout are resolvable from project configuration; a schema
 * that required them would make a model invent a destination on every call.
 */

import { describe, expect, test } from "bun:test"

import {
  inspectInputSchema,
  recoverInputSchema,
  REQUIRED_ARGUMENTS,
  testInputSchema,
  type JsonSchema,
} from "../../src/adapter/schema.ts"
import { INSPECTION_FACETS } from "../../src/domain/inspection.ts"

function properties(schema: JsonSchema): Record<string, JsonSchema> {
  return (schema.properties ?? {}) as Record<string, JsonSchema>
}

describe("every input schema", () => {
  for (const [name, schema] of [
    ["xcode_test", testInputSchema],
    ["xcode_test_inspect", inspectInputSchema],
    ["xcode_test_recover", recoverInputSchema],
  ] as const) {
    test(`${name} is a closed object, so stray keys are stripped rather than trusted`, () => {
      expect(schema.type).toBe("object")
      expect(schema.additionalProperties).toBe(false)
    })
  }

  test("are JSON all the way down, so the host receives exactly what is asserted here", () => {
    for (const schema of [testInputSchema, inspectInputSchema, recoverInputSchema]) {
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
    }
  })
})

describe("xcode_test input", () => {
  const args = properties(testInputSchema)

  test("requires only the scope", () => {
    expect(testInputSchema.required).toEqual(["scope"])
    expect(REQUIRED_ARGUMENTS.xcode_test).toEqual(["scope"])
  })

  test("leaves every resolvable setting optional", () => {
    for (const key of ["container", "scheme", "destination", "timeoutSeconds"]) {
      expect(Object.keys(args)).toContain(key)
      expect(testInputSchema.required).not.toContain(key)
    }
  })

  test("declares the scope as a union of `all` and exact selections", () => {
    const options = args["scope"]?.anyOf ?? []
    expect(options.map((option) => (option.properties as Record<string, JsonSchema>)["kind"])).toEqual([
      { const: "all" },
      { const: "selected" },
    ])
    for (const option of options) expect(option.required).toContain("kind")
  })

  test("requires the bundle in a selection and leaves suite and test optional", () => {
    const selected = args["scope"]?.anyOf?.[1]
    const item = (selected?.properties as Record<string, JsonSchema>)["tests"]?.items as JsonSchema
    expect(item.required).toEqual(["bundle"])
    expect(Object.keys(item.properties ?? {}).sort()).toEqual(["bundle", "suite", "test"])
    expect(item.additionalProperties).toBe(false)
  })

  test("declares the container and destination as tagged unions", () => {
    const kinds = (key: string) =>
      (args[key]?.anyOf ?? []).map((option) => (option.properties as Record<string, JsonSchema>)["kind"])
    expect(kinds("container")).toEqual([{ const: "workspace" }, { const: "project" }])
    expect(kinds("destination")).toEqual([{ const: "id" }, { const: "named" }])
  })

  test("leaves the destination's OS optional", () => {
    const named = args["destination"]?.anyOf?.[1]
    expect(named?.required).toEqual(["kind", "platform", "name"])
  })

  test("refuses empty strings where a name is expected", () => {
    expect(args["scheme"]).toMatchObject({ type: "string", minLength: 1 })
  })

  test("bounds the timeout to the contract's range", () => {
    expect(args["timeoutSeconds"]).toMatchObject({ type: "integer", minimum: 1, maximum: 7_200 })
  })

  test("describes every argument, since the description is all a model sees", () => {
    for (const [key, value] of Object.entries(args)) {
      expect(`${key}:${value.description ?? ""}`.length).toBeGreaterThan(key.length + 10)
    }
  })
})

describe("xcode_test_inspect input", () => {
  const args = properties(inspectInputSchema)

  test("requires only the run id and the facet", () => {
    expect([...(inspectInputSchema.required ?? [])].sort()).toEqual(["facet", "runId"])
    expect([...REQUIRED_ARGUMENTS.xcode_test_inspect].sort()).toEqual(["facet", "runId"])
  })

  test("constrains the facet to the closed set", () => {
    expect(args["facet"]?.enum).toEqual([...INSPECTION_FACETS])
  })

  test("bounds the page size and the log chunk to the contract's caps", () => {
    expect(args["limit"]).toMatchObject({ type: "integer", minimum: 1, maximum: 100 })
    expect(args["maxBytes"]).toMatchObject({ type: "integer", minimum: 1, maximum: 65_536 })
  })

  test("describes every argument", () => {
    for (const [key, value] of Object.entries(args)) {
      expect(`${key}:${value.description ?? ""}`.length).toBeGreaterThan(key.length + 10)
    }
  })
})

describe("xcode_test_recover input", () => {
  test("is empty, because recovery has nothing to parameterize", () => {
    // Inventing a ceremonial argument would only invite a model to supply
    // something that cannot matter.
    expect(recoverInputSchema.properties).toEqual({})
    expect(recoverInputSchema.required).toBeUndefined()
    expect(REQUIRED_ARGUMENTS.xcode_test_recover).toEqual([])
  })
})
