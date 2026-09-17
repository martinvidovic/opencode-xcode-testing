/**
 * The gated child (#3).
 *
 * A plain spawn has a crash window: between the moment the kernel creates the
 * process and the moment the supervisor records its PID, a crash leaves a live
 * `xcodebuild` that nothing owns and nothing can safely signal. The gate closes
 * that window by making the child prove it was recorded before it may run:
 *
 * 1. the child becomes leader of its own process group, but does not `exec`;
 * 2. it publishes its PID, start identity and PGID to the supervisor;
 * 3. the supervisor persists launch authorization and only then releases it;
 * 4. a child that cannot publish, or is never authorized, exits without ever
 *    executing Xcode.
 *
 * `launchAuthorized` is therefore the linearization point for `startedAt` and
 * for the process deadline. It proves authorization — never successful `exec`,
 * which is recorded separately as `execObserved`.
 */

import { spawn, type ChildProcess } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { closeSync } from "node:fs"

import type { EvidenceFact } from "../domain/evidence.ts"
import type { ProcessIdentity } from "./identity.ts"
import { openPrivateAppendFile } from "./paths.ts"

/**
 * `sh` is the gate because it can genuinely `exec` the target, so the recorded
 * PID *is* `xcodebuild` rather than a proxy holding it as a child.
 *
 * fd 3 publishes identity, fd 4 carries authorization, fd 5 announces the
 * imminent `exec`. An `exec` that fails leaves `sh` exiting 126 or 127 with
 * nothing further written, which is what makes the distinction observable.
 */
export const GATE_SCRIPT = [
  'printf "%s\\t%s\\n" "$$" "$(ps -o lstart= -p $$)" >&3',
  "exec 3>&-",
  'read -r authorization <&4 || exit 70',
  '[ "$authorization" = "GO" ] || exit 70',
  "exec 4<&-",
  'printf "EXEC\\n" >&5',
  'exec "$@"',
].join("\n")

/** Exit statuses `sh` uses when it could not execute the target at all. */
export const EXEC_FAILURE_STATUSES = new Set([126, 127])

/** The status the gate exits with when it was never authorized. */
export const UNAUTHORIZED_STATUS = 70

export type ChildRecordEvent = { identity: ProcessIdentity; pgid: number }
export type ChildExit = { exitCode?: number; signal?: string }

/**
 * A child held at the gate. The supervisor drives it explicitly rather than the
 * other way round, which is what lets the stub suite reproduce every ordering.
 */
export type GatedChild = {
  /** Resolves once the child has published its identity, before any `exec`. */
  readonly recorded: Promise<ChildRecordEvent>
  /** Release the gate. Called only after authorization is durably persisted. */
  authorize(): void
  /** Refuse the gate, so the child exits without executing Xcode. */
  abandon(): void
  /** `yes`, `no`, or an honest `unknown` when the channel could not say. */
  readonly execObserved: Promise<EvidenceFact>
  readonly exited: Promise<ChildExit>
}

export type GateOptions = {
  command: string
  args: string[]
  cwd: string
  environment: Record<string, string>
  /**
   * Both stdout and stderr attach to this one descriptor, so the kernel's write
   * order is authoritative and no per-byte stream labelling is needed. A file
   * descriptor rather than a pipe also means capture is lossless and bounded in
   * memory by construction, with no backpressure to block Xcode.
   */
  logPath: string
}

