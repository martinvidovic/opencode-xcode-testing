/**
 * What every tool's parameter schema must look like once the host has
 * normalized it (issue #27).
 *
 * The schemas this repository ships are Zod; what a model is handed is the
 * host's JSON-Schema rendering of them. Those are not the same artifact, and
 * only the second one matters to a caller — so the gate asserts the second.
 *
 * Written as an explicit expectation rather than a snapshot of whatever the
 * host produced. A snapshot would pass the day the host started marking every
 * field required, which is the exact regression ADR 0002 records having already
 * been bitten by: under the legacy JSON-Schema fallback a model would have to
 * invent a destination on every call.
 */

export type PropertyExpectation = {
  /** `type` for a scalar, `anyOf` for a discriminated union, absent for neither. */
  type?: "string" | "integer" | "object" | "array" | "boolean"
  /** The closed set a string is restricted to, where the contract fixes one. */
  enum?: string[]
  /** Inclusive numeric bounds the contract fixes. */
  minimum?: number
  maximum?: number
  /** Number of `anyOf` branches, for a field that is a union of shapes. */
  variants?: number
  /** Every property must carry prose: it is the only thing a model reads. */
  described?: boolean
}

export type ToolExpectation = {
  required: string[]
  properties: Record<string, PropertyExpectation>
}

/**
 * The contract each tool exposes, field by field.
 *
 * `required` is the load-bearing half. Everything optional here is optional
 * because the tool can discover or default it, and a schema that demanded it
 * would force a model to guess at a value the tool already knows.
 */
export const EXPECTED_SCHEMAS: Record<string, ToolExpectation> = {
  xcode_test: {
    // Only the scope. Container, scheme and destination are discovered or
    // configured; the timeout has a default.
    required: ["scope"],
    properties: {
      scope: { variants: 2, described: true },
      container: { variants: 2, described: true },
      scheme: { type: "string", described: true },
      destination: { variants: 2, described: true },
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 7_200, described: true },
    },
  },
  xcode_test_inspect: {
    required: ["runId", "facet"],
    properties: {
      runId: { type: "string", described: true },
      facet: {
        type: "string",
        // Closed, so a model cannot ask for a facet that does not exist and
        // receive a plausible-looking empty answer.
        enum: ["scope", "failures", "buildErrors", "tests", "log"],
        described: true,
      },
      limit: { type: "integer", minimum: 1, maximum: 100, described: true },
      cursor: { type: "string", described: true },
      diagnosticId: { type: "string", described: true },
      testId: { type: "string", described: true },
      maxBytes: { type: "integer", minimum: 1, maximum: 65_536, described: true },
    },
  },
  // Recovery is a whole-root operation. An argument here would be an argument
  // a model could get wrong about somebody else's run.
  xcode_test_recover: { required: [], properties: {} },
}

type NormalizedSchema = {
  type?: unknown
  properties?: Record<string, Record<string, unknown>>
  required?: unknown
}

/** Every way this tool's normalized schema differs from its contract. */
export function schemaComplaints(toolId: string, schema: unknown): string[] {
  const expectation = EXPECTED_SCHEMAS[toolId]
  if (expectation === undefined) return [`${toolId} has no expected schema`]

  const normalized = schema as NormalizedSchema | undefined
  if (normalized === undefined || normalized.type !== "object") {
    return [`${toolId} exposed no object schema`]
  }

  const complaints: string[] = []
  const properties = normalized.properties ?? {}

  const actualNames = Object.keys(properties).sort()
  const expectedNames = Object.keys(expectation.properties).sort()
  if (actualNames.join(",") !== expectedNames.join(",")) {
    complaints.push(`${toolId} exposes ${actualNames.join(", ") || "(nothing)"}`)
  }

  const required = (Array.isArray(normalized.required) ? normalized.required : []).map(String).sort()
  if (required.join(",") !== [...expectation.required].sort().join(",")) {
    complaints.push(`${toolId} requires ${required.join(", ") || "(nothing)"}`)
  }

  for (const [name, expected] of Object.entries(expectation.properties)) {
    const actual = properties[name]
    if (actual === undefined) continue
    complaints.push(...propertyComplaints(`${toolId}.${name}`, expected, actual))
  }

  return complaints
}

function propertyComplaints(
  path: string,
  expected: PropertyExpectation,
  actual: Record<string, unknown>,
): string[] {
  const complaints: string[] = []

  if (expected.described === true && typeof actual["description"] !== "string") {
    // A field with no prose is a field a model has to guess the meaning of.
    complaints.push(`${path} carries no description`)
  }

  if (expected.type !== undefined && actual["type"] !== expected.type) {
    complaints.push(`${path} is ${String(actual["type"])}, not ${expected.type}`)
  }

  if (expected.variants !== undefined) {
    const anyOf = actual["anyOf"]
    if (!Array.isArray(anyOf) || anyOf.length !== expected.variants) {
      complaints.push(
        `${path} offers ${Array.isArray(anyOf) ? anyOf.length : 0} variants, not ${expected.variants}`,
      )
    }
  }

  if (expected.enum !== undefined) {
    const actualEnum = Array.isArray(actual["enum"]) ? actual["enum"].map(String).sort() : []
    if (actualEnum.join(",") !== [...expected.enum].sort().join(",")) {
      complaints.push(`${path} allows ${actualEnum.join(", ") || "(anything)"}`)
    }
  }

  for (const bound of ["minimum", "maximum"] as const) {
    const want = expected[bound]
    if (want !== undefined && actual[bound] !== want) {
      complaints.push(`${path} has ${bound} ${String(actual[bound])}, not ${want}`)
    }
  }

  return complaints
}
