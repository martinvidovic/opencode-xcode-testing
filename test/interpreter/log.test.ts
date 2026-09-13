/**
 * The log facet's chunking (#7, issue #24).
 *
 * Chunk boundaries are the whole subject here. A retained log is bytes a
 * project printed, paged in bounded windows, and the difference between a
 * correct boundary and an arbitrary one is whether a caller reading page after
 * page sees the text that was written or sees replacement characters at every
 * seam — which reads as corruption in the log rather than as an artifact of
 * how it was paged.
 */

import { describe, expect, test } from "bun:test"

import { LOG_CHUNK_DEFAULT_BYTES, LOG_CHUNK_MAX_BYTES } from "../../src/domain/limits.ts"
import { chunkLog, logWindow, LOG_CHUNK_MIN_BYTES } from "../../src/interpreter/log.ts"

/** Page the whole buffer the way a caller would, and rebuild the text. */
function readAll(bytes: Buffer, windowSize: number): { text: string; pages: number; lossy: number } {
  let offset = 0
  let text = ""
  let pages = 0
  let lossy = 0

  while (true) {
    const slice = bytes.subarray(offset, offset + windowSize)
    const result = chunkLog(slice, offset, bytes.length)
    text += result.chunk.text
    pages += 1
    if (result.chunk.lossyDecoding) lossy += 1

    expect(result.nextByteOffset).toBeGreaterThan(offset)
    offset = result.nextByteOffset
    if (!result.hasMore) break
    if (pages > 10_000) throw new Error("paging did not terminate")
  }

  return { text, pages, lossy }
}

describe("the window a request resolves to", () => {
  test("is the documented default when nothing is asked for", () => {
    expect(logWindow({}, 0)).toEqual({ byteOffset: 0, maxBytes: LOG_CHUNK_DEFAULT_BYTES })
  })

  test("is never larger than the contract allows, whatever is asked for", () => {
    expect(logWindow({ maxBytes: 10_000_000 }, 0).maxBytes).toBe(LOG_CHUNK_MAX_BYTES)
  })

  test("always holds at least one whole character, so a cursor always moves", () => {
    // Below four bytes a window could land entirely inside one character, and
    // paging would have to corrupt the text to make progress.
    expect(logWindow({ maxBytes: 0 }, 0).maxBytes).toBe(LOG_CHUNK_MIN_BYTES)
    expect(logWindow({ maxBytes: 1 }, 0).maxBytes).toBe(LOG_CHUNK_MIN_BYTES)
  })
})

describe("chunking", () => {
  test("returns the whole log when it fits", () => {
    const bytes = Buffer.from("build succeeded\n", "utf8")
    const result = chunkLog(bytes, 0, bytes.length)

    expect(result.chunk.text).toBe("build succeeded\n")
    expect(result.chunk.byteOffset).toBe(0)
    expect(result.chunk.byteLength).toBe(bytes.length)
    expect(result.chunk.lossyDecoding).toBe(false)
    expect(result.hasMore).toBe(false)
  })

  test("reports byte metadata about the source, not about the decoded text", () => {
    // Four characters, ten bytes. A caller seeking through the file needs the
    // bytes; a caller counting characters would seek to the wrong place.
    const bytes = Buffer.from("héllo"[0] + "é€𝄞", "utf8")
    const result = chunkLog(bytes, 7, bytes.length + 7)

    expect(result.chunk.byteOffset).toBe(7)
    expect(result.chunk.byteLength).toBe(bytes.length)
    expect(result.chunk.byteLength).not.toBe(result.chunk.text.length)
  })

  test("never splits a multi-byte character across two chunks", () => {
    const text = "é€𝄞 ".repeat(200)
    const bytes = Buffer.from(text, "utf8")

    // Every window size here lands mid-character somewhere in this text;
    // none of them may produce a replacement character.
    for (let size = LOG_CHUNK_MIN_BYTES; size <= 16; size += 1) {
      const read = readAll(bytes, size)
      expect(read.text).toBe(text)
    }
  })

  test("reassembles the original text at every window size", () => {
    const text = Array.from({ length: 300 }, (_, line) => `line ${line}: built ✓\n`).join("")
    const bytes = Buffer.from(text, "utf8")

    for (const size of [4, 7, 64, 1_000, 100_000]) {
      expect(readAll(bytes, size).text).toBe(text)
    }
  })

  test("advances even if handed a window smaller than one character", () => {
    // `logWindow` prevents this, but the guarantee that a cursor always moves
    // must not depend on a caller upstream getting that right.
    const bytes = Buffer.from("𝄞", "utf8")
    const result = chunkLog(bytes.subarray(0, 1), 0, bytes.length)

    expect(result.nextByteOffset).toBe(1)
    expect(result.hasMore).toBe(true)
  })

  test("says so when it decoded bytes that are not text", () => {
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62])
    const result = chunkLog(bytes, 0, bytes.length)

    // Not an error: a build tool may print anything. But a replacement
    // character in the output is then ours, and the caller is told.
    expect(result.chunk.lossyDecoding).toBe(true)
    expect(result.chunk.text).toContain("a")
    expect(result.chunk.text).toContain("b")
  })

  test("decodes a truncated character at the end of the file rather than hiding it", () => {
    const bytes = Buffer.from("ok ", "utf8")
    const truncated = Buffer.concat([bytes, Buffer.from([0xe2, 0x82])])
    const result = chunkLog(truncated, 0, truncated.length)

    // Nothing more is coming, so this is genuinely truncated data. Refusing to
    // show the end of a log is worse than showing it with a marker in it.
    expect(result.chunk.text.startsWith("ok ")).toBe(true)
    expect(result.chunk.lossyDecoding).toBe(true)
    expect(result.hasMore).toBe(false)
  })

  test("has more to give whenever the window ended before the file did", () => {
    const bytes = Buffer.from("abcdefgh", "utf8")
    const result = chunkLog(bytes.subarray(0, 4), 0, bytes.length)

    expect(result.chunk.text).toBe("abcd")
    expect(result.hasMore).toBe(true)
    expect(result.nextByteOffset).toBe(4)
  })

  test("is empty and final once the offset is past the end", () => {
    const result = chunkLog(Buffer.alloc(0), 12, 12)
    expect(result.chunk.text).toBe("")
    expect(result.chunk.byteLength).toBe(0)
    expect(result.hasMore).toBe(false)
  })
})
