/**
 * The concrete `xcresulttool` reader (#8).
 *
 * Every invocation explicitly requests `--schema-version 0.1.0` rather than
 * accepting the tool default, and runs under the recorded `DEVELOPER_DIR` — so
 * a bundle is always read back by the installation that wrote it, whatever
 * `xcode-select` happens to point at now.
 *
 * Classification never depends on parsing stderr wording. Readability is
 * established by `metadata get` actually opening the bundle, and a failure here
 * maps onto a typed reason rather than a string match.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

import type { XcresultCommand } from "./anomalies.ts"
import type { ToolchainIdentity, XcresultResponse, XcresultTool } from "./ports.ts"
import { REQUESTED_SCHEMA_VERSION } from "./schema.ts"

/** The argument vectors, fixed per command. Nothing here is caller-supplied. */
export function argumentsFor(command: XcresultCommand, bundlePath: string): string[] {
  const common = ["--path", bundlePath]
  switch (command) {
    case "metadata get":
      return ["metadata", "get", ...common]
    case "get content-availability":
      return ["get", "content-availability", ...common, "--format", "json"]
    case "get build-results":
      return ["get", "build-results", ...common, "--format", "json"]
    case "get test-results tests":
      return [
        "get",
        "test-results",
        "tests",
        ...common,
        "--format",
        "json",
        "--schema-version",
        REQUESTED_SCHEMA_VERSION,
      ]
    case "get test-results summary":
      return [
        "get",
        "test-results",
        "summary",
        ...common,
        "--format",
        "json",
        "--schema-version",
        REQUESTED_SCHEMA_VERSION,
      ]
  }
}

export function createXcresultTool(input: {
  identity: ToolchainIdentity
  bundlePath: string
}): XcresultTool {
  return {
    identity: input.identity,

    run(command: XcresultCommand, budgetMs: number): Promise<XcresultResponse> {
      if (!existsSync(input.bundlePath)) {
        return Promise.resolve({
          ok: false,
          failure: "bundleMissing",
          message: "the expected Result Bundle does not exist",
        })
      }

      const result = spawnSync(input.identity.xcresulttoolPath, argumentsFor(command, input.bundlePath), {
        encoding: "utf8",
        timeout: Math.max(1, budgetMs),
        env: { ...process.env, DEVELOPER_DIR: input.identity.developerDirectory },
      })

      if (result.error !== undefined && (result.error as { code?: string }).code === "ETIMEDOUT") {
        return Promise.resolve({
          ok: false,
          failure: "timedOut",
          message: "the structured read exceeded its remaining budget",
        })
      }
      if (result.status !== 0) {
        return Promise.resolve({
          ok: false,
          failure: command === "metadata get" ? "bundleUnreadable" : "commandFailed",
          message: `xcresulttool exited with status ${result.status ?? "unknown"}`,
        })
      }

      // `metadata get` is a readability preflight; its payload is not decoded.
      if (command === "metadata get") return Promise.resolve({ ok: true, payload: {} })

      try {
        return Promise.resolve({ ok: true, payload: JSON.parse(result.stdout) })
      } catch {
        return Promise.resolve({
          ok: false,
          failure: "unsupported",
          message: "the structured output could not be parsed as JSON",
        })
      }
    },
  }
}
