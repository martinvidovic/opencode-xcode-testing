/**
 * The three V2 tool definitions (issue #141).
 *
 * Everything `plugin.ts` hands to `ctx.tool.transform`, built without
 * importing the host so the adapter test layer can exercise it directly. The
 * plugin entrypoint stays a thin wire between host handles and this.
 *
 * Three host facts verified under issue #140 shape every definition here:
 *
 * - **No namespace.** The effective tool name is the permission action, so a
 *   namespace would rename every key an agent allowlists — `xcode_test` must
 *   stay `xcode_test`.
 * - **Out of Code Mode.** A tool registered with default options is offered to
 *   a model only through `execute`. A restricted agent has `execute` denied —
 *   granting it would be authority it does not need — so with the default it
 *   would see no Test Tool at all. `codemode: false` makes each tool a
 *   first-class, separately-deniable tool.
 * - **Text content only.** What the model reads is the result's text content.
 *   No `metadata` is attached: there is nothing in it the model needs, and it
 *   is one more place a private path could ride along unexamined.
 */

import type { InspectArguments, TestArguments } from "./args.ts"
import { descriptionFor, type ToolId } from "./descriptions.ts"
import { inspectInputSchema, recoverInputSchema, testInputSchema, type JsonSchema } from "./schema.ts"
import { executeInspect, executeRecover, executeTest, type ToolContext, type ToolDeps } from "./tools.ts"

export type ToolResult = { content: ReadonlyArray<{ type: "text"; text: string }> }

export type ToolDefinition = {
  name: ToolId
  description: string
  input: JsonSchema
  options: { codemode: false }
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

export function toolDefinitions(deps: ToolDeps): ToolDefinition[] {
  return [
    // The host has validated `input` against the schema; `args.ts` and the
    // domain validate it again, which is why the casts below are not trusted.
    define("xcode_test", testInputSchema, (input, context) => executeTest(input as TestArguments, context, deps)),
    define("xcode_test_inspect", inspectInputSchema, (input, context) =>
      executeInspect(input as InspectArguments, context, deps),
    ),
    define("xcode_test_recover", recoverInputSchema, (_input, context) => executeRecover({}, context, deps)),
  ]
}

function define(
  name: ToolId,
  input: JsonSchema,
  run: (input: unknown, context: ToolContext) => Promise<string>,
): ToolDefinition {
  return {
    name,
    description: descriptionFor(name),
    input,
    options: { codemode: false },
    async execute(input, context) {
      return { content: [{ type: "text", text: await run(input, context) }] }
    },
  }
}
