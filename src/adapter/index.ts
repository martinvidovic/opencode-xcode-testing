/**
 * The OpenCode adapter.
 *
 * `plugin.ts` is deliberately **not** re-exported here. It is the one module
 * that imports `@opencode-ai/plugin`, and that package is installed by the host
 * into its own config directory rather than by this repository — so a test that
 * imported this barrel would fail to resolve it on a machine where OpenCode has
 * never run. Everything worth testing lives in the modules below, which is the
 * point of keeping the entrypoint thin.
 */

export * from "./args.ts"
export * from "./budget.ts"
export * from "./descriptions.ts"
export * from "./document.ts"
export * from "./output.ts"
export * from "./probe.ts"
export * from "./render.ts"
export * from "./runtime.ts"
export * from "./schema.ts"
export * from "./service.ts"
export * from "./startup.ts"
export * from "./tools.ts"
export * from "./trusted-root.ts"
