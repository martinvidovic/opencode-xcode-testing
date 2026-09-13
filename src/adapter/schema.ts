/**
 * Argument schemas, built against an injected Zod namespace (ADR 0002).
 *
 * The host's `tool.schema` *is* Zod, and it is the one runtime import of
 * `@opencode-ai/plugin` the whole codebase is allowed. Taking the namespace as
 * a parameter keeps that import in `plugin.ts` alone, and lets the adapter test
 * layer assert the exact shape — including which arguments are optional —
 * without the host package being installed at all.
 *
 * That optionality is not a detail. The host has a legacy JSON-Schema fallback
 * which marks **every** key required; accepting it would turn container,
 * scheme, destination and timeout into mandatory arguments, and a model would
 * have to invent a destination on every call.
 */

import {
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  INSPECTION_PAGE_MAX,
  LOG_CHUNK_MAX_BYTES,
} from "../domain/limits.ts"
import { INSPECTION_FACETS } from "../domain/inspection.ts"

/**
 * The slice of Zod the tool definitions use. Structural on purpose: a stub that
 * records what it was asked for satisfies it exactly as well as the real thing.
 */
export type ZodType = {
  optional(): ZodType
  describe(text: string): ZodType
}

export type ZodNamespace = {
  string(): ZodType & { min(n: number): ZodType }
  number(): ZodType & { int(): ZodType & { min(n: number): ZodType & { max(n: number): ZodType } } }
  boolean(): ZodType
  literal(value: string): ZodType
  array(inner: ZodType): ZodType
  object(shape: Record<string, ZodType>): ZodType
  union(options: ZodType[]): ZodType
  enum(values: readonly string[]): ZodType
}

/** A flat `ZodRawShape` per tool. Unions live inside individual arguments. */
export type ArgumentShape = Record<string, ZodType>

export function testArguments(z: ZodNamespace): ArgumentShape {
  const selection = z.object({
    bundle: z.string().min(1).describe("Test bundle name, exactly as Xcode reports it."),
    suite: z.string().min(1).optional().describe("Test suite within the bundle."),
    test: z
      .string()
      .min(1)
      .optional()
      .describe("Test case within the suite, including its parentheses. Requires suite."),
  })

  return {
    scope: z
      .union([
        z.object({ kind: z.literal("all") }),
        z.object({ kind: z.literal("selected"), tests: z.array(selection) }),
      ])
      .describe(
        "What to run. Selections are exact and union together; patterns and exclusions are unsupported. Prefer the narrowest scope that covers the task.",
      ),

    container: z
      .union([
        z.object({ kind: z.literal("workspace"), path: z.string().min(1) }),
        z.object({ kind: z.literal("project"), path: z.string().min(1) }),
      ])
      .optional()
      .describe(
        "Repository-relative path to the .xcworkspace or .xcodeproj. Discovered when omitted.",
      ),

    scheme: z.string().min(1).optional().describe("Scheme to test. Discovered when omitted."),

    destination: z
      .union([
        z.object({ kind: z.literal("id"), id: z.string().min(1) }),
        z.object({
          kind: z.literal("named"),
          platform: z.string().min(1),
          name: z.string().min(1),
          os: z.string().min(1).optional(),
        }),
      ])
      .optional()
      .describe("Where to run. Taken from project configuration when omitted."),

    timeoutSeconds: z
      .number()
      .int()
      .min(MIN_TIMEOUT_SECONDS)
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe(`Deadline for the xcodebuild process. Defaults to project configuration.`),
  }
}

export function inspectArguments(z: ZodNamespace): ArgumentShape {
  return {
    runId: z.string().min(1).describe("The run id from an earlier xcode_test result."),
    facet: z.enum(INSPECTION_FACETS).describe("Which retained evidence to read."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(INSPECTION_PAGE_MAX)
      .optional()
      .describe(`Records per page. Defaults to 20, at most ${INSPECTION_PAGE_MAX}.`),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("Continue a previous page. Belongs to one run and one facet."),
    diagnosticId: z
      .string()
      .min(1)
      .optional()
      .describe("Focus one diagnostic. Cannot be combined with a cursor."),
    testId: z
      .string()
      .min(1)
      .optional()
      .describe("Focus one test. Cannot be combined with a cursor."),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(LOG_CHUNK_MAX_BYTES)
      .optional()
      .describe(`Log bytes to read. Defaults to 16 KiB, at most ${LOG_CHUNK_MAX_BYTES}.`),
  }
}

/**
 * Deliberately empty. Recovery is idempotent and bounded and always scoped to
 * the trusted root, so there is nothing to parameterize — and inventing a
 * ceremonial argument for a non-domain reason would only invite a model to
 * supply something that cannot matter.
 */
export function recoverArguments(_z: ZodNamespace): ArgumentShape {
  return {}
}

/** Which arguments each tool requires. Everything else must stay optional. */
export const REQUIRED_ARGUMENTS = {
  xcode_test: ["scope"],
  xcode_test_inspect: ["runId", "facet"],
  xcode_test_recover: [],
} as const
