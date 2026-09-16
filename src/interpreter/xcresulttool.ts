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
 * The reading-back half lives in `staged-decode.ts`: getting bytes out of a
 * subprocess and turning a file into a payload fail in different ways and are
 * bounded by different things, so they are reasoned about separately.
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
import { randomBytes } from "node:crypto"
import { createWriteStream, existsSync, openSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

import type { XcresultCommand } from "./anomalies.ts"
import { TIMED_OUT, type ToolchainIdentity, type XcresultResponse, type XcresultTool } from "./ports.ts"
import { monotonicNow } from "../domain/clock.ts"
import { MAX_STAGED_PAYLOAD_BYTES } from "../domain/limits.ts"
import { decodeStaged } from "./staged-decode.ts"
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
}): XcresultTool {
  // The directory holding the bundle, which in production is the run's own
  // `0700` directory — so a staged file is private for the same reason the
  // evidence beside it is, and cannot outlive the run whose retention sweeps
  // that directory.
  const stagingDir = dirname(input.bundlePath)

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
        // Random, not a process id and a counter. Those repeat: a crash leaves
        // a staged file behind, the pid is eventually recycled, and the next
        // read of that bundle collides with a leftover it must not write
        // through — turning a perfectly good read into a failure.
        staged: join(stagingDir, `.xcresult-read-${randomBytes(8).toString("hex")}.json`),
        command,
        budgetMs,
        ...(subject === undefined ? {} : { subject }),
      })
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

type StagedRead = {
  identity: ToolchainIdentity
  bundlePath: string
  /** Where this read's output goes. One path, used by one read, then removed. */
  staged: string
  command: XcresultCommand
  budgetMs: number
  subject?: string
}

function read(input: StagedRead): Promise<XcresultResponse> {
  const { command, staged } = input

  // Created **before** anything can settle, and synchronously.
  // `createWriteStream` opens in the background, which leaves a window where a
  // read that fails immediately — a spawn error, a budget of a millisecond —
  // cleans up a file that does not exist yet and is created a moment later.
  //
  // `wx` at `0600`: exclusive creation refuses an existing path rather than
  // writing through it, so a leftover or a planted link fails the read instead
  // of silently becoming its output. Nothing is deleted on that refusal —
  // removing the file would be writing through it by another route.
  let fd: number
  try {
    fd = openSync(staged, "wx", 0o600)
  } catch {
    return Promise.resolve({
      ok: false,
      failure: "commandFailed",
      message: "the structured output could not be staged: the file could not be created",
    })
  }

  return new Promise((resolve) => {
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
    // The descriptor and nothing else (issue #84).
    //
    // Passing the path *as well as* the fd reads as documentation — the path
    // is what the fd is for — and under this runtime it is not inert: the
    // stream ends up closing a descriptor twice, which surfaces as
    // `EBADF: bad file descriptor, close` on the stream's `error` event and is
    // reported as a Result Bundle that could not be read. It is a race against
    // the runtime's own bookkeeping, so it presented as the same scenario
    // passing and failing in alternate runs, and only inside the OpenCode host
    // process, where there is enough else going on for the ordering to vary.
    //
    // `""` with an `fd` is the idiom the supervisor's control channel already
    // uses for exactly this reason.
    const sink = createWriteStream("", { fd, autoClose: true })
    let stagedBytes = 0
    let settled = false
    /**
     * The child exited cleanly, so everything it meant to write, it wrote.
     *
     * Past this point a stream error is about letting go of a descriptor, not
     * about the bytes — and the bytes are the only thing this read is for.
     */
    let payloadComplete = false

    const finish = (response: XcresultResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sink.destroy()
      // Scratch, not evidence, and this path was created by this call — so it
      // is removed on every exit from this read, including the ones nobody
      // plans for. Unlinking by name is safe while the stream still holds the
      // descriptor: writes to an unlinked file harm nothing.
      rmSync(staged, { force: true })
      resolve(response)
    }

    // The remaining budget is the caller's, and a read that outlives it is
    // stopped rather than left to finish into a deadline that has passed.
    // Escalation is bounded and ordered: ask, then insist.
    const timer = setTimeout(() => {
      stopGroup(child.pid, "SIGTERM")
      setTimeout(() => stopGroup(child.pid, "SIGKILL"), ESCALATION_GRACE_MS).unref?.()
      finish(TIMED_OUT)
    }, budgetMs)

    // A different failure from the one above, and it needs a different
    // wording (issue #84). "Could not be created" is a file that never
    // existed; this is one that did and then stopped accepting writes — a
    // full volume, a descriptor that went away. Told the same sentence, a
    // reader cannot tell which happened, and the two send them to look at
    // completely different things.
    sink.on("error", () => {
      // An error once the stream has been told to end is a failure to let go
      // of the descriptor, not a failure to write (issue #84). The payload is
      // already on disk — `end`'s callback is what decodes it — and this
      // runtime raises `EBADF: bad file descriptor, close` here often enough
      // to matter: closing an `fd` the stream was handed, after it has
      // finished with it, races the runtime's own bookkeeping.
      //
      // Reported, it became `resultBundleUnreadable` for a Test Run whose
      // evidence had been read perfectly well — the tool blaming a caller's
      // Result Bundle for its own difficulty putting a file down. Intermittent,
      // because it is a race, and visible only inside the OpenCode host
      // process, where there is enough else happening for the ordering to
      // vary.
      if (sink.writableEnded || payloadComplete) return

      finish({
        ok: false,
        failure: "commandFailed",
        message: "the structured output could not be staged: the file could not be written",
      })
    })

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

      payloadComplete = true

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
