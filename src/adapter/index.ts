/**
 * The OpenCode adapter.
 *
 * `plugin.ts` is deliberately **not** re-exported here. It is the one module
 * that imports `@opencode/plugin`, and its default export is what the host
 * loads — a barrel re-exporting it would make every importer of the adapter a
 * host entrypoint too. Everything worth testing lives in the modules below,
 * which is the point of keeping the entrypoint thin.
 */

export * from "./args.ts"
export * from "./budget.ts"
export * from "./definitions.ts"
export * from "./descriptions.ts"
export * from "./document.ts"
export * from "./output.ts"
export * from "./probe.ts"
export * from "./render.ts"
export * from "./runtime.ts"
export * from "./schema.ts"
export * from "./service.ts"
export * from "./setup.ts"
export * from "./startup.ts"
export * from "./tools.ts"
export * from "./root-roles.ts"
