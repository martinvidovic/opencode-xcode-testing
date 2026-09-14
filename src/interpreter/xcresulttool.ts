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
 * Output is **streamed into a private file**, not collected in memory. A
 * synchronous read carries a fixed output-buffer ceiling, and a large valid
 * suite's test hierarchy runs to many megabytes — silently truncating it would
 * turn a perfectly good Result Bundle into an unsupported schema. Streaming
 * also keeps the deadline meaningful: a blocking read cannot be interrupted
 * when it expires.
 *
 * Staging it on disk rather than in an array of chunks is what makes the bound
 * honest. Accumulating means holding the payload once as chunks, again as one
 * buffer, again as a string, and once more as objects — four copies of
 * something whose size nothing here controls, which is why the old ceiling had
 * to be small enough to reject suites that were merely large. The staged file
 * costs one copy at decode time and bounds the rest against a disk.
 *
 * Every deadline here is monotonic. A structured read is bounded by a
 * *duration* the caller has already spent part of, and a duration measured
 * against a wall clock that an NTP step can move is not a duration.
 */

import { spawn } from "node:child_process"
import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

import type { XcresultCommand } from "./anomalies.ts"
import type { ToolchainIdentity, XcresultResponse, XcresultTool } from "./ports.ts"
import { monotonicNow } from "../domain/clock.ts"
import { MAX_STAGED_PAYLOAD_BYTES } from "../domain/limits.ts"
import { REQUESTED_SCHEMA_VERSION } from "./schema.ts"

/**
 * The argument vectors, fixed per command.
 *
 * Nothing here is model-supplied. One command takes a subject — the Xcode test
 * identifier a detail read is about — and it arrives from Xcode's own payload,
 * never from a request. It is still passed as `--test-id=<value>` rather than
 * as two words, so a value beginning with a dash is a value and not a flag.
 */
export function argumentsFor(
  command: XcresultCommand,
  bundlePath: string,
  subject?: string,
): string[] {
  const common = ["--path", bundlePath]
  switch (command) {
    case "metadata get":
      return ["metadata", "get", ...common]
    case "get test-results test-details":
      // A missing subject is a defect in the caller, not a read of every
      // test: an empty `--test-id=` would look like a valid argument and
      // return something, which is the worst of both.
      if (subject === undefined || subject.length === 0) {
        throw new Error("a test-details read requires the test it is about")
      }
      return schemaPinned(command.split(" "), [...common, `--test-id=${subject}`])
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
  /**
   * Where a read stages its output. Defaults to the directory holding the
   * bundle, which in production is the run's own `0700` directory — so the
   * default is private for the same reason the evidence beside it is, and a
   * staged file cannot outlive the run whose retention sweeps that directory.
   */
  stagingDir?: string
}): XcresultTool {
  const stagingDir = input.stagingDir ?? dirname(input.bundlePath)

  return {
    identity: input.identity,

    run(command: XcresultCommand, budgetMs: number, subject?: string): Promise<XcresultResponse> {
      if (!existsSync(input.bundlePath)) {
        return Promise.resolve({
          ok: false,
          failure: "bundleMissing",
          message: "the expected Result Bundle does not exist",
        })
      }
      return read({
        identity: input.identity,
        bundlePath: input.bundlePath,
        stagingDir,
        command,
        budgetMs,
        ...(subject === undefined ? {} : { subject }),
      })
    }
  }
}

/**
 * A staged file nothing else can be holding.
 *
 * Opened `wx` at mode `0600`: exclusive creation refuses an existing path rather
 * than writing through it, so a name that somehow already exists — a leftover,
 * a link planted by something else — fails the read instead of silently
 * becoming its output.
 */
