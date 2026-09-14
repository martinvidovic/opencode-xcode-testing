#!/usr/bin/env bun
/**
 * The adapter-inclusive acceptance gate (ADR 0001 Layer 4, ADR 0002 (b1)/(b2)).
 *
 * This is the last gate under map #1, and passing it is what makes the map's
 * destination claimable. It runs against artifacts this repository can
 * regenerate — no committed Xcode project, nothing private — so the standing
 * gate is reproducible from committed files alone.
 *
 * Usage:
 *   bun scripts/acceptance-gate.ts [--layer4] [--b1] [--b2] [--project <path>]
 *
 * With no flags it runs everything. A missing destination is a failure with a
 * diagnostic, never a silent skip; an unknown option is refused rather than
 * ignored; and every invocation writes a durable report, including the ones
 * that fail before a scenario runs.
 */

import { spawnSync } from "node:child_process"

import { resolveRuntime } from "../src/adapter/runtime.ts"
import { probeRuntimeCandidate, bunOnPath } from "../src/adapter/probe.ts"
import { resolveToolchain } from "../src/runner/toolchain.ts"
import { runFreshnessCheck, type BundleExamination } from "./freshness-check.ts"
import { discoverDestination, type DestinationDiscovery } from "./gate/destination.ts"
import { parseOptions, usage } from "./gate/options.ts"
import { runLayer4 } from "./gate/layer4.ts"
import { runInstallationGate } from "./gate/installation.ts"
import { runRegistrationGate } from "./gate/registration.ts"
import { runExecutionGate } from "./gate/execution.ts"
import { renderReport, writeReport, type RunReport, type ScenarioResult } from "./gate/report.ts"

async function main(argv: string[]): Promise<number> {
  const parsed = parseOptions(argv)
  if (parsed.status === "rejected") {
    // Before anything else, and without a report: nothing was selected, so
    // there is no run to describe.
    process.stderr.write(`acceptance gate: ${parsed.message}\n\n${usage()}\n`)
    return 2
  }

  const { suites, project } = parsed.options
  const startedAt = new Date().toISOString()
  const scenarios: ScenarioResult[] = []

  // Every path from here writes a report, including the ones that fail before
  // a single scenario runs. A gate invocation that left no durable trace is
  // one nobody can check afterwards, and "it failed to start" is exactly the
  // outcome most worth having a record of.
  const finish = (
    outcome: "passed" | "failed",
    facts: Partial<RunReport> & { diagnostic?: string },
  ): number => {
    const report: RunReport = {
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      selected: suites,
      ...(project === undefined ? {} : { project: true }),
      toolchain: UNOBSERVED_TOOLCHAIN,
      hostVersion: observedHostVersion(),
      runtime: { path: "", source: "unresolved" },
      destination: { unavailable: "not required by the selected suites" },
      freshness: { status: "unavailable", observed: {}, drift: [], fixturesChecked: 0 },
      scenarios,
      outcome,
      ...facts,
    }

    const path = writeReport(report)
    process.stdout.write(renderReport(report, path))
    if (facts.diagnostic !== undefined) {
      process.stderr.write(`acceptance gate: ${facts.diagnostic}\n`)
    }
    return outcome === "passed" ? 0 : 1
  }

  const toolchain = resolveToolchain()
  if (toolchain.status !== "resolved") {
    return finish("failed", { diagnostic: toolchain.message })
  }
  const toolchainFacts = {
    xcodeVersion: toolchain.identity.xcodeVersion,
    xcodeBuild: toolchain.identity.xcodeBuild,
    xcresulttoolVersion: toolchain.identity.xcresulttoolVersion,
    schemaVersion: toolchain.identity.schemaVersion,
    developerDirectory: toolchain.identity.developerDirectory,
  }

  const pathCandidate = await bunOnPath()
  const runtime = await resolveRuntime({
    trustedRoot: process.cwd(),
    hostExecutable: process.execPath,
    ...(pathCandidate === undefined ? {} : { pathCandidate }),
    probe: probeRuntimeCandidate,
  })
  if (runtime.status !== "resolved") {
    return finish("failed", { toolchain: toolchainFacts, diagnostic: runtime.message })
  }
  const runtimeFacts = {
    path: runtime.path,
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
    source: runtime.source,
  }

  // Only the suites that execute tests need somewhere to run them. Discovering
  // a simulator for a registration-only run would make `--b1` fail on a
  // machine where it is perfectly capable of passing.
  const needsDestination = suites.includes("layer4") || suites.includes("b2")
  let destination: DestinationDiscovery = {
    status: "none",
    diagnostic: "not required by the selected suites",
  }
  if (needsDestination) {
    destination = discoverDestination()
    if (destination.status !== "found") {
      // Never a silent skip: a gate that passes because it found nothing to
      // run on reports green on a machine where nothing was verified.
      return finish("failed", {
        toolchain: toolchainFacts,
        runtime: runtimeFacts,
        destination: { unavailable: destination.diagnostic },
        diagnostic: destination.diagnostic,
      })
    }
  }

  const execution =
    destination.status === "found"
      ? {
          toolchain: toolchain.identity,
          runtimePath: runtime.path,
          destination: destination.destination,
          ...(project === undefined ? {} : { project }),
        }
      : undefined

  let bundle: BundleExamination | undefined
  if (suites.includes("layer4") && execution !== undefined) {
    const outcome = await runLayer4(execution)
    scenarios.push(...outcome.scenarios)
    bundle = outcome.bundle
  }
  if (suites.includes("b1")) {
    scenarios.push(...(await runRegistrationGate()))
    scenarios.push(...(await runInstallationGate()))
  }
  if (suites.includes("b2") && execution !== undefined) {
    scenarios.push(...(await runExecutionGate(execution)))
  }

  // A run that executed no gating scenario has verified nothing, whatever its
  // scenario list says. Reporting that as a pass is the failure mode this
  // whole file exists to prevent.
  const gating = scenarios.filter((scenario) => scenario.kind === "gating")
  if (gating.length === 0) {
    return finish("failed", {
      toolchain: toolchainFacts,
      runtime: runtimeFacts,
      diagnostic: "no gating scenario ran, so nothing was verified",
    })
  }

  return finish(gating.some((scenario) => scenario.status === "failed") ? "failed" : "passed", {
    toolchain: toolchainFacts,
    runtime: runtimeFacts,
    destination:
      destination.status === "found"
        ? {
            deviceName: destination.deviceName,
            runtime: destination.runtime,
            id: destination.destination.kind === "id" ? destination.destination.id : "",
          }
        : { unavailable: destination.diagnostic },
    // Drift is surfaced in the report and never fails the gate. It examines
    // the bundle the scenarios just produced, so the check is against a real
    // payload rather than against version strings alone.
    freshness: runFreshnessCheck(bundle === undefined ? {} : { bundle }),
  })
}

/** Stated as unobserved rather than blank, so a report never implies a fact. */
const UNOBSERVED_TOOLCHAIN = {
  xcodeVersion: "unobserved",
  xcodeBuild: "unobserved",
  xcresulttoolVersion: "unobserved",
  schemaVersion: "unobserved",
  developerDirectory: "unobserved",
}

/**
 * The host version the gate actually ran against. Recorded rather than
 * asserted: ADR 0002's policy is to surface skew, never to block on it.
 */
function observedHostVersion(): string {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  const version = (result.stdout ?? "").trim()
  return result.status === 0 && version.length > 0 ? version : "unknown"
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`acceptance gate: ${String(error)}\n`)
      process.exitCode = 1
    })
}
