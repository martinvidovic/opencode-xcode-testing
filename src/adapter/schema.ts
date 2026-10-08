/**
 * Input schemas, as plain JSON Schema (issue #141, superseding ADR 0002's Zod
 * rule).
 *
 * The V2 host accepts JSON Schema directly and validates a call against it
 * before the tool runs: a missing required key, an empty name or a wrong type
 * is refused with a message the model can act on, and unknown keys are
 * stripped (issue #140). That makes these the first gate a call meets — not
 * the only one: `args.ts` and the domain still validate everything they
 * receive, because a host-side check is a convenience, not a guarantee this
 * code is entitled to rely on.
 *
 * Plain data on purpose. No host package is imported, so the adapter test
 * layer can assert the exact shape — including which arguments are optional —
 * with nothing installed.
 *
 * That optionality is not a detail. Container, scheme, destination and timeout
 * are resolvable from project configuration; requiring them would make a model
 * invent a destination on every call.
 */

import {
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  INSPECTION_PAGE_MAX,
  LOG_CHUNK_MAX_BYTES,
} from "../domain/limits.ts"
import { INSPECTION_FACETS } from "../domain/inspection.ts"

/** The slice of JSON Schema these definitions use. */
export type JsonSchema = {
  type?: "object" | "string" | "integer" | "array"
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  anyOf?: JsonSchema[]
  enum?: string[]
  const?: string
  minLength?: number
  minimum?: number
  maximum?: number
}

const nonEmpty = (description?: string): JsonSchema => ({
  type: "string",
  minLength: 1,
  ...(description === undefined ? {} : { description }),
})

const integer = (minimum: number, maximum: number, description: string): JsonSchema => ({
  type: "integer",
  minimum,
  maximum,
  description,
})

/**
 * A closed object. Every property not listed in `required` is optional, which
 * is the one fact about these schemas a model depends on most.
 */
function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  }
}

/** One arm of a tagged union: `kind` fixed, the rest as given. */
function variant(kind: string, properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return object({ kind: { const: kind }, ...properties }, ["kind", ...required])
}

const selection = object(
  {
    bundle: nonEmpty("Test bundle name, exactly as Xcode reports it."),
    suite: nonEmpty("Test suite within the bundle."),
    test: nonEmpty("Test case within the suite, including its parentheses. Requires suite."),
  },
  ["bundle"],
)

export const testInputSchema: JsonSchema = object(
  {
    scope: {
      anyOf: [
        variant("all", {}),
        variant("selected", { tests: { type: "array", items: selection } }, ["tests"]),
      ],
      description:
        "What to run. Selections are exact and union together; patterns and exclusions are unsupported. Prefer the narrowest scope that covers the task.",
    },

    container: {
      anyOf: [variant("workspace", { path: nonEmpty() }, ["path"]), variant("project", { path: nonEmpty() }, ["path"])],
      description: "Repository-relative path to the .xcworkspace or .xcodeproj. Discovered when omitted.",
    },

    scheme: nonEmpty("Scheme to test. Discovered when omitted."),

    destination: {
      anyOf: [
        variant("id", { id: nonEmpty() }, ["id"]),
        variant("named", { platform: nonEmpty(), name: nonEmpty(), os: nonEmpty() }, ["platform", "name"]),
      ],
      description: "Where to run. Taken from project configuration when omitted.",
    },

    timeoutSeconds: integer(
      MIN_TIMEOUT_SECONDS,
      MAX_TIMEOUT_SECONDS,
      "Deadline for the xcodebuild process. Defaults to project configuration.",
    ),
  },
  ["scope"],
)

export const inspectInputSchema: JsonSchema = object(
  {
    runId: nonEmpty("The run id from an earlier xcode_test result."),
    facet: { type: "string", enum: [...INSPECTION_FACETS], description: "Which retained evidence to read." },
    limit: integer(1, INSPECTION_PAGE_MAX, `Records per page. Defaults to 20, at most ${INSPECTION_PAGE_MAX}.`),
    cursor: nonEmpty("Continue a previous page. Belongs to one run and one facet."),
    diagnosticId: nonEmpty("Focus one diagnostic. Cannot be combined with a cursor."),
    testId: nonEmpty("Focus one test. Cannot be combined with a cursor."),
    maxBytes: integer(1, LOG_CHUNK_MAX_BYTES, `Log bytes to read. Defaults to 16 KiB, at most ${LOG_CHUNK_MAX_BYTES}.`),
  },
  ["runId", "facet"],
)

/**
 * Deliberately empty. Recovery is idempotent and bounded and always scoped to
 * the containment root, so there is nothing to parameterize — and inventing a
 * ceremonial argument for a non-domain reason would only invite a model to
 * supply something that cannot matter.
 */
export const recoverInputSchema: JsonSchema = object({})

/** Which arguments each tool requires. Everything else must stay optional. */
export const REQUIRED_ARGUMENTS = {
  xcode_test: ["scope"],
  xcode_test_inspect: ["runId", "facet"],
  xcode_test_recover: [],
} as const
