/**
 * ADR 0001 Layer 1: drive the interpreter from committed synthetic payloads.
 *
 * Every fixture carries structured provenance rather than a prose comment, so
 * the freshness check can map an observed schema drift straight onto the
 * fixtures and normalization paths it affects.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { ResolvedTestRun } from "../../src/domain/request.ts"
import type { RequestedScope } from "../../src/domain/scope.ts"
import type { XcresultCommand } from "../../src/interpreter/anomalies.ts"
import {
  interpretRun,
  type InterpretationRequest,
  type InterpretedRun,
} from "../../src/interpreter/interpret.ts"
import type {
  ExecutionFacts,
  MonotonicClock,
  ToolchainIdentity,
  XcresultFailure,
  XcresultResponse,
  XcresultTool,
} from "../../src/interpreter/ports.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { REQUESTED_SCHEMA_VERSION } from "../../src/interpreter/schema.ts"

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "xcresult")

/**
 * A minimal index, valid in every field, for tests about what a *reader* does
 * with one.
 *
 * Interpreting a fixture is the right way to test what the interpreter
 * produces; it is a slow and indirect way to ask what happens to a hundred
 * stack frames. This is here rather than in one test file because two of them
 * already wanted it, and two hand-built indexes drift apart in exactly the
 * fields nobody is looking at.
 */
export function syntheticIndex(overrides: Partial<NormalizedIndex> = {}): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId: "run-1",
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [],
    testFailures: [],
    buildErrors: [],
    attestations: [],
    scopeVerdict: "unverifiable",
    scopeDigest: "d",
    requestedSelectionCount: 0,
    observedOutsideScope: 0,
    build: { completeness: "complete" },
    tests: { completeness: "complete" },
    diagnostics: { completeness: "complete" },
    fullMessages: {},
    toolchain: {
      developerDirectory: "/x",
      xcodeVersion: "26.4.1",
      xcodeBuild: "17E202",
      xcresulttoolPath: "/x/t",
      xcresulttoolVersion: "24757",
      xcresulttoolDigest: "digest",
      schemaVersion: "0.1.0",
    },
    log: { availability: "unavailable", retainedBytesExact: false },
    bundleDigestVerified: "yes",
    ...overrides,
  }
}

/** The structured provenance every fixture must carry. */
export type FixtureProvenance = {
  scenario: string
  schemaVersion: string
  decoderVersion: number
  xcresulttoolVersion: string
  legacyCommandsFormatVersion: string
  xcodeVersion: string
  xcodeBuild: string
  observedShape: string
  defect?: string
  note?: string
}

export type Fixture = {
  provenance: FixtureProvenance
  payloads: Partial<Record<XcresultCommand, unknown>>
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => name.replace(/\.json$/, ""))
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as Fixture
}

/** The toolchain identity the fixtures are keyed to. Paths are fictional. */
export function identityFor(fixture: Fixture): ToolchainIdentity {
  return {
    developerDirectory: "/opt/toolchain/Xcode.app/Contents/Developer",
    xcodeVersion: fixture.provenance.xcodeVersion,
    xcodeBuild: fixture.provenance.xcodeBuild,
    xcresulttoolPath: "/opt/toolchain/Xcode.app/Contents/Developer/usr/bin/xcresulttool",
    xcresulttoolVersion: fixture.provenance.xcresulttoolVersion,
    xcresulttoolDigest: "a".repeat(64),
    schemaVersion: fixture.provenance.schemaVersion,
  }
}

/**
 * A reader over one fixture. Commands the fixture does not define fail as
 * `commandFailed`, which is what a bundle that genuinely lacks them would do —
 * and which keeps a test from accidentally passing on an empty payload.
 */
export function readerFor(
  fixture: Fixture,
  overrides: {
    identity?: ToolchainIdentity
    failures?: Partial<Record<XcresultCommand, XcresultFailure>>
    onRun?: (command: XcresultCommand, budgetMs: number) => void
    /**
     * Serve this payload instead of the fixture's, for one command.
     *
     * Shapes a committed fixture does not carry — a malformed hierarchy, a
     * node Xcode would only emit under an unusual configuration — are exactly
     * the ones worth interpreting end to end, and committing a fixture for
     * each would commit a fixture for every defect.
     */
    payloads?: Partial<Record<XcresultCommand, unknown>>
  } = {},
): XcresultTool & { calls: XcresultCommand[] } {
  const calls: XcresultCommand[] = []
  return {
    calls,
    identity: overrides.identity ?? identityFor(fixture),
    async run(command: XcresultCommand, budgetMs: number): Promise<XcresultResponse> {
      calls.push(command)
      overrides.onRun?.(command, budgetMs)
      const failure = overrides.failures?.[command]
      if (failure !== undefined) return { ok: false, failure, message: `stub: ${failure}` }
      const replaced = overrides.payloads?.[command]
      if (replaced !== undefined) return { ok: true, payload: replaced }
      if (!(command in fixture.payloads)) {
        return { ok: false, failure: "commandFailed", message: "the fixture defines no payload" }
      }
      return { ok: true, payload: fixture.payloads[command] }
    },
  }
}