export function spawnGatedChild(options: GateOptions): GatedChild {
  let logFd: number
  try {
    logFd = openPrivateAppendFile(options.logPath)
  } catch (error) {
    return neverStarted(error)
  }

  let child: ChildProcess
  try {
    child = spawn(
      "/bin/sh",
      ["-c", GATE_SCRIPT, "sh", options.command, ...options.args],
      {
        cwd: options.cwd,
        env: options.environment,
        // The child leads its own process group; the supervisor stays outside it.
        detached: true,
        stdio: ["ignore", logFd, logFd, "pipe", "pipe", "pipe"],
      },
    )
  } catch (error) {
    // `spawn` validates its arguments before it creates anything and throws
    // where it stands, by which point the descriptor is already open — which
    // is why the close below is a `finally` rather than a line after the call.
    return neverStarted(error)
  } finally {
    // The child holds its own duplicate from the moment it exists, so ours has
    // no further purpose. Keeping it pins the file for the supervisor's whole
    // life and spends a descriptor per attempt.
    closeSync(logFd)
  }

  // `child.stdio` is typed as the five standard entries with union element
  // types, because `spawn` in general may be handed anything. This call was
  // handed a fixed six-entry list three lines above, so what each of these is
  // was decided there. Stated once, beside the spawn that justifies it,
  // rather than asserted at each use (issue #74).
  const [, , , recordStream, authorizeStream, execStream] = child.stdio as unknown as [
    unknown,
    unknown,
    unknown,
    Readable | undefined,
    Writable | undefined,
    Readable | undefined,
  ]

  let resolveRecorded: (event: ChildRecordEvent) => void = () => {}
  let rejectRecorded: (error: Error) => void = () => {}
  const recorded = new Promise<ChildRecordEvent>((resolve, reject) => {
    resolveRecorded = resolve
    rejectRecorded = reject
  })

  let published = ""
  recordStream?.on("data", (chunk: Buffer) => {
    published += chunk.toString("utf8")
    const line = published.split("\n")[0]
    if (line === undefined || !published.includes("\n")) return
    const [pid, startedAt] = line.split("\t")
    const parsed = Number.parseInt(pid ?? "", 10)
    if (!Number.isInteger(parsed) || startedAt === undefined || startedAt.length === 0) {
      rejectRecorded(new Error("the gated child published an unusable identity"))
      return
    }
    // A detached leader's PGID equals its PID, so the group is fully determined.
    resolveRecorded({ identity: { pid: parsed, startedAt: startedAt.trim() }, pgid: parsed })
  })
  recordStream?.on("end", () => {
    rejectRecorded(new Error("the gated child closed the record channel without publishing"))
  })

  let announcedExec = false
  execStream?.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes("EXEC")) announcedExec = true
  })

  let resolveExit: (exit: ChildExit) => void = () => {}
  const exited = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve
    child.on("exit", (code, signal) => {
      resolve({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      })
    })
  })

  // A child the kernel never created (issue #117).
  //
  // Two things go wrong at once here, and the quiet one is the dangerous one.
  // An `error` event with no listener is a throw out of the event loop, which
  // takes down the one process holding the deadline, the cancellation and the
  // obligation to publish. And no `exit` follows a failed spawn — there was
  // no process to exit — so both of supervision's observations would stay
  // pending for ever, with the run's Execution Slot held and nothing saying why.
  //
  // Read as "it never launched" without qualification, which holds because
  // nothing here ever signals this child through the object that would raise
  // a later `error` on it: termination goes to the process group as
  // `process.kill(-pgid, …)`. Anything that starts calling `child.kill` has
  // to revisit this, since a failure to signal a child that ran perfectly
  // well would arrive the same way.
  let launched = true
  child.on("error", (error) => {
    launched = false
    rejectRecorded(asError(error, "the gated child could not be started"))
    resolveExit({})
  })

  // Every stream the gate holds needs a listener, for the same reason the
  // child does: a pipe whose far end has gone reports it asynchronously, and
  // an `error` event nobody is listening for is a throw out of the event loop.
  // Only the record channel has anything to say about it — a failure there is
  // a child that will never publish its identity.
  recordStream?.on("error", (error: Error) => {
    rejectRecorded(asError(error, "the gated child's record channel failed"))
  })
  for (const stream of [authorizeStream, execStream]) {
    stream?.on("error", () => {})
  }

  const execObserved = exited.then((exit): EvidenceFact => {
    // Not `unknown`: that is reserved for a channel that could not say. A
    // process that was never created is something this code knows for certain.
    if (!launched) return "no"
    if (!announcedExec) return "unknown"
    return exit.exitCode !== undefined && EXEC_FAILURE_STATUSES.has(exit.exitCode) ? "no" : "yes"
  })

  return {
    recorded: handled(recorded),
    authorize() {
      // Authorization is persisted first and released second, so there is
      // always a window in which the child has gone before the write. A write
      // to a stream whose far end has closed does not throw — it reports
      // `EPIPE` as an `error` event a turn later, which the listener above
      // absorbs. That is a released gate nobody was waiting at, not a failure.
      authorizeStream?.write("GO\n")
    },
    abandon() {
      // Closing without writing makes the gate's `read` fail, so it exits
      // without executing Xcode — the one safe way to cancel a launch.
      authorizeStream?.end()
    },
    execObserved,
    exited,
  }
}

/**
 * A gate for a child that was never created.
 *
 * It settles both observations rather than throwing, because the caller is
 * supervision, and supervision's answer to "the child failed to start" is
 * already written: abandon, await the exit, publish a launching-phase
 * failure. A throw from here would skip all of it.
 */
function neverStarted(error: unknown): GatedChild {
  return {
    recorded: handled(Promise.reject(asError(error, "the gated child could not be started"))),
    authorize() {},
    abandon() {},
    execObserved: Promise.resolve("no"),
    exited: Promise.resolve({}),
  }
}

/**
 * The same rejection, marked as heard.
 *
 * An unheard rejection ends the process, and `recorded` rejects for reasons
 * that have nothing to do with whether anyone is listening yet: a gate that
 * failed before it was returned has had no turn in which a handler could be
 * attached at all, and a caller that reads `exited` or `execObserved` without
 * reading `recorded` is asking a reasonable question in a reasonable order.
 *
 * This costs a diagnostic — an unheard rejection here is now silent — and it
 * is worth it. The process this would end is the supervisor: the one thing
 * holding a detached process group's deadline, its cancellation and its only
 * route to a terminal outcome. A lost warning is cheaper than a live
 * `xcodebuild` group with nothing watching it.
 *
 * The returned promise still rejects for whoever does await it.
 */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}
