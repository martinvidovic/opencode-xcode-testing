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

import { spawn } from "node:child_process"
import { openSync } from "node:fs"

import type { EvidenceFact } from "../domain/evidence.ts"
import type { ProcessIdentity } from "./identity.ts"

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
  const logFd = openSync(options.logPath, "a", 0o600)

  const child = spawn(
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

  const recordStream = child.stdio[3]
  const authorizeStream = child.stdio[4]
  const execStream = child.stdio[5]

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

  const exited = new Promise<ChildExit>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
      })
    })
  })

  const execObserved = exited.then((exit): EvidenceFact => {
    if (!announcedExec) return "unknown"
    return exit.exitCode !== undefined && EXEC_FAILURE_STATUSES.has(exit.exitCode) ? "no" : "yes"
  })

  return {
    recorded,
    authorize() {
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
