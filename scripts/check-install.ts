#!/usr/bin/env bun
/**
 * Is this checkout installed the way it says it is? (issue #143)
 *
 * Replaces the V1 `link-host-package.ts`, whose job — symlinking a
 * host-managed `@opencode-ai/plugin` into the checkout so the plugin could
 * load at all — no longer exists. On V2 the host supplies `@opencode/plugin`
 * to a plugin at runtime (issue #140), so loading needs nothing installed.
 * What the checkout does need is its own exactly pinned `@opencode/plugin`
 * and `@opencode/client`, for type-checking and for the acceptance gates.
 *
 * So this answers three questions and says what fixes each: is there an
 * OpenCode on `PATH`, and is it the version the Test Tool was validated
 * against; are the pinned packages installed; and does what is installed
 * agree with what is pinned.
 *
 * Usage: bun scripts/check-install.ts
 */

import { observedHostVersion } from "./gate/host.ts"
import { missingPackages, readProvenance } from "./gate/provenance.ts"
import { TESTED_HOST_VERSIONS } from "../src/adapter/startup.ts"

export type InstallationReport = { ready: boolean; lines: string[] }

/** What fixes a checkout whose packages disagree with what it pins. */
const FIX = "Run `bun install` in the checkout; if the host is the mismatch, install a validated OpenCode."

export function installationReport(hostVersion: string, repoRoot?: string): InstallationReport {
  const lines: string[] = []
  let ready = true

  if (hostVersion === "unknown") {
    ready = false
    lines.push(
      `host       no usable \`opencode\` on PATH. Install OpenCode ${TESTED_HOST_VERSIONS.join(" or ")} and try again.`,
    )
  } else {
    lines.push(`host       OpenCode ${hostVersion}`)
  }

  const missing = missingPackages(repoRoot)
  if (missing !== undefined) {
    ready = false
    lines.push(`packages   ${missing}`)
  }

  const { packages, problems, caveats } = readProvenance(hostVersion, repoRoot)
  if (missing === undefined) {
    lines.push(`packages   plugin ${packages.plugin.version ?? "unknown"}, client ${packages.client.version ?? "unknown"}`)
  }
  if (problems.length > 0) ready = false
  for (const problem of problems) lines.push(`problem    ${problem} ${FIX}`)
  // An unreadable host already said so above, with its fix; provenance's
  // caveat about it would only repeat that.
  if (hostVersion !== "unknown") for (const caveat of caveats) lines.push(`caveat     ${caveat}`)

  lines.push(ready ? "ready" : "not ready")
  return { ready, lines }
}

if (import.meta.main) {
  const report = installationReport(observedHostVersion())
  process.stdout.write(`${report.lines.join("\n")}\n`)
  process.exitCode = report.ready ? 0 : 1
}
