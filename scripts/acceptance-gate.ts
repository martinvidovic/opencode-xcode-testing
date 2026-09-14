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
import { basename } from "node:path"

import { resolveRuntime } from "../src/adapter/runtime.ts"
import { probeRuntimeCandidate, bunOnPath } from "../src/adapter/probe.ts"
import { resolveToolchain } from "../src/runner/toolchain.ts"
import { runFreshnessCheck, type BundleExamination } from "./freshness-check.ts"
import { discoverDestination, type DestinationDiscovery } from "./gate/destination.ts"
import { safeDiagnostic } from "./gate/diagnostic.ts"
import { parseOptions, usage } from "./gate/options.ts"
import { runLayer4 } from "./gate/layer4.ts"
import { runInstallationGate } from "./gate/installation.ts"
import { runRegistrationGate } from "./gate/registration.ts"
import { runExecutionGate } from "./gate/execution.ts"
import { newObservations, reportFrom, type Observations } from "./gate/observations.ts"
import { renderReport, writeReport } from "./gate/report.ts"

/**
 * Exported so the report-writing paths can be exercised without a simulator.
 * The suites themselves are gated elsewhere; what is testable here is that a
 * run records what it established as it establishes it.
 */
export async function main(argv: string[], observed: Observations): Promise<number> {
  const parsed = parseOptions(argv)

  if (parsed.status === "rejected") {
    // A refused command line still leaves a record. Someone reading the
    // reports later is trying to answer "what has this machine actually
    // verified", and an invocation that verified nothing because it was
    // mistyped is part of that answer.
    process.stderr.write(`acceptance gate: ${parsed.message}\n\n${usage()}\n`)
    writeReport(reportFrom(observed, "failed", parsed.message))
    return 2
  }

  const { suites, project } = parsed.options

  // Recorded the moment it is known, like every fact below it. Nothing here
  // waits until the end to be written down, because the end is exactly what a
  // failing run does not reach.
  observed.selected = suites
  // Claimed only when a layer that uses it actually ran: otherwise the line
  // says something the run did not do.
  if (project !== undefined && suites.includes("layer4")) observed.project = true
  observed.hostVersion = observedHostVersion()

  // Held by reference, so a scenario pushed here is a scenario the report has
  // — including a report written from a `catch` three suites later.
  const scenarios = observed.scenarios

  // Every path from here writes a report, including the ones that fail before
  // a single scenario runs. A gate invocation that left no durable trace is
  // one nobody can check afterwards, and "it failed to start" is exactly the
  // outcome most worth having a record of.
  //
  // It takes no facts of its own. Everything it reports was written down when
  // it was observed, which is what makes the exceptional path's report equal
  // to this one minus whatever had not happened yet.
  const finish = (outcome: "passed" | "failed", diagnostic?: string): number => {
    const report = reportFrom(observed, outcome, diagnostic)

    const path = writeReport(report)
    process.stdout.write(renderReport(report, path))
    if (diagnostic !== undefined) process.stderr.write(`acceptance gate: ${diagnostic}\n`)
    return outcome === "passed" ? 0 : 1
  }

  const toolchain = resolveToolchain()
  if (toolchain.status !== "resolved") return finish("failed", toolchain.message)

  observed.toolchain = {
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
  if (runtime.status !== "resolved") return finish("failed", runtime.message)

  observed.runtime = {
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
  observed.destination = { unavailable: destination.diagnostic }

  if (needsDestination) {
    destination = discoverDestination()
    observed.destination =
      destination.status === "found"
        ? {
            deviceName: destination.deviceName,
            runtime: destination.runtime,
            id: destination.destination.kind === "id" ? destination.destination.id : "",
          }
        : { unavailable: destination.diagnostic }

    // Never a silent skip: a gate that passes because it found nothing to run
    // on reports green on a machine where nothing was verified.
    if (destination.status !== "found") return finish("failed", destination.diagnostic)
  }

  const context =
    destination.status === "found"
      ? {
          toolchain: toolchain.identity,
          runtimePath: runtime.path,
          destination: destination.destination,
        }
      : undefined

  let bundle: BundleExamination | undefined
  if (suites.includes("layer4") && context !== undefined) {
    const outcome = await runLayer4({
      ...context,
      ...(project === undefined ? {} : { project }),
    })
    scenarios.push(...outcome.scenarios)
    bundle = outcome.bundle
  }
  if (suites.includes("b1")) {
    scenarios.push(...(await runRegistrationGate()))
    scenarios.push(...(await runInstallationGate()))
  }
  if (suites.includes("b2") && context !== undefined) {
    // (b2) drives the host against generated projects with known outcomes, so
    // it takes the shared context and not the project override.
    scenarios.push(...(await runExecutionGate(context)))
  }

  // A run that executed no gating scenario has verified nothing, whatever its
  // scenario list says. Reporting that as a pass is the failure mode this
  // whole file exists to prevent.
  const gating = scenarios.filter((scenario) => scenario.kind === "gating")
  if (gating.length === 0) {
    return finish("failed", "no gating scenario ran, so nothing was verified")
  }

  // Drift is surfaced in the report and never fails the gate. It examines the
  // bundle the scenarios just produced, so the check is against a real payload
  // rather than against version strings alone.
  observed.freshness = runFreshnessCheck(bundle === undefined ? { produce: true } : { bundle })

  return finish(gating.some((scenario) => scenario.status === "failed") ? "failed" : "passed")
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
  const observed = newObservations(new Date().toISOString())

  main(process.argv.slice(2), observed)
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      // The path nobody plans for, and the one most worth a record. A gate
      // that threw two minutes in has usually established a great deal — a
      // toolchain, a simulator, a dozen scenarios — and a report that called
      // all of it unobserved would be indistinguishable from one for a run
      // that never started. Everything the run got to is here already.
      const diagnostic = safeDiagnostic(error)
      process.stderr.write(`acceptance gate: ${diagnostic}\n`)

      try {
        const path = writeReport(reportFrom(observed, "failed", diagnostic))
        process.stdout.write(`report         ${basename(path)}\n`)
      } catch (failure) {
        // The report is required, so failing to write one is itself worth
        // saying out loud rather than swallowing behind the original error.
        process.stderr.write(`acceptance gate: no report could be written: ${safeDiagnostic(failure)}\n`)
      }
      process.exitCode = 1
    })
}
