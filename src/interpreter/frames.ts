/**
 * Stack frames, extracted from failure message text (#8).
 *
 * v1 frames are a **best-effort deterministic extraction** from the text a
 * failure already carries, wherever a recognizable XCTest or Swift Testing
 * trace format appears in it. Two rules from #8 shape everything here, and
 * both are about not inventing evidence:
 *
 * - Frames are never synthesized from activity titles, or from anything else
 *   that merely sits near a failure. A frame claims "the failure passed
 *   through here", and only a trace can support that claim.
 * - No recognizable trace means zero frames, reported as unavailable rather
 *   than as an empty stack. "There were none" and "none could be read" are
 *   different facts, and a caller acts differently on each.
 *
 * Which is three facts, not two, and reading it as two was the defect (issue
 * #99). A plain assertion failure — `XCTAssertEqual failed: ("4") is not equal
 * to ("5")` — carries no trace because there was no trace to carry, and saying
 * "the frames were truncated" about it describes evidence that was never
 * missing. The caller is told to go looking for something nobody withheld,
 * every time, for the commonest failure there is.
 *
 * So recognition is asked of the *text*, not of the parse. Text with nothing
 * frame-shaped in it has a complete and empty stack; text that is frame-shaped
 * and parsed has its frames; text that is frame-shaped and did not parse is
 * the one case that is genuinely incomplete — and it says so without inventing
 * a frame to stand in for what it could not read.
 *
 * Extraction is keyed to the decoder version, so a later decoder recognizing a
 * format this one cannot is an expected improvement rather than a discrepancy:
 * lazy detail never alters the published index, counts, or outcome.
 */

import type { StackFrame } from "../domain/inspection.ts"
import { safeDisplayPath } from "./locations.ts"

/**
 * What the text had to say about frames, which is three answers.
 *
 * `absent` — nothing in it was frame-shaped, so an empty stack is the whole
 * and complete truth. `extracted` — every frame-shaped line was read.
 * `partial` — frame-shaped lines were there and at least one could not be
 * read, which is the only case where a caller is missing something.
 */
export type ExtractedFrames = {
  frames: StackFrame[]
  status: "absent" | "extracted" | "partial"
}

/**
 * A line that is *shaped* like a frame, whether or not it parses as one.
 *
 * Deliberately looser than the two patterns below, and that is the point: it
 * answers "was a trace being written here" rather than "did this tool manage
 * to read it". The strict patterns decide what becomes a frame; this decides
 * whether failing to match one of them is a loss.
 *
 * The same rule for a test failure and a build error, because it is a rule
 * about text (AC5). Nothing here knows or cares which produced the message.
 */
const FRAME_SHAPED = /^\s*\d+\s+\S+\s+0x[0-9a-fA-F]+/

/**
 * A backtrace line and **only** a backtrace line, deliberately.
 *
 * A source-location line is not here, and leaving it out is the whole of what
 * makes this rule safe. `at Sources/App/Login.swift:42` is also how
 * `xcodebuild` writes an ordinary compiler diagnostic —
 * `at Sources/App/Login.swift:42: error: cannot find 'foo' in scope` — and
 * nothing in the text distinguishes a source line that was cut off from a
 * sentence that begins the same way. Treating those as frame-shaped would put
 * `partial` on perfectly complete build errors: the same defect #99 is about,
 * moved from assertions to compiler output.
 *
 * An ordinal, a module and a hexadecimal address are not prose. Nothing writes
 * that shape except a backtrace, so a line carrying it and failing to parse is
 * a trace this tool could not read — which is the claim `partial` makes.
 *
 * The cost is stated rather than hidden: a source-location line that is
 * malformed on its own, with no backtrace anywhere near it, reads as `absent`.
 * That is the conservative error of the two. `absent` understates a loss that
 * a caller can still see in the message; `partial` invents one they cannot.
 */
function isFrameShaped(line: string): boolean {
  return FRAME_SHAPED.test(line)
}

/**
 * A symbolicated backtrace line, as both XCTest and Swift Testing emit them:
 *
 *     4   AppTests    0x0000000104a2b1c4 LoginTests.testSignsIn() + 132
 *
 * The address is matched so it can be **discarded** — #7 forbids exposing raw
 * addresses — and the ordinal anchors the line so ordinary prose that happens
 * to contain a symbol-like word is not mistaken for a frame.
 */
const BACKTRACE_LINE = /^\s*\d+\s+(\S+)\s+0x[0-9a-fA-F]+\s+(.+?)(?:\s+\+\s+\d+)?\s*$/

/**
 * A source-location line, as a Swift Testing failure records it:
 *
 *     at Sources/App/Login.swift:42:9
 */
const SOURCE_LINE = /^\s*at\s+(\S+?):(\d+)(?::(\d+))?\s*$/

export function extractFrames(message: string, containmentRoot: string): ExtractedFrames {
  const frames: StackFrame[] = []
  let shaped = 0

  for (const line of message.split("\n")) {
    if (isFrameShaped(line)) shaped += 1

    const backtrace = BACKTRACE_LINE.exec(line)
    if (backtrace !== null) {
      const [, module, symbol] = backtrace as unknown as [string, string, string]
      frames.push({ symbol, module })
      continue
    }

    const source = SOURCE_LINE.exec(line)
    if (source !== null) {
      const [, path, line1, column] = source as unknown as [string, string, string, string | undefined]
      frames.push({
        location: {
          path: safeDisplayPath(path, containmentRoot),
          line: Number.parseInt(line1, 10),
          ...(column === undefined ? {} : { column: Number.parseInt(column, 10) }),
        },
      })
    }
  }

  // Counted rather than compared line by line, because a frame-shaped line
  // and the frame it becomes are one to one: the strict patterns each consume
  // a whole line, and a line matches at most one of them.
  if (shaped === 0) return { frames, status: "absent" }
  return { frames, status: frames.length < shaped ? "partial" : "extracted" }
}