let stagedReads = 0
function stagedPath(stagingDir: string): string {
  stagedReads += 1
  return join(stagingDir, `.xcresult-read-${process.pid}-${stagedReads}.json`)
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

type StagedRead = {
  identity: ToolchainIdentity
  bundlePath: string
  stagingDir: string
  command: XcresultCommand
  budgetMs: number
  subject?: string
}

function read(input: StagedRead): Promise<XcresultResponse> {
  return new Promise((resolve) => {
    const { command } = input
    const staged = stagedPath(input.stagingDir)

    // Its own process group, so a read that has to be stopped is stopped
    // whole — `xcresulttool` spawns helpers, and signalling only the parent
    // leaves them behind holding the bundle open.
    const child = spawn(
      input.identity.xcresulttoolPath,
      argumentsFor(command, input.bundlePath, input.subject),
      {
        env: { ...process.env, DEVELOPER_DIR: input.identity.developerDirectory },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    )

    const budgetMs = Math.max(1, input.budgetMs)
    const deadline = monotonicNow() + budgetMs
    const sink = createWriteStream(staged, { flags: "wx", mode: 0o600 })
    let stagedBytes = 0
    let settled = false

    const finish = (response: XcresultResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sink.destroy()
      // The staged file is scratch, not evidence: it is removed on every exit
      // from this read, including the ones nobody plans for.
      rmSync(staged, { force: true })
      resolve(response)
    }

    const timedOut = (): XcresultResponse => ({
      ok: false,
      failure: "timedOut",
      message: "the structured read exceeded its remaining budget",
    })

    // The remaining budget is the caller's, and a read that outlives it is
    // stopped rather than left to finish into a deadline that has passed.
    // Escalation is bounded and ordered: ask, then insist.
    const timer = setTimeout(() => {
      stopGroup(child.pid, "SIGTERM")
      setTimeout(() => stopGroup(child.pid, "SIGKILL"), ESCALATION_GRACE_MS).unref?.()
      finish(timedOut())
    }, budgetMs)

    sink.on("error", () =>
      finish({
        ok: false,
        failure: "commandFailed",
        message: "the structured output could not be staged for reading",
      }),
    )

    // Backpressure is the whole point of staging. Writing without it would
    // queue whatever the disk has not taken yet in memory, which is the cost
    // the staged file exists to avoid.
    sink.on("drain", () => child.stdout?.resume())

    child.stdout?.on("data", (chunk: Buffer) => {
      stagedBytes += chunk.length
      if (stagedBytes > MAX_STAGED_PAYLOAD_BYTES) {
        stopGroup(child.pid, "SIGKILL")
        finish({
          ok: false,
          failure: "unsupported",
          message: `the structured output exceeded ${MAX_STAGED_PAYLOAD_BYTES} bytes`,
        })
        return
      }
      if (!sink.write(chunk)) child.stdout?.pause()
    })

    child.on("error", () =>
      finish({
        ok: false,
        failure: "commandFailed",
        message: "xcresulttool could not be started",
      }),
    )

    child.on("close", (status) => {
      if (settled) return

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

      // Everything written has to reach the disk before it can be read back;
      // a decode that raced the last write would report a valid payload as
      // unparseable.
      sink.end(() => finish(decodeStaged(staged, deadline)))
    })
  })
}

/**
 * Turn a staged file into a payload, or into the reason it could not be one.
 *
 * The deadline is checked here as well as around the wait, because decoding is
 * real work: a payload that spent its whole budget arriving must not then
 * spend another one being understood.
 */
function decodeStaged(staged: string, deadline: number): XcresultResponse {
  if (monotonicNow() >= deadline) {
    return {
      ok: false,
      failure: "timedOut",
      message: "the structured read exceeded its remaining budget",
    }
  }

  let text: string
  try {
    text = readFileSync(staged, "utf8")
  } catch {
    // Reaching this means output that was staged successfully cannot be read
    // back, or is larger than this runtime can hold as a single string. Either
    // way it is output this tool cannot work with, which is what
    // `unsupported` says — and it says it with the size, so the message is
    // about the suite rather than about the schema.
    return {
      ok: false,
      failure: "unsupported",
      message: "the structured output could not be read back from its staged file",
    }
  }

  try {
    return { ok: true, payload: JSON.parse(text) }
  } catch {
    return {
      ok: false,
      failure: "unsupported",
      message: "the structured output could not be parsed as JSON",
    }
  }
}
