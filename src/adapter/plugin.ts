/**
 * The OpenCode V2 plugin entrypoint (issue #141).
 *
 * This is the **only** file in the codebase permitted to import
 * `@opencode/plugin`, and it is deliberately thin: it reads three host handles
 * off the context and registers whatever `prepareTools` decides. Everything
 * with a decision in it lives in `setup.ts` and below, precisely so the
 * adapter test layer can drive it with no host installed.
 *
 * The host runs `setup` once per Location and holds that Location's prompts
 * until it returns (issue #140). In a Location that has not opted in it
 * registers nothing and says nothing — "this is not an Xcode project" is a
 * normal state, not a diagnostic.
 *
 * No cleanup is returned. The tool registration is disposed by the host with
 * the plugin, and process cleanup and reconciliation are the supervisor's
 * crash-tolerant paths: nothing may depend on an unload hook running, and one
 * that signalled processes would be a hazard on every hot reload.
 */

import { Plugin } from "@opencode/plugin"

import { prepareTools } from "./setup.ts"

export default Plugin.define({
  id: "xcode-test",
  async setup(ctx) {
    const tools = await prepareTools({
      location: ctx.location,
      version: ctx.app.version,
      options: ctx.options,
    })
    if (tools.length === 0) return

    // Synchronous and replayable: the definitions are built above, and the
    // transform only hands them over.
    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool)
    })
  },
})
