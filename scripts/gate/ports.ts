/**
 * Ports the gate's servers listen on (issue #125).
 *
 * Four servers used four fixed numbers, and the gate assumed they were free.
 * They are not always: an earlier invocation that was killed can leave one
 * held, and two invocations overlapping — which is easy to do by accident —
 * chose exactly the same four.
 *
 * The two kinds of server fail differently, and neither failure says "port".
 * A server this repository starts refuses outright with `EADDRINUSE`, which
 * surfaces as a suite that could not begin. A host this repository only
 * *spawns* does not refuse at all: measured against a port another process was
 * holding, `opencode serve` reported that it was listening and went on
 * answering. What comes out of that is a scenario that saw the wrong server's
 * answer, reported as a defect in the tool — three such failures in one
 * session sent somebody looking for one.
 *
 * There is no probe here, for the reason probes do not work: a port that is
 * free when it is checked is not free when it is bound, and on the spawned
 * side a bind that cannot fail could not tell you either way. Two mechanisms
 * instead, and each is exact for what it covers.
 *
 * - A server this repository starts asks the kernel for a port — `port: 0`,
 *   and then whatever came back. That is collision-free by construction, not
 *   by luck.
 * - A server this repository only *spawns* — `opencode serve`, which ignores
 *   `--port=0` and falls back to its own default — is given a port chosen
 *   fresh for the invocation, and is then believed about which port it bound
 *   rather than assumed.
 */

import { randomInt } from "node:crypto"

/**
 * The range gate-spawned hosts are placed in.
 *
 * Above the registered range and below the ephemeral one macOS hands out
 * (49152–65535), so a number chosen here cannot be one the kernel is about to
 * assign to somebody else's outbound connection.
 */
export const GATE_PORT_RANGE = { first: 40_000, last: 49_000 } as const

/**
 * A port for one host this gate run is about to start.
 *
 * Random rather than derived from anything, because the two things being
 * avoided are a leftover of an earlier gate run and a sibling one running
 * now. A fixed number collides with both by definition; a number drawn per
 * call collides with either only by coincidence.
 *
 * Nothing excludes the stub provider's port: that one is assigned by the
 * kernel from the ephemeral range, which begins above this one ends.
 */
export function gatePort(): number {
  return randomInt(GATE_PORT_RANGE.first, GATE_PORT_RANGE.last + 1)
}

/**
 * The port a host's own "listening on" line names, if it names one.
 *
 * Read from the answer rather than from the question. The two are normally
 * the same and the asking is not what makes them so — this is the number
 * every later call has to use, and taking it from the request would be
 * believing the question. The host-managed SDK reads its own hosts the same
 * way, which is why they need nothing further here.
 */
export function reportedPort(output: string): number | undefined {
  const match = /listening on\s+https?:\/\/[^\s:]+:(\d{1,5})/.exec(output)
  const port = Number(match?.[1])
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}
