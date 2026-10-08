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
 * *spawns* fails startup when its requested port is occupied. The stale-host
 * hazard is elsewhere: a client still configured with an old fixed endpoint
 * reaches the listener the new host failed to replace, and reports that old
 * host's answer as a defect in the tool.
 *
 * There is no probe here, for the reason probes do not work: a port that is
 * free when it is checked is not free when it is bound. Every server asks the
 * kernel instead — `port: 0` — and is then believed about what it bound.
 *
 * - A server this repository starts reads its port back from the kernel.
 * - A V2 host this repository spawns honours `--port 0` (issue #140) and
 *   prints the port it bound. The gate reads that line from the child it
 *   started, and then checks that the server answering there reports that
 *   child's pid — so a stale listener cannot be mistaken for the host.
 */

/**
 * The port a host's own "listening on" line names, if it names one.
 *
 * Read from the answer rather than from the question. The two are normally
 * the same and the asking is not what makes them so — this is the number
 * every later call has to use, and taking it from the request would be
 * believing the question.
 */
export function reportedPort(output: string): number | undefined {
  const match = /listening on\s+https?:\/\/[^\s:]+:(\d{1,5})/.exec(output)
  const port = Number(match?.[1])
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}
