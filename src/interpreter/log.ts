/**
 * The log facet (#7).
 *
 * The retained raw log is the merged stdout and stderr of a process this tool
 * started but did not write: build output, test output, and anything a project
 * chose to print. It is the one facet whose content is *not* evidence — nothing
 * is ever classified from it — and the one whose content is wholly untrusted.
 *
 * Two consequences run through this file. Chunks are bounded and read from the
 * middle of a file rather than from a whole one loaded into memory, because a
 * retained log can be gigabytes. And chunk boundaries are UTF-8 boundaries: a
 * slice taken at an arbitrary byte would cut a multi-byte sequence in half and
 * produce a replacement character at each edge of every page, which reads as
 * corruption in the log rather than as an artifact of paging it.
 */

import type { LogChunk } from "../domain/inspection.ts"
import { LOG_CHUNK_DEFAULT_BYTES, LOG_CHUNK_MAX_BYTES } from "../domain/limits.ts"

/** What a caller asked for, after the request's own bounds are applied. */
export type LogWindow = { byteOffset: number; maxBytes: number }

/**
 * The smallest window that can hold one whole character.
 *
 * A window below this could land entirely inside a multi-byte sequence, and
 * the chunk would then have to choose between returning nothing — which never
 * advances the cursor — and emitting half a character, which corrupts the text
 * for a caller reading page after page. Four bytes is the longest sequence
 * UTF-8 defines, so at this size neither can happen.
 */
export const LOG_CHUNK_MIN_BYTES = 4

export type ChunkedLog = { chunk: LogChunk; hasMore: boolean; nextByteOffset: number }

/**
 * The window to read, given the requested size and the file's actual length.
 *
 * Separate from the chunking so the caller can read exactly these bytes and no
 * more: deciding the window after loading the file would defeat the point.
 */
export function logWindow(request: { maxBytes?: number }, byteOffset: number): LogWindow {
  const requested = request.maxBytes ?? LOG_CHUNK_DEFAULT_BYTES
  return {
    byteOffset,
    maxBytes: Math.min(Math.max(LOG_CHUNK_MIN_BYTES, requested), LOG_CHUNK_MAX_BYTES),
  }
}

/**
 * Turn raw bytes into a chunk, ending on a character boundary.
 *
 * `bytes` is the slice actually read at `byteOffset`; `totalBytes` is the whole
 * file's length, which is what says whether more remains. A trailing partial
 * sequence is left for the next chunk rather than decoded — unless nothing more
 * is coming, in which case it is genuinely truncated data and is decoded
 * lossily, because refusing to show the end of a log is worse than showing it
 * with a replacement character in it.
 */
export function chunkLog(bytes: Buffer, byteOffset: number, totalBytes: number): ChunkedLog {
  const reachesEnd = byteOffset + bytes.length >= totalBytes
  const usable = reachesEnd ? bytes.length : bytes.length - trailingPartialLength(bytes)

  // `logWindow` keeps a window at or above one character's worth, so this
  // cannot normally be reached. It stays because the guarantee it protects —
  // that a cursor always moves — must not depend on a caller upstream.
  const slice = bytes.subarray(0, usable === 0 ? bytes.length : usable)
  const text = decode(slice)

  const nextByteOffset = byteOffset + slice.length
  return {
    chunk: {
      text: text.value,
      byteOffset,
      byteLength: slice.length,
      lossyDecoding: text.lossy,
    },
    hasMore: nextByteOffset < totalBytes,
    nextByteOffset,
  }
}

/**
 * Decode strictly first, and only fall back to replacement characters when
 * that fails.
 *
 * The fallback is not a failure to report — a log legitimately contains
 * whatever a build tool printed, including bytes that are not text at all — but
 * it is a fact the caller must be told, because a replacement character in the
 * output is then ours and not the project's.
 */
function decode(bytes: Buffer): { value: string; lossy: boolean } {
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(bytes), lossy: false }
  } catch {
    return { value: new TextDecoder("utf-8").decode(bytes), lossy: true }
  }
}

/**
 * How many trailing bytes belong to a character that has not arrived yet.
 *
 * UTF-8 says a sequence's length is written in its lead byte, so this looks
 * back from the end for the last lead byte and asks whether its sequence
 * finished inside this slice. At most three bytes can be pending, which is why
 * the search is bounded rather than a scan.
 */
function trailingPartialLength(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] as number
    if (isContinuation(byte)) continue

    const length = sequenceLength(byte)
    // A complete sequence, or a byte that is not a lead byte at all: either
    // way nothing at the end is waiting for more.
    return length > back ? back : 0
  }
  return 0
}

function isContinuation(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000
}

/** Bytes in the sequence this lead byte starts, or 1 for anything else. */
function sequenceLength(byte: number): number {
  if ((byte & 0b1000_0000) === 0) return 1
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3
  if ((byte & 0b1111_1000) === 0b1111_0000) return 4
  return 1
}
