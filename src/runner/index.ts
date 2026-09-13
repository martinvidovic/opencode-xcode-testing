/**
 * The Xcode runner: admission, supervision, artifacts, retention and recovery.
 *
 * Host-agnostic by construction — it imports the domain and `node:*` and never
 * `@opencode-ai/plugin` in any form, so ADR 0001's runner test layer needs no
 * host to drive it. The supervisor entrypoint lives here too, and imports only
 * `domain` and `runner` code, because it must outlive the adapter call that
 * started it.
 */

export * from "./control.ts"
export * from "./discovery.ts"
export * from "./gate.ts"
export * from "./housekeeping.ts"
export * from "./identity.ts"
export * from "./locks.ts"
export * from "./paths.ts"
export * from "./queue.ts"
export * from "./recovery.ts"
export * from "./resolution.ts"
export * from "./retention.ts"
export * from "./state.ts"
export * from "./supervisor.ts"
export * from "./termination.ts"
export * from "./xcodebuild.ts"
