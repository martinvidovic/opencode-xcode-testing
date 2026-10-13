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
import { mkdirSync, openSync, closeSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"

import { bundleDigest, DIGEST_CHUNK_BYTES } from "../../src/adapter/service.ts"
import { withSandbox, type Sandbox } from "../runner/harness.ts"
import { withJumpingWallClock } from "../wall-clock.ts"
import { digestOf } from "./scenarios.ts"

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

/** Overwrite the last `bytes.length` bytes of a file in place. */
function overwriteTail(path: string, bytes: Buffer): void {
  const fd = openSync(path, "r+")
  try {
    writeSync(fd, bytes, 0, bytes.length, statSync(path).size - bytes.length)
  } finally {
    closeSync(fd)
  }
}

/**
 * A clock that stands still for its first `withinBudget` readings and reads
 * as long past any deadline from then on. It counts the readings it gave, so a
 * test can say where in the walk the budget ran out without timing anything.
 */
function clockExpiringAfter(withinBudget: number): { now: () => number; readings: () => number } {
  let readings = 0
  return {
    now: () => (++readings <= withinBudget ? 0 : Number.MAX_SAFE_INTEGER),
    readings: () => readings,
  }
}

/** How many clock readings a walk that never runs out of budget takes. */
function readingsForCompleteDigest(bundle: string): number {
  const clock = clockExpiringAfter(Number.POSITIVE_INFINITY)
  expect(bundleDigest(bundle, 30_000, clock.now).status).toBe("digested")
  return clock.readings()
}

describe("digesting a large Result Bundle", () => {
  test("reads a file far larger than one chunk, correctly", async () => {
    await withSandbox((box) => {
      // Four chunks and a bit, so the streaming path runs several times and
      // ends part-way through a read rather than exactly on a boundary.
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 4 + 11)
      const digest = digestOf(bundle)

      expect(digest).toBeDefined()
      expect(digest).toHaveLength(64)
    })
  })

  test("is deterministic over content it read in pieces", async () => {
    await withSandbox((box) => {
      const first = digestOf(bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 2 + 7))
      const second = digestOf(bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 2 + 7))

      // Chunking is an implementation detail of reading, not of the digest:
      // two machines that split a file differently must still agree.
      expect(first).toBe(second)
    })
  })

  test("notices a change in the last partial chunk", async () => {
    await withSandbox((box) => {
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES + 5)
      const file = join(bundle, "Data")
      const before = digestOf(bundle)

      // Only the bytes past the last full chunk change, and the length does
      // not: a digest that stopped at the last whole chunk sees no difference.
      overwriteTail(file, Buffer.from("BBB"))

      expect(statSync(file).size).toBe(DIGEST_CHUNK_BYTES + 5)
      expect(digestOf(bundle)).not.toBe(before)
    })
  })

  test("gives up inside a large file rather than after it", async () => {
    await withSandbox((box) => {
      // Calibrated against the walk rather than against how it is written
      // today: one more chunk must cost exactly one more reading of the clock,
      // or the budget is not being checked as the file is read. Checking only
      // between files would let one large file overrun the whole budget
      // unnoticed, which is exactly where an overrun would matter.
      const ninthChunk = readingsForCompleteDigest(bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 9))
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 8)
      const complete = readingsForCompleteDigest(bundle)
      expect(ninthChunk - complete).toBe(1)

      // So the last readings of a complete walk are the per-chunk ones. A
      // budget that runs out four short of the end runs out with the first
      // chunks read and the last ones not.
      const clock = clockExpiringAfter(complete - 4)

      expect(bundleDigest(bundle, 30_000, clock.now)).toEqual({
        status: "incomplete",
        reason: "deadline",
      })
      expect(clock.readings()).toBe(complete - 3)
    })
  })

  test("still reports an unfinished check as unfinished, never as a digest", async () => {
    await withSandbox((box) => {
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 4)
      // Verification is never skipped and never guessed at: `undefined` is how
      // an incomplete one reaches the caller.
      expect(digestOf(bundle, 0)).toBeUndefined()
    })
  })
})

describe("a wall clock that moves under a digest in progress", () => {
  test("does not expire a budget the walk has not spent", async () => {
    await withSandbox((box) => {
      // An NTP correction, a daylight change, a user setting the clock: the
      // wall clock is allowed to jump, and a deadline measured against it
      // jumps with it. Here the walk would be abandoned an hour early, and
      // reported as an unfinished verification of a bundle that is fine.
      const bundle = bundleWithLargeFile(box, DIGEST_CHUNK_BYTES * 2)

      const digest = withJumpingWallClock(() => digestOf(bundle, 30_000))

      expect(digest).toBeDefined()
      expect(digest).toBe(digestOf(bundle, 30_000))
    })
  })
})
