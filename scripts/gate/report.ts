/**
 * The durable run report (ADR 0001).
 *
 * Written **by construction** to the tool-managed storage root, never anywhere
 * the repository could accidentally track. That is a structural guarantee
 * rather than a convention, and it is load-bearing: a `--project` report
 * contains private project facts — schemes, destinations, paths — and a
 * convention that merely says "do not commit this" is a convention that is
 * eventually broken by a `git add -A`.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { TOOL_DIRECTORY } from "../../src/runner/paths.ts"
import type { Suite } from "./options.ts"

export type ScenarioResult = {
  name: string
  /** `gating` scenarios fail the gate; `report-only` ones never do. */
  kind: "gating" | "report-only"
  status: "passed" | "failed" | "skipped"
  detail: string
  durationMs?: number
}

export type RunReport = {
  schemaVersion: 1
  startedAt: string
  finishedAt: string
  /**
   * The suites this invocation selected, whether or not any of them ran.
   *
   * Recorded because "passed" means nothing without it: a report that listed
   * only the scenarios that executed could not distinguish a full gate from
   * one that selected a single suite, and the difference is the whole claim.
   */
  selected: Suite[]
  /**
   * Whether a real project was supplied. Deliberately a boolean: a project
   * path is a private fact about someone's machine, and the report says that
   * the standing gate was not what ran without naming where it ran instead.
   */
  project?: boolean
  /** The observed toolchain identity facts (#8), minus the private digest. */
  toolchain: {
    xcodeVersion: string
    xcodeBuild: string
    xcresulttoolVersion: string
    schemaVersion: string
    developerDirectory: string
  }
  /** The host version the adapter observed, per ADR 0002. */
  hostVersion: string
  runtime: { path: string; version?: string; source: string }
  destination: { deviceName: string; runtime: string; id: string } | { unavailable: string }
  freshness: unknown
  scenarios: ScenarioResult[]
  outcome: "passed" | "failed"
  /**
   * Why the run ended as it did, when there is something to say — redacted of
   * anything path-shaped before it gets here.
   *
   * Absent on a pass. Present on every failure that has a reason beyond "a
   * scenario failed", including the exceptional path, where it is the only
   * account of what happened.
   */
  diagnostic?: string
}

/** The `reports` directory inside the tool-managed storage root. */
export function reportDirectory(homeDir = homedir()): string {
  return join(homeDir, "Library", "Application Support", TOOL_DIRECTORY, "reports")
}

/**
 * Where a report lands, derived from when its run started.
 *
 * Exported so nothing has to re-derive it. A second copy of this rule is a
 * second place for it to drift, and the only thing that reads a report back is
 * something that guessed the name.
 */
export function reportPathFor(startedAt: string, homeDir = homedir()): string {
  return join(reportDirectory(homeDir), `acceptance-${startedAt.replace(/[:.]/g, "-")}.json`)
}

export function writeReport(report: RunReport, homeDir = homedir()): string {
  mkdirSync(reportDirectory(homeDir), { recursive: true, mode: 0o700 })

  const path = reportPathFor(report.startedAt, homeDir)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return path
}

/**
 * The human-readable summary, printed to stdout.
 *
 * Deliberately **not** the same content as the JSON beside it. The JSON is
 * `0600` inside tool-managed storage and may carry machine-local paths; this
 * text is what somebody pastes into an issue, so it carries none. A developer
 * directory and a runtime path say nothing a reader of that issue can act on,
 * and both name where this particular machine keeps things.
 */
export function renderReport(report: RunReport, path: string): string {
  const lines = [
    `acceptance gate: ${report.outcome}`,
    "",
    `selected       ${report.selected.join(", ") || "(nothing)"}${report.project === true ? " (against a supplied project)" : ""}`,
    `toolchain      Xcode ${report.toolchain.xcodeVersion} (${report.toolchain.xcodeBuild}), xcresulttool ${report.toolchain.xcresulttoolVersion}, schema ${report.toolchain.schemaVersion}`,
    `host           OpenCode ${report.hostVersion}`,
    `runtime        ${report.runtime.version ?? "unknown version"} [${report.runtime.source}]`,
    `destination    ${
      "unavailable" in report.destination
        ? report.destination.unavailable
        : `${report.destination.deviceName} (${report.destination.runtime})`
    }`,
    "",
    "scenarios:",
  ]

  if (report.scenarios.length === 0) lines.push("  (none ran)")

  for (const scenario of report.scenarios) {
    const mark = scenario.status === "passed" ? "ok  " : scenario.status === "failed" ? "FAIL" : "skip"
    const suffix = scenario.kind === "report-only" ? " [report-only]" : ""
    const duration = scenario.durationMs === undefined ? "" : ` ${scenario.durationMs}ms`
    lines.push(`  ${mark} ${scenario.name}${suffix}${duration}`)
    if (scenario.detail.length > 0) lines.push(`       ${scenario.detail}`)
  }

  // The reason, when there is one. It is already redacted of anything
  // path-shaped, and leaving it out of the text meant the one line explaining
  // a failure appeared only in the JSON nobody opens.
  if (report.diagnostic !== undefined) lines.push("", `diagnostic     ${report.diagnostic}`)

  // The report's own filename, not its full path: enough to find it in the
  // reports directory, and not a line that names someone's home directory.
  lines.push("", `report         ${basename(path)}`)
  return `${lines.join("\n")}\n`
}
