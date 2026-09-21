/**
 * The Test Run request and project configuration contract (#6), plus the
 * provenance a resolved setting carries into every result.
 */

import { DEFAULT_TIMEOUT_SECONDS } from "./limits.ts"
import type { RequestedScope } from "./scope.ts"

/** The Xcode container a Test Run builds from. Paths are repository-relative. */
export type XcodeContainer =
  | { kind: "workspace"; path: string }
  | { kind: "project"; path: string }

/** Exactly one destination per Test Run. An omitted `os` stays omitted. */
export type Destination =
  | { kind: "id"; id: string }
  | { kind: "named"; platform: string; name: string; os?: string }

/** What a caller asks a Test Run to execute. `requestedScope` is always required. */
export type TestRunRequest = {
  requestedScope: RequestedScope
  xcodeContainer?: XcodeContainer
  scheme?: string
  destination?: Destination
  timeoutSeconds?: number
}

/** DerivedData is tool-managed; only the mode is configurable. */
export type DerivedDataMode = "shared" | "isolated"

export const DERIVED_DATA_MODES = ["shared", "isolated"] as const

/**
 * `<configuration-root>/.opencode/xcode-test.json`. Per ADR 0002 its presence is the
 * per-project enablement marker; its fields remain optional. `xcodeContainer.path`
 * is the exception among configured paths: it resolves from the Containment Root.
 */
export type ProjectConfiguration = {
  schemaVersion: 1
  xcodeContainer?: XcodeContainer
  scheme?: string
  destination?: Destination
  derivedData?: { mode: DerivedDataMode }
  timeoutSeconds?: number
  /** Machine-local per ADR 0002. A relative value resolves against the configuration root. */
  runtime?: string
}

/** Where a resolved setting came from. Retained so a result can explain itself. */
export type SettingProvenance = "request" | "configuration" | "discovery" | "default"

export const SETTING_PROVENANCES = [
  "request",
  "configuration",
  "discovery",
  "default",
] as const

/** A resolved setting paired with the source that supplied it. */
export type Resolved<T> = { value: T; provenance: SettingProvenance }

/**
 * The immutable contract resolution produces before anything is spawned.
 * It carries no absolute paths — those belong to the runner, not to a result.
 */
export type ResolvedTestRun = {
  xcodeContainer: Resolved<XcodeContainer>
  scheme: Resolved<string>
  destination: Resolved<Destination>
  derivedData: Resolved<{ mode: DerivedDataMode }>
  timeoutSeconds: Resolved<number>
}

/** The timeout a Test Run gets when neither request nor configuration says. */
export const DEFAULT_TIMEOUT: Resolved<number> = {
  value: DEFAULT_TIMEOUT_SECONDS,
  provenance: "default",
}

/** Directory names container discovery never descends into. */
export const DISCOVERY_EXCLUDED_DIRECTORIES = [
  ".git",
  ".opencode",
  ".build",
  "DerivedData",
  "Pods",
  "Carthage",
  "node_modules",
] as const
