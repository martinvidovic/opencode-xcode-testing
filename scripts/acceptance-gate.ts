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
 * With no flags it runs everything it can. A missing destination is a failure
 * with a diagnostic, never a silent skip.
 */

import { spawnSync } from "node:child_process"

import { resolveRuntime } from "../src/adapter/runtime.ts"
import { probeRuntimeCandidate, bunOnPath } from "../src/adapter/probe.ts"
import { resolveToolchain } from "../src/runner/toolchain.ts"
import { runFreshnessCheck } from "./freshness-check.ts"
import { discoverDestination } from "./gate/destination.ts"
import { runLayer4 } from "./gate/layer4.ts"
import { runRegistrationGate } from "./gate/registration.ts"
import { runExecutionGate } from "./gate/execution.ts"
import { renderReport, writeReport, type RunReport, type ScenarioResult } from "./gate/report.ts"

async function main(argv: string[]): Promise<number> {
  const only = new Set(argv.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2)))
  const wants = (name: string) => only.size === 0 || only.has(name)

  const startedAt = new Date().toISOString()
  const scenarios: ScenarioResult[] = []

  const toolchain = resolveToolchain()
  if (toolchain.status !== "resolved") {
    process.stderr.write(`acceptance gate: ${toolchain.message}\n`)
    return 1
  }

  const runtime = resolveRuntime({
    trustedRoot: process.cwd(),
    hostExecutable: process.execPath,
    ...(bunOnPath() === undefined ? {} : { pathCandidate: bunOnPath() as string }),
    probe: probeRuntimeCandidate,
  })
  if (runtime.status !== "resolved") {
    process.stderr.write(`acceptance gate: ${runtime.message}\n`)
    return 1
  }

  const destination = discoverDestination()
  if (destination.status !== "found") {
    // Never a silent skip: a gate that passes because it found nothing to run
    // on reports green on a machine where nothing was verified.
    process.stderr.write(`acceptance gate: ${destination.diagnostic}\n`)
    return 1
  }

  if (wants("layer4")) {
    scenarios.push(
      ...(await runLayer4({
        toolchain: toolchain.identity,
        runtimePath: runtime.path,
        destination: destination.destination,
      })),
    )
  }

  if (wants("b1")) scenarios.push(...(await runRegistrationGate()))

  if (wants("b2")) {
    scenarios.push(
      ...(await runExecutionGate({
        toolchain: toolchain.identity,
        runtimePath: runtime.path,
        destination: destination.destination,
      })),
    )
  }

  const failed = scenarios.some(
    (scenario) => scenario.kind === "gating" && scenario.status === "failed",
  )

  const report: RunReport = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    toolchain: {
      xcodeVersion: toolchain.identity.xcodeVersion,
      xcodeBuild: toolchain.identity.xcodeBuild,
      xcresulttoolVersion: toolchain.identity.xcresulttoolVersion,
      schemaVersion: toolchain.identity.schemaVersion,
      developerDirectory: toolchain.identity.developerDirectory,
    },
    hostVersion: observedHostVersion(),
    runtime: {
      path: runtime.path,
      ...(runtime.version === undefined ? {} : { version: runtime.version }),
      source: runtime.source,
    },
    destination: {
      deviceName: destination.deviceName,
      runtime: destination.runtime,
      id: destination.destination.kind === "id" ? destination.destination.id : "",
    },
    // Drift is surfaced in the report and never fails the gate.
    freshness: runFreshnessCheck(),
    scenarios,
    outcome: failed ? "failed" : "passed",
  }

  const path = writeReport(report)
  process.stdout.write(renderReport(report, path))
  return failed ? 1 : 0
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
