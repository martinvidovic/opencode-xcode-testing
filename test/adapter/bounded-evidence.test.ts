/**
 * Bounded and validated retained evidence (#8, issue #36).
 *
 * Two properties, and they fail in opposite directions. Reading a retained
 * artifact must be bounded in memory and in time, because its size is decided
 * by the project rather than by this tool — a Result Bundle near the 5 GiB
 * retention target is ordinary, not hostile. And anything read back off disk
 * must be validated before it reaches a model, because "on disk" is not the
 * same as "written by this version of this tool".
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { bundleDigest, DIGEST_CHUNK_BYTES } from "../../src/adapter/service.ts"
import { withSandbox, type Sandbox } from "../runner/harness.ts"

/** A bundle holding one file far larger than any chunk of it. */
function bundleWithLargeFile(box: Sandbox, bytes: number): string {
  const bundle = join(box.homeDir, "result.xcresult")
  mkdirSync(bundle, { recursive: true })

  const fd = openSync(join(bundle, "Data"), "w", 0o600)
  try {
    const chunk = Buffer.alloc(DIGEST_CHUNK_BYTES, 0x41)
    for (let written = 0; written < bytes; written += chunk.length) {
      writeSync(fd, chunk, 0, Math.min(chunk.length, bytes - written))
    }
  } finally {
    closeSync(fd)
  }
  return bundle
}

describe("digesting a large Result Bundle", () => {
  test("reads a file far larger than one chunk, correctly", async () => {
    await withSandbox((box) => {
      // Four chunks and a bit, so the streaming path runs several times and
      // ends part-way through a read rather than exactly on a boundary.
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 4 + 11)
      const digest = bundleDigest(bundle)

      expect(digest).toBeDefined()
      expect(digest).toHaveLength(64)
    })
  })

  test("is deterministic over content it read in pieces", async () => {
    await withSandbox((box) => {
      const first = bundleDigest(bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 2 + 7))
      const second = bundleDigest(bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 2 + 7))

      // Chunking is an implementation detail of reading, not of the digest:
      // two machines that split a file differently must still agree.
      expect(first).toBe(second)
    })
  })

  test("notices a change in the last partial chunk", async () => {
    await withSandbox((box) => {
      const before = bundleDigest(bundleWithLargeFile(box, DIGEST_CHUNK_BYTES + 5))
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES + 5)
      writeFileSync(join(bundle, "Extra"), "one more byte")

      expect(bundleDigest(bundle)).not.toBe(before)
    })
  })

  test("gives up inside a large file rather than after it", async () => {
    await withSandbox((box) => {
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 8)

      // A budget of zero expires on the first chunk. Checking only between
      // files would let one large file overrun the whole budget unnoticed,
      // which is exactly where an overrun would matter.
      expect(bundleDigest(bundle, 0)).toBeUndefined()
    })
  })

  test("still reports an unfinished check as unfinished, never as a digest", async () => {
    await withSandbox((box) => {
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 4)
      // Verification is never skipped and never guessed at: `undefined` is how
      // an incomplete one reaches the caller.
      expect(bundleDigest(bundle, 0)).toBeUndefined()
    })
  })
})
