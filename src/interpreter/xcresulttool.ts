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
 *
 * Output is **streamed**, not collected synchronously. A synchronous read
 * carries a fixed output-buffer ceiling, and a large valid suite's test
 * hierarchy runs to many megabytes — silently truncating it would turn a
 * perfectly good Result Bundle into an unsupported schema. Streaming also keeps
 * the deadline meaningful: a blocking read cannot be interrupted when it
 * expires.
 */

import { spawn } from "node:child_process"
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
    default:
      // The command *is* its argument words; splitting it apart only to
      // reassemble it would be a second place for the two to disagree.
      return schemaPinned(command.split(" "), common)
  }
}

/**
 * Every classification-critical command names the schema explicitly. Accepting
 * the tool default would let the shape change under us between Xcode releases
 * without anything saying so.
 */
function schemaPinned(words: string[], common: string[]): string[] {
  return [...words, ...common, "--format", "json", "--schema-version", REQUESTED_SCHEMA_VERSION]
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
      return read(input.identity, input.bundlePath, command, budgetMs)
    }
  }
}

/** How long a structured read has to stop politely before it is killed. */
export const ESCALATION_GRACE_MS = 2_000

/** Signal the whole group; a negative PID addresses it. */
function stopGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

function read(
  identity: ToolchainIdentity,
  bundlePath: string,
  command: XcresultCommand,
  budgetMs: number,
): Promise<XcresultResponse> {
  return new Promise((resolve) => {
    // Its own process group, so a read that has to be stopped is stopped
    // whole — `xcresulttool` spawns helpers, and signalling only the parent
    // leaves them behind holding the bundle open.
    const child = spawn(identity.xcresulttoolPath, argumentsFor(command, bundlePath), {
      env: { ...process.env, DEVELOPER_DIR: identity.developerDirectory },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })

    const chunks: Buffer[] = []
    let settled = false
    const finish = (response: XcresultResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(response)
    }

    // The remaining budget is the caller's, and a read that outlives it is
    // stopped rather than left to finish into a deadline that has passed.
    // Escalation is bounded and ordered: ask, then insist.
    const timer = setTimeout(() => {
      stopGroup(child.pid, "SIGTERM")
      setTimeout(() => stopGroup(child.pid, "SIGKILL"), ESCALATION_GRACE_MS).unref?.()
      finish({
        ok: false,
        failure: "timedOut",
        message: "the structured read exceeded its remaining budget",
      })
    }, Math.max(1, budgetMs))

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("error", () =>
      finish({
        ok: false,
        failure: "commandFailed",
        message: "xcresulttool could not be started",
      }),
    )

    child.on("close", (status) => {
      if (status !== 0) {
        finish({
          ok: false,
          // Only the preflight speaks to readability; a later command failing
          // says the bundle could not be decoded, not that it cannot be opened.
          failure: command === "metadata get" ? "bundleUnreadable" : "commandFailed",
          message: `xcresulttool exited with status ${status ?? "unknown"}`,
        })
        return
      }

      // `metadata get` is a readability preflight; its payload is not decoded.
      if (command === "metadata get") {
        finish({ ok: true, payload: {} })
        return
      }

      try {
        finish({ ok: true, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
      } catch {
        finish({
          ok: false,
          failure: "unsupported",
          message: "the structured output could not be parsed as JSON",
        })
      }
    })
  })
}
