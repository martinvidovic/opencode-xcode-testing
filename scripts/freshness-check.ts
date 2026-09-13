#!/usr/bin/env bun
/**
 * The freshness check (ADR 0001, Layer 3).
 *
 * It answers one question: does the Xcode on this machine still match the
 * toolchain the committed fixtures were keyed to? Drift there does not make the
 * tool wrong — it makes the fixtures stale — so this **reports** rather than
 * fails. A check that broke the build on a routine Xcode update would be
 * disabled within a week, and then it would tell nobody anything.
 *
 * Output is machine-readable and maps observed facts onto the fixtures they
 * affect, via each fixture's structured provenance.
 *
 * Usage: bun scripts/freshness-check.ts [--fixtures <directory>] [--json]
 */

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const DEFAULT_FIXTURE_DIR = join(import.meta.dir, "..", "test", "fixtures", "xcresult")

export type ObservedToolchain = {
  xcodeVersion?: string
  xcodeBuild?: string
  xcresulttoolVersion?: string
  schemaVersion?: string
  /** Set when the toolchain could not be observed at all. */
  unavailable?: string
}

export type Drift = {
  fact: "xcodeVersion" | "xcodeBuild" | "xcresulttoolVersion" | "schemaVersion"
  expected: string
  observed: string
  /** The fixtures keyed to the expected value, and so affected by the drift. */
  affectedFixtures: string[]
}

export type FreshnessReport = {
  status: "fresh" | "drifted" | "unavailable"
  observed: ObservedToolchain
  drift: Drift[]
  fixturesChecked: number
}

type FixtureProvenance = {
  scenario?: string
  xcodeVersion?: string
  xcodeBuild?: string
  xcresulttoolVersion?: string
  schemaVersion?: string
}

/** Read the provenance every Layer 1 fixture carries, keyed by fixture name. */
export function readFixtureProvenance(directory: string): Record<string, FixtureProvenance> {
  const provenance: Record<string, FixtureProvenance> = {}
  let entries: string[]
  try {
    entries = readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
  } catch {
    return provenance
  }

  for (const entry of entries) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, entry), "utf8"))
      const record = (parsed as { provenance?: FixtureProvenance }).provenance
      if (record !== undefined) provenance[entry.replace(/\.json$/, "")] = record
    } catch {
      // A fixture that cannot be read is a test failure elsewhere, not here.
    }
  }
  return provenance
}

/**
 * Observe the toolchain the same way #8 requires interpretation to: through
 * `xcodebuild -version` and `xcresulttool version`, never by assuming.
 */
export function observeToolchain(
  run: (command: string, args: string[]) => { status: number | null; stdout: string } = execute,
): ObservedToolchain {
  const xcodebuild = run("/usr/bin/xcodebuild", ["-version"])
  if (xcodebuild.status !== 0) {
    return { unavailable: "xcodebuild is not available on this machine" }
  }

  const versionLine = /Xcode\s+([0-9][0-9.]*)/.exec(xcodebuild.stdout)
  const buildLine = /Build version\s+(\S+)/.exec(xcodebuild.stdout)

  const xcresulttool = run("/usr/bin/xcrun", ["xcresulttool", "version"])
  const toolVersion = /version\s+(\d+)/i.exec(xcresulttool.stdout)
  const schemaVersion = /schema\s+version\s+([0-9.]+)/i.exec(xcresulttool.stdout)

  return {
    ...(versionLine?.[1] === undefined ? {} : { xcodeVersion: versionLine[1] }),
    ...(buildLine?.[1] === undefined ? {} : { xcodeBuild: buildLine[1] }),
    ...(toolVersion?.[1] === undefined ? {} : { xcresulttoolVersion: toolVersion[1] }),
    ...(schemaVersion?.[1] === undefined ? {} : { schemaVersion: schemaVersion[1] }),
  }
}

function execute(command: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

const FACTS = ["xcodeVersion", "xcodeBuild", "xcresulttoolVersion", "schemaVersion"] as const

/** Compare what the fixtures claim against what this machine actually has. */
export function compare(
  observed: ObservedToolchain,
  provenance: Record<string, FixtureProvenance>,
): FreshnessReport {
  const fixturesChecked = Object.keys(provenance).length

  if (observed.unavailable !== undefined) {
    return { status: "unavailable", observed, drift: [], fixturesChecked }
  }

  const drift: Drift[] = []

  for (const fact of FACTS) {
    const actual = observed[fact]
    if (actual === undefined) continue

    const expectations = new Map<string, string[]>()
    for (const [name, record] of Object.entries(provenance)) {
      const expected = record[fact]
      if (expected === undefined) continue
      expectations.set(expected, [...(expectations.get(expected) ?? []), name])
    }

    for (const [expected, affectedFixtures] of expectations) {
      // Xcode's product version is compared by major: a point release does not
      // invalidate fixtures keyed to the major the decoders claim.
      const matches = fact === "xcodeVersion" ? sameMajor(expected, actual) : expected === actual
      if (!matches) {
        drift.push({ fact, expected, observed: actual, affectedFixtures: affectedFixtures.sort() })
      }
    }
  }

  return {
    status: drift.length === 0 ? "fresh" : "drifted",
    observed,
    drift: drift.sort((a, b) => a.fact.localeCompare(b.fact)),
    fixturesChecked,
  }
}

function sameMajor(a: string, b: string): boolean {
  return a.split(".")[0] === b.split(".")[0]
}

export function render(report: FreshnessReport): string {
  if (report.status === "unavailable") {
    return `freshness: unavailable — ${report.observed.unavailable ?? "the toolchain could not be observed"}\n`
  }
  if (report.status === "fresh") {
    return `freshness: fresh — ${report.fixturesChecked} fixtures match the observed toolchain\n`
  }

  const lines = [`freshness: drifted — ${report.drift.length} fact(s) no longer match`]
  for (const entry of report.drift) {
    lines.push(
      `  ${entry.fact}: fixtures expect ${entry.expected}, this machine reports ${entry.observed}`,
      `    affected: ${entry.affectedFixtures.join(", ")}`,
    )
  }
  return `${lines.join("\n")}\n`
}

export function runFreshnessCheck(directory = DEFAULT_FIXTURE_DIR): FreshnessReport {
  return compare(observeToolchain(), readFixtureProvenance(directory))
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const at = argv.indexOf("--fixtures")
  const directory = at === -1 ? DEFAULT_FIXTURE_DIR : (argv[at + 1] ?? DEFAULT_FIXTURE_DIR)

  const report = runFreshnessCheck(directory)
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : render(report))

  // Non-fatal by design: drift is surfaced, never a reason to fail the gate.
  process.exitCode = 0
}
