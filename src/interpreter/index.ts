/**
 * The result interpreter: the only thing in this codebase allowed to say what a
 * Test Run actually did.
 *
 * It is host-agnostic by construction — it imports the domain and `node:*` and
 * nothing else, never `@opencode-ai/plugin` — and reaches the outside world
 * only through the ports in `ports.ts`, which is what lets every classification
 * branch be driven from committed synthetic payloads.
 */

export * from "./anomalies.ts"
export * from "./attestation.ts"
export * from "./classify.ts"
export * from "./cursor.ts"
export * from "./decode.ts"
export * from "./diagnostics.ts"
export * from "./ids.ts"
export * from "./index-model.ts"
export * from "./interpret.ts"
export * from "./locations.ts"
export * from "./occurrences.ts"
export * from "./paging.ts"
export * from "./ports.ts"
export * from "./schema.ts"
