/**
 * How much of a frame either end of the control protocol will hold (#127).
 *
 * Both ends decode the same way: accumulate whatever arrives until a newline
 * turns up. Without a bound, the size of that buffer is decided by whoever is
 * writing — and a peer that never ends a frame grows it until the process
 * dies. The process it kills on the supervisor's side is the one holding a
 * detached `xcodebuild` group's deadline, its cancellation, and its only
 * route to a terminal outcome.
 *
 * The bound belongs to the protocol rather than to either end, so both
 * directions get it from one place, and the check has to come before parsing:
 * finding out whether an oversized frame was legitimate means doing the
 * unbounded work the bound exists to refuse.
 */

import { describe, expect, test } from "bun:test"

import { decodeMessages, encodeMessage, MAX_FRAME_BYTES } from "../../src/runner/control.ts"

/** A frame that is well-formed, meaningful, and one byte too long. */
function oversizedCancel(): string {
  const padding = "x".repeat(MAX_FRAME_BYTES)
  return `${JSON.stringify({ type: "cancel", padding })}\n`
}

describe("an oversized frame that has already been terminated", () => {
  test("is refused, though it would have parsed perfectly", () => {
    // The padding is the point: this is a valid `cancel`, and a decoder that
    // parsed first and measured afterwards would act on it. Acting on it is
    // acting on a frame whose size nothing agreed to.
    const decoded = decodeMessages(oversizedCancel())

    expect(decoded.messages).toEqual([])
    expect(decoded.rejected).toBe(1)
  })

  test("does not take the frames around it with it", () => {
    // A bound that discarded the whole read would let one oversized frame
    // suppress a legitimate cancellation arriving in the same chunk.
    const decoded = decodeMessages(
      encodeMessage({ type: "cancel" }) + oversizedCancel() + encodeMessage({ type: "state", state: "running" }),
    )

    expect(decoded.messages.map((message) => message.type)).toEqual(["cancel", "state"])
    expect(decoded.rejected).toBe(1)
  })

  test("is not reported as a stream whose framing was lost", () => {
    // It ended where it said it would. The next frame begins where it should,
    // so there is nothing to resynchronize and no reason to declare the
    // channel gone.
    expect(decodeMessages(oversizedCancel()).overflowed).toBe(false)
  })
})

describe("a frame that never ends", () => {
  test("is dropped rather than carried into the next read", () => {
    const decoded = decodeMessages("x".repeat(MAX_FRAME_BYTES + 1))

    expect(decoded.rest).toBe("")
    expect(decoded.overflowed).toBe(true)
  })

  test("cannot grow the buffer across many reads, which is how it arrives", () => {
    // The shape a real one has: nobody sends a megabyte in one write. Each
    // chunk is small and legitimate-looking, and the buffer is what grows.
    let buffer = ""
    const chunk = "y".repeat(4_096)
    let overflowed = false

    for (let read = 0; read < 64 && !overflowed; read += 1) {
      buffer += chunk
      const decoded = decodeMessages(buffer)
      buffer = decoded.rest
      overflowed = decoded.overflowed

      expect(buffer.length).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    }

    expect(overflowed).toBe(true)
    expect(buffer).toBe("")
  })

  test("leaves a frame that had already completed alone", () => {
    // What arrived whole, arrived. Only the unterminated tail is lost.
    const decoded = decodeMessages(
      encodeMessage({ type: "ready", runId: "r".repeat(32) }) + "z".repeat(MAX_FRAME_BYTES + 1),
    )

    expect(decoded.messages.map((message) => message.type)).toEqual(["ready"])
    expect(decoded.overflowed).toBe(true)
  })
})

describe("an oversized frame of nothing at all", () => {
  test("is a protocol violation rather than an empty line", () => {
    // Whitespace is skipped, and a megabyte of it is not whitespace — it is
    // somebody testing what this end will hold. Counting it as nothing would
    // report a stream that is being abused as a stream that is idle.
    const decoded = decodeMessages(`${" ".repeat(MAX_FRAME_BYTES + 1)}\n`)

    expect(decoded.messages).toEqual([])
    expect(decoded.rejected).toBe(1)
  })
})

describe("the traffic the protocol is for", () => {
  test("is still accepted, all of it", () => {
    // The bound is two orders above anything here, and a bound that had to be
    // reasoned about per message type would be one the decoder could not
    // apply — it runs before the type is known.
    const frames = [
      encodeMessage({
        type: "hello",
        homeDir: "/Users/someone",
        containmentRoot: "/Users/someone/project",
        runId: "r".repeat(32),
        command: "/usr/bin/xcodebuild",
        args: ["test", "-scheme", "App", "-destination", "id=SIMULATOR"],
        environment: { PATH: "/usr/bin:/bin", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        developerDirectory: "/Applications/Xcode.app/Contents/Developer",
      }),
      encodeMessage({ type: "ready", runId: "r".repeat(32) }),
      encodeMessage({ type: "state", state: "launchAuthorized" }),
      encodeMessage({ type: "cancel" }),
      encodeMessage({ type: "completed", exitCode: 0 }),
    ]

    const decoded = decodeMessages(frames.join(""))

    expect(decoded.messages.map((message) => message.type)).toEqual([
      "hello",
      "ready",
      "state",
      "cancel",
      "completed",
    ])
    expect(decoded.rejected).toBe(0)
    expect(decoded.overflowed).toBe(false)
  })

  test("has room to spare, measured rather than assumed", () => {
    // The largest frame this protocol carries, against the bound that has to
    // hold it. Asserted so that a `hello` which grows into the bound is a
    // failing test rather than a run that stops working.
    const hello = encodeMessage({
      type: "hello",
      homeDir: "/Users/someone",
      containmentRoot: "/Users/someone/very/deeply/nested/workspace/project",
      runId: "r".repeat(32),
      command: "/usr/bin/xcodebuild",
      args: Array.from({ length: 40 }, (_, index) => `-only-testing:AppTests/SuiteNumber${index}`),
      environment: { PATH: "/usr/bin:/bin", DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
      developerDirectory: "/Applications/Xcode.app/Contents/Developer",
    })

    expect(Buffer.byteLength(hello, "utf8")).toBeLessThan(MAX_FRAME_BYTES / 8)
  })
})