/** A clock that advances by a fixed step on every read. */
export function steppingClock(stepMs = 0): MonotonicClock {
  let now = 0
  return {
    now() {
      const value = now
      now += stepMs
      return value
    },
  }
}

export const RESOLVED: ResolvedTestRun = {
  xcodeContainer: { value: { kind: "project", path: "Example.xcodeproj" }, provenance: "discovery" },
  scheme: { value: "App", provenance: "discovery" },
  destination: {
    value: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
    provenance: "configuration",
  },
  derivedData: { value: { mode: "shared" }, provenance: "default" },
  timeoutSeconds: { value: 900, provenance: "default" },
}

export const CONTAINMENT_ROOT = "/workspace"

export function factsFor(fixture: Fixture, overrides: Partial<ExecutionFacts> = {}): ExecutionFacts {
  return {
    runId: "run-0000",
    containmentRoot: CONTAINMENT_ROOT,
    resultBundlePresent: true,
    bundleDigestVerified: "yes",
    toolchain: identityFor(fixture),
    log: { retainedBytes: 4096, retainedBytesExact: true },
    ...overrides,
  }
}

export type ScenarioOverrides = {
  scope?: RequestedScope
  facts?: Partial<ExecutionFacts>
  request?: Partial<InterpretationRequest>
  reader?: Parameters<typeof readerFor>[1]
}

/** Interpret one fixture under the defaults a successful run would produce. */
export function interpretFixture(
  name: string,
  overrides: ScenarioOverrides = {},
): Promise<InterpretedRun> {
  const fixture = loadFixture(name)
  const tool = readerFor(fixture, overrides.reader)

  return interpretRun({
    facts: factsFor(fixture, overrides.facts),
    requestedScope: overrides.scope ?? { kind: "all" },
    resolved: RESOLVED,
    timing: {
      admittedAt: "2026-09-13T10:00:00.000Z",
      queueDurationMs: 0,
      startedAt: "2026-09-13T10:00:00.100Z",
      startupDurationMs: 100,
      processDurationMs: 4_000,
      elapsedBeforeInterpretationMs: 4_100,
    },
    terminationTrigger: "none",
    termination: {
      requested: "no",
      gracefulTerminationObserved: "unknown",
      forceEscalationRequired: "no",
      terminationGraceExceeded: "no",
      descendantsConfirmedExited: "yes",
    },
    execution: { execObserved: "yes", exitCode: 0, successfulExit: "yes" },
    tool,
    clock: steppingClock(),
    ...overrides.request,
  })
}

/** The exit facts of a process that `xcodebuild` failed. */
export const FAILED_EXIT = {
  execObserved: "yes",
  exitCode: 65,
  successfulExit: "no",
} as const

export { REQUESTED_SCHEMA_VERSION }

/**
 * The Focused Detail a test asking for one is about having.
 *
 * `Focused<T>.focused` is optional because an oversized record can be shed
 * down to nothing — a real outcome, with tests of its own. Everywhere else its
 * absence would mean the test never examined what it says it examines, so it
 * is asserted once here rather than checked at every use or, worse, assumed.
 */
export function present<T>(view: { focused?: T }): T {
  if (view.focused === undefined) throw new Error("expected a Focused Detail, and there was none")
  return view.focused
}

/**
 * The records on a facet page, which a test paging through one is about.
 *
 * `FacetPage` is a union — records, a Focused Detail, a Log Chunk, an omission —
 * and only one arm has records. Narrowed here so a test that asked for a
 * records page and got something else fails saying so, rather than reading a
 * property off whichever arm arrived.
 */
export function recordsOf(page: unknown): Array<{ id: string }> {
  const view = page as { view?: string; records?: Array<{ id: string }> }
  if (view?.view !== "records" || view.records === undefined) {
    throw new Error(`expected a records page, got ${String(view?.view)}`)
  }
  return view.records
}
