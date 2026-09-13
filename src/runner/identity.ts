/**
 * Process start identity and liveness (#3).
 *
 * A PID is not an identity. PIDs are reused, and recovery that signalled a
 * recorded PGID on the strength of the number alone would eventually kill an
 * unrelated process belonging to someone else's work. Every recorded process
 * therefore carries a start identity, and nothing is ever signalled until at
 * least one currently-live recorded process validates against it.
 */

import { spawnSync } from "node:child_process"

export type ProcessIdentity = {
  pid: number
  /** The kernel's start time for that PID, as an opaque stable string. */
  startedAt: string
}

/** Both components must agree. A PID match alone proves nothing. */
export function identityMatches(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt
}

/**
 * The seam over the operating system. Supervision tests drive a real stub
 * process through a real probe; recovery and quarantine tests drive a fake one
 * through states a real machine cannot be asked to produce on demand.
 */
export type ProcessProbe = {
  /** The current identity of `pid`, or `undefined` when no such process exists. */
  identify(pid: number): ProcessIdentity | undefined
  /** PIDs currently in the process group. Empty means the group is gone. */
  membersOf(pgid: number): number[]
  /** Signal a whole process group. The caller must have validated it first. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void
}

/** The real probe, reading start times from `ps`. */
export const systemProbe: ProcessProbe = {
  identify(pid: number): ProcessIdentity | undefined {
    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    })
    const startedAt = result.stdout?.trim()
    if (result.status !== 0 || startedAt === undefined || startedAt.length === 0) return undefined
    return { pid, startedAt }
  },

  membersOf(pgid: number): number[] {
    const result = spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" })
    if (result.status !== 0) return []
    return (result.stdout ?? "")
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  },

  signalGroup(pgid: number, signal: NodeJS.Signals): void {
    // A negative PID addresses the process group. The supervisor is outside it.
    process.kill(-pgid, signal)
  },
}

/**
 * Whether it is safe to signal a recorded group: at least one recorded process
 * must still be live, still match its recorded start identity, and still be a
 * member of the recorded group.
 */
export function signallingIsSafe(
  probe: ProcessProbe,
  recorded: { pgid: number; processes: ProcessIdentity[] },
): boolean {
  const members = new Set(probe.membersOf(recorded.pgid))
  return recorded.processes.some((expected) => {
    if (!members.has(expected.pid)) return false
    const current = probe.identify(expected.pid)
    return current !== undefined && identityMatches(current, expected)
  })
}

/** Every recorded identity is gone, or the PID was reused by something else. */
export function allIdentitiesGone(
  probe: ProcessProbe,
  recorded: ProcessIdentity[],
): boolean {
  return recorded.every((expected) => {
    const current = probe.identify(expected.pid)
    return current === undefined || !identityMatches(current, expected)
  })
}
