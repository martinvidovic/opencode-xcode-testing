/**
 * The shared domain vocabulary of the Test Tool, named per `CONTEXT.md`.
 *
 * This module is the one place the runner, the interpreter and the adapter all
 * depend on, and it depends on none of them. It never imports
 * `@opencode-ai/plugin` — not even type-only — so the domain stays
 * host-agnostic in source, not merely at runtime. Both properties are enforced
 * by the import lint in `test/lint/`.
 */

export * from "./evidence.ts"
export * from "./inspection.ts"
export * from "./limits.ts"
export * from "./outcome.ts"
export * from "./request.ts"
export * from "./result.ts"
export * from "./scope.ts"
export * from "./toolchain.ts"
