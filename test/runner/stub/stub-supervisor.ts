#!/usr/bin/env bun
/**
 * A stand-in supervisor that speaks the control protocol and nothing else.
 *
 * The real supervisor's job is to run `xcodebuild`; this one's is to let the
 * adapter's half of the protocol be tested without it — the handshake, the
 * durable state transitions, and the completion message, on demand and in
 * milliseconds.
 *
 * Behaviour is scripted through a `.stub-mode` file in the containment root, so
 * nothing in shipped code has to know this stub exists:
 *   ready-then-complete  (default) full protocol, exit 0
 *   silent               exit 0 without ever handshaking
 *   crash                exit non-zero after handshaking
 *   hang                 never handshake and never exit, so the adapter's
 *                        startup deadline is the only thing that ends it
 *   ready-then-linger:MS handshake at once, then take MS milliseconds to
 *                        finish — a healthy supervisor overseeing a Test Run
 *                        that outlasts its own startup deadline
 *   ready-other-run      answer `ready` naming a different run, and otherwise
 *                        behave — the frame is well-formed and arrives on the
 *                        right descriptor, and is still not this run's
 *                        handshake (#115)
 *   unending-frame       write without ever ending a frame, in chunks, so the
 *                        adapter's decode buffer is what would grow (#127)
 */

import { createReadStream, createWriteStream } from "node:fs"

import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"

import { decodeMessages, encodeMessage, MAX_FRAME_BYTES } from "../../../src/runner/control.ts"
import { storageForRootKey } from "../../../src/runner/paths.ts"
import { advance, readRunRecord } from "../../../src/runner/state.ts"

const control = createWriteStream("", { fd: 4 })
const incoming = createReadStream("", { fd: 3 })

type Spec = { homeDir: string; containmentRoot: string; rootKey: string; runId: string }

let buffer = ""
incoming.on("data", (chunk) => {
  buffer += String(chunk)
  const { messages, rest } = decodeMessages(buffer)
  buffer = rest

  for (const message of messages) {
    if (message.type !== "hello") continue
    const spec = message as unknown as Spec
    if (realpathSync(process.cwd()) !== realpathSync(spec.containmentRoot)) process.exit(70)

    const mode = modeFor(spec.containmentRoot)
    if (mode === "silent") process.exit(0)
    if (mode === "hang") {
      // Explicitly kept alive rather than relying on an inherited descriptor:
      // what is under test is the adapter giving up, and a stub that exited on
      // its own would quietly test nothing.
      //
      // Bounded, though. The adapter normally kills this stub at its handshake
      // deadline, but the tests that stub out `killProcess` to prove the tool
      // handles a refused signal mean nothing ever kills it — and an unbounded
      // `setInterval` then outlives the test run, the suite, and the day. Six
      // per `bun test` had accumulated into hundreds before anyone looked.
      //
      // `HANG_BUDGET_MS` is two orders above any deadline these tests use, so
      // the adapter still gives up first and the stub still tests what it
      // tested. It is a leak bound, not a behaviour.
      setTimeout(() => process.exit(0), HANG_BUDGET_MS)
      continue
    }
    if (mode === "unending-frame") {
      // Small writes, none of them remarkable, and enough of them to pass
      // the bound. What is under test is the adapter's buffer rather than any
      // single write's size — derived from the bound so that raising it does
      // not quietly turn this into a test of nothing.
      for (let write = 0; write < UNENDING_WRITES; write += 1) control.write(UNENDING_CHUNK)
      setTimeout(() => process.exit(0), HANG_BUDGET_MS)
      continue
    }
    if (mode === "ready-other-run") {
      // Answer, then stay up: what is under test is the adapter refusing to
      // count that answer, and a stub that exited would end the run for a
      // reason nobody was asking about.
      control.write(encodeMessage({ type: "ready", runId: "f".repeat(32) }))
      setTimeout(() => process.exit(0), HANG_BUDGET_MS)
      continue
    }

    control.write(encodeMessage({ type: "ready", runId: spec.runId }))

    // The listener stays synchronous and the waiting happens off it, so a
    // rejection is an exit status the test can see rather than an unhandled
    // rejection it cannot.
    void serve(spec, mode).catch(() => process.exit(70))
  }
})

/** Everything after the handshake, which is where a linger has to happen. */
async function serve(spec: Spec, mode: string): Promise<never> {
  // The handshake and the work are deliberately separated. A stub that
  // answered and finished in the same tick could never show what happens to a
  // supervisor still working when its startup deadline comes round.
  const lingerMs = lingerOf(mode)
  if (lingerMs > 0) await sleep(lingerMs)

  const storage = storageForRootKey(spec.homeDir, spec.rootKey)
  let record = readRunRecord(storage, spec.runId)
  if (record !== undefined) {
    for (const state of ["supervisorReady", "childRecorded", "launchAuthorized"] as const) {
      record = advance(storage, record, state)
    }
    record = advance(storage, record, "executionCompleted", {
      execObserved: "yes",
      exitCode: 0,
      descendantsConfirmedExited: "yes",
    })
  }

  control.write(encodeMessage({ type: "completed", exitCode: 0 }))
  process.exit(mode === "crash" ? 70 : 0)
}

/**
 * How long a `hang` stub stays up before giving up on being killed.
 *
 * Long enough that no test can reach it — the deadlines they set are in the
 * hundreds of milliseconds — and short enough that nothing survives the suite.
 */
const HANG_BUDGET_MS = 60_000

/** One unremarkable write, and enough of them to carry past the frame bound. */
const UNENDING_CHUNK = "x".repeat(4_096)
const UNENDING_WRITES = Math.ceil(MAX_FRAME_BYTES / UNENDING_CHUNK.length) + 1

/** Milliseconds a `ready-then-linger:MS` mode asks for; zero for any other. */
function lingerOf(mode: string): number {
  const match = /^ready-then-linger:(\d+)$/.exec(mode)
  return match?.[1] === undefined ? 0 : Number(match[1])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function modeFor(containmentRoot: string): string {
  try {
    return readFileSync(join(containmentRoot, ".stub-mode"), "utf8").trim()
  } catch {
    return "ready-then-complete"
  }
}
