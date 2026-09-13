/**
 * Argument schemas (ADR 0002).
 *
 * The stub namespace records what it was asked to build, so the shape can be
 * asserted without `@opencode-ai/plugin` installed — which is the whole reason
 * the schemas take the namespace as a parameter.
 *
 * The property that matters most is optionality. The host has a legacy
 * JSON-Schema fallback that marks **every** key required; accepting it would
 * make container, scheme, destination and timeout mandatory, and a model would
 * have to invent a destination on every single call.
 */

import { describe, expect, test } from "bun:test"

import {
  inspectArguments,
  recoverArguments,
  REQUIRED_ARGUMENTS,
  testArguments,
  type ZodNamespace,
  type ZodType,
} from "../../src/adapter/schema.ts"
import { INSPECTION_FACETS } from "../../src/domain/inspection.ts"

type Recorded = ZodType & {
  kind: string
  optional_: boolean
  described: string | undefined
  shape?: Record<string, Recorded>
  options?: Recorded[]
  values?: readonly string[]
  inner?: Recorded
  bounds: { min?: number; max?: number }
}

function node(kind: string, extra: Partial<Recorded> = {}): Recorded {
  const self: Recorded = {
    kind,
    optional_: false,
    described: undefined,
    bounds: {},
    ...extra,
    optional() {
      self.optional_ = true
      return self
    },
    describe(text: string) {
      self.described = text
      return self
    },
  } as Recorded
  return self
}

function stub(): ZodNamespace {
  return {
    string: () =>
      Object.assign(node("string"), {
        min(n: number) {
          const self = this as unknown as Recorded
          self.bounds.min = n
          return self
        },
      }) as never,
    number: () =>
      Object.assign(node("number"), {
        int() {
          const self = this as unknown as Recorded
          self.kind = "integer"
          return Object.assign(self, {
            min(n: number) {
              self.bounds.min = n
              return Object.assign(self, {
                max(m: number) {
                  self.bounds.max = m
                  return self
                },
              })
            },
          })
        },
      }) as never,
    boolean: () => node("boolean"),
    literal: (value: string) => node(`literal:${value}`),
    array: (inner: ZodType) => node("array", { inner: inner as Recorded }),
    object: (shape: Record<string, ZodType>) =>
      node("object", { shape: shape as Record<string, Recorded> }),
    union: (options: ZodType[]) => node("union", { options: options as Recorded[] }),
    enum: (values: readonly string[]) => node("enum", { values }),
  }
}

function shapeOf(build: (z: ZodNamespace) => Record<string, ZodType>): Record<string, Recorded> {
  return build(stub()) as Record<string, Recorded>
}

describe("xcode_test arguments", () => {
  const args = shapeOf(testArguments)

  test("require only the scope", () => {
    const required = Object.entries(args)
      .filter(([, value]) => !value.optional_)
      .map(([key]) => key)
    expect(required).toEqual([...REQUIRED_ARGUMENTS.xcode_test])
  })

  test("leave every resolvable setting optional", () => {
    for (const key of ["container", "scheme", "destination", "timeoutSeconds"]) {
      expect(args[key]?.optional_).toBe(true)
    }
  })

  test("declare the scope as a union, not a stringly-typed field", () => {
    expect(args["scope"]?.kind).toBe("union")
    expect(args["scope"]?.options?.map((option) => option.kind)).toEqual(["object", "object"])
  })

  test("keep the shape flat, with unions inside individual arguments", () => {
    for (const value of Object.values(args)) {
      expect(["union", "string", "integer"]).toContain(value.kind)
    }
  })

  test("bound the timeout to the contract's range", () => {
    expect(args["timeoutSeconds"]?.bounds).toEqual({ min: 1, max: 7_200 })
  })

  test("describe every argument, since the description is all a model sees", () => {
    for (const [key, value] of Object.entries(args)) {
      expect(`${key}:${value.described ?? ""}`.length).toBeGreaterThan(key.length + 10)
    }
  })
})

describe("xcode_test_inspect arguments", () => {
  const args = shapeOf(inspectArguments)

  test("require only the run id and the facet", () => {
    const required = Object.entries(args)
      .filter(([, value]) => !value.optional_)
      .map(([key]) => key)
    expect(required.sort()).toEqual([...REQUIRED_ARGUMENTS.xcode_test_inspect].sort())
  })

  test("constrain the facet to the closed set", () => {
    expect(args["facet"]?.kind).toBe("enum")
    expect(args["facet"]?.values).toEqual(INSPECTION_FACETS)
  })

  test("bound the page size and the log chunk to the contract's caps", () => {
    expect(args["limit"]?.bounds).toEqual({ min: 1, max: 100 })
    expect(args["maxBytes"]?.bounds).toEqual({ min: 1, max: 65_536 })
  })
})

describe("xcode_test_recover arguments", () => {
  test("are empty, because recovery has nothing to parameterize", () => {
    // Inventing a ceremonial argument would only invite a model to supply
    // something that cannot matter.
    expect(shapeOf(recoverArguments)).toEqual({})
    expect(REQUIRED_ARGUMENTS.xcode_test_recover).toEqual([])
  })
})
