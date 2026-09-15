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

import { toolRootFor } from "../../src/runner/paths.ts"
import type { Suite } from "./options.ts"
import type { ScenarioName } from "./scenarios.ts"

export type ScenarioResult = {
  /** A registered name. The registry is what makes `unreached` meaningful. */
  name: ScenarioName
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
   * Which selected suites were entered, and which finished.
   *
   * `selected` says what was asked for and `scenarios` says what happened;
   * neither says whether a suite that produced three results was meant to
   * produce three or eight. A suite entered and not completed is one whose
   * remaining scenarios were never reached. Additive, so it needs no
   * `schemaVersion` bump.
   */
  suites?: Array<{ suite: Suite; entered: true; completed: boolean }>
  /**
   * Ways the registry and this run disagree.
   *
   * Written on every path, including the ones that throw, because that is what
   * makes it a check rather than a courtesy: a scenario nobody registered
   * would otherwise land in a report with nothing to say so, and the runs
   * where that happens are precisely the ones that ended early.
   *
   * Never gating. A registry is bookkeeping about the gate, not evidence about
   * the tool, and the same argument that keeps freshness drift report-only
   * applies here.
   */
  registryProblems?: string[]
  /**
   * Scenarios the selected suites set out to run and did not reach.
   *
   * Stated rather than left to inference. `scenarios` says what happened and
   * `selected` says what was asked for; neither says which of the checks a
   * suite intended never got to run, and on an interrupted gate that is the
   * question a reader has. Additive, so it needs no `schemaVersion` bump, and
   * absent on a run that reached everything.
   */
  unreached?: ScenarioName[]
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
  /**
   * The linked OpenCode packages this run actually compiled and ran against
   * (issue #81).
   *
   * Separate from `hostVersion`, because they are separate facts and the
   * report used to carry only the least informative of them. The adapter is
   * written against `@opencode-ai/plugin` and the gates drive a host through
   * `@opencode-ai/sdk`, both resolved from a tree the host manages on its own
   * schedule — so "tested against OpenCode 1.18.29" could be true of the host
   * and false of everything the code was linked to.
   *
   * Versions and ranges only. Nothing here names a path.
   */
  packages?: {
    plugin?: string
    sdk?: string
    /** What the host's own config manifest asks for, when it asks. */
    requested?: string
    /** Skew that is supported and worth saying anyway. */
    caveats?: string[]
  }
  runtime: { path: string; version?: string; source: string }
  destination: { deviceName: string; runtime: string; id: string } | { unavailable: string }
  freshness: unknown
  scenarios: ScenarioResult[]
  outcome: "passed" | "failed"
  /**
   * The key a failed run's private evidence was filed under (issue #73).
   *
   * A key, never a path. The evidence is in the tool-managed storage root
   * under exactly this name, which is derived from `startedAt` by the same
   * rule as this report's own filename — so the correlation holds because of
   * where things are rather than because someone wrote it down correctly.
   *
   * Absent on a pass, where there is nothing to keep. Present and negative
   * when a run failed and its evidence could not be kept: a reader who goes
   * looking needs to be told it is not there and why, rather than left to
   * conclude the run was fine.
   */
  evidence?: { key: string; bytes: number } | { unavailable: string }
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
  return join(toolRootFor(homeDir), "reports")
}

/**
 * The name a run's durable artifacts are filed under, from when it started.
 *
 * One rule, used by the report's filename and by the evidence store beside it.
 * Written twice they would agree until one of them changed, and the whole
 * point of the correlation is that nobody has to keep it accurate.
 */
export function keyFor(startedAt: string): string {
  return startedAt.replace(/[:.]/g, "-")
}

/**
 * Where a report lands, derived from when its run started.
 *
 * Exported so nothing has to re-derive it. A second copy of this rule is a
 * second place for it to drift, and the only thing that reads a report back is
 * something that guessed the name.
 */
export function reportPathFor(startedAt: string, homeDir = homedir()): string {
  return join(reportDirectory(homeDir), `acceptance-${keyFor(startedAt)}.json`)
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
    `packages       ${renderPackages(report.packages)}`,
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

  if (report.registryProblems !== undefined && report.registryProblems.length > 0) {
    // Printed, not only serialized. A check nobody reads is not a check.
    lines.push("", `registry      ${report.registryProblems.join("; ")}`)
  }

  const caveats = report.packages?.caveats ?? []
  if (caveats.length > 0) {
    // Never gating, always printed. A supported-but-stale package tree is the
    // ordinary state of a host-managed install, and a run that was green
    // against a package set three minors behind the host should say so where
    // a reader sees it rather than only in JSON nobody opens.
    lines.push("", `package skew   ${caveats.join("; ")}`)
  }

  if (report.evidence !== undefined) {
    // Named in the terminal too. Evidence a reader does not know exists is
    // evidence that gets pruned before anyone looks at it. The key, and never
    // the path: a report is read by people who did not run the gate.
    lines.push(
      "",
      "unavailable" in report.evidence
        ? `evidence      not kept: ${report.evidence.unavailable}`
        : `evidence      kept under ${report.evidence.key} (${report.evidence.bytes} bytes)`,
    )
  }

  if (report.unreached !== undefined && report.unreached.length > 0) {
    // Listed, not counted. "3 not reached" leaves a reader to work out which,
    // and the which is the point.
    lines.push("", `not reached   ${report.unreached.join(", ")}`)
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


/**
 * The linked package versions, beside the host's own.
 *
 * Printed on every run, green or not. A number a reader has to go and look up
 * is a number nobody looks up, and the whole point of recording these is that
 * a green report should say what it was green against.
 */
function renderPackages(packages: RunReport["packages"]): string {
  if (packages === undefined) return "not established"
  const plugin = packages.plugin ?? "unknown"
  const sdk = packages.sdk ?? "unknown"
  const requested = packages.requested === undefined ? "" : ` (host asks for ${packages.requested})`
  return `plugin ${plugin}, sdk ${sdk}${requested}`
}
