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
import { join } from "node:path"

import { TOOL_DIRECTORY } from "../../src/runner/paths.ts"

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
}

/** The `reports` directory inside the tool-managed storage root. */
export function reportDirectory(homeDir = homedir()): string {
  return join(homeDir, "Library", "Application Support", TOOL_DIRECTORY, "reports")
}

export function writeReport(report: RunReport, homeDir = homedir()): string {
  const directory = reportDirectory(homeDir)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const path = join(directory, `acceptance-${report.startedAt.replace(/[:.]/g, "-")}.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return path
}

export function renderReport(report: RunReport, path: string): string {
  const lines = [
    `acceptance gate: ${report.outcome}`,
    "",
    `toolchain      Xcode ${report.toolchain.xcodeVersion} (${report.toolchain.xcodeBuild}), xcresulttool ${report.toolchain.xcresulttoolVersion}, schema ${report.toolchain.schemaVersion}`,
    `host           OpenCode ${report.hostVersion}`,
    `runtime        ${report.runtime.path}${report.runtime.version === undefined ? "" : ` (${report.runtime.version})`} [${report.runtime.source}]`,
    `destination    ${
      "unavailable" in report.destination
        ? report.destination.unavailable
        : `${report.destination.deviceName} (${report.destination.runtime})`
    }`,
    "",
    "scenarios:",
  ]

  for (const scenario of report.scenarios) {
    const mark = scenario.status === "passed" ? "ok  " : scenario.status === "failed" ? "FAIL" : "skip"
    const suffix = scenario.kind === "report-only" ? " [report-only]" : ""
    const duration = scenario.durationMs === undefined ? "" : ` ${scenario.durationMs}ms`
    lines.push(`  ${mark} ${scenario.name}${suffix}${duration}`)
    if (scenario.detail.length > 0) lines.push(`       ${scenario.detail}`)
  }

  lines.push("", `report         ${path}`)
  return `${lines.join("\n")}\n`
}
