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
 * Extraction is keyed to the decoder version, so a later decoder recognizing a
 * format this one cannot is an expected improvement rather than a discrepancy:
 * lazy detail never alters the published index, counts, or outcome.
 */

import type { StackFrame } from "../domain/inspection.ts"
import { safeDisplayPath } from "./locations.ts"

export type ExtractedFrames = {
  frames: StackFrame[]
  /** False when no recognizable trace format was present to read. */
  recognized: boolean
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

export function extractFrames(message: string, trustedRoot: string): ExtractedFrames {
  const frames: StackFrame[] = []

  for (const line of message.split("\n")) {
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
          path: safeDisplayPath(path, trustedRoot),
          line: Number.parseInt(line1, 10),
          ...(column === undefined ? {} : { column: Number.parseInt(column, 10) }),
        },
      })
    }
  }

  return { frames, recognized: frames.length > 0 }
}
