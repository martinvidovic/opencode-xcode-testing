/**
 * The global registry and user-wide housekeeping (ADR 0002's amendment to #3).
 *
 * The interval guard is the whole point of these: without it, a project with no
 * Xcode in it pays for user-wide maintenance on every session start, which is a
 * cost the project has no stake in.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { acquireLock } from "../../src/runner/locks.ts"
import { prepareStorage, storageFor } from "../../src/runner/paths.ts"
import {
  HOUSEKEEPING_MIN_INTERVAL_MS,
  housekeepingIsDue,
  noteRootSeen,
  readRegistry,
  runHousekeeping,
  writeRegistry,
} from "../../src/runner/housekeeping.ts"
import { seedRun, withSandbox, type Sandbox } from "./harness.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"

const NOW = Date.parse("2026-09-13T12:00:00.000Z")

function housekeep(box: Sandbox, nowMs: number) {
  return runHousekeeping({
    storage: box.storage,
    now: () => nowMs,
    storageForRootKey: (rootKey) => ({
      ...box.storage,
      rootDir: join(box.storage.toolRoot, "roots", rootKey),
      rootLock: join(box.storage.toolRoot, "roots", rootKey, "root.lock"),
      runsDir: join(box.storage.toolRoot, "roots", rootKey, "runs"),
      trashDir: join(box.storage.toolRoot, "roots", rootKey, "trash"),
      tombstonesDir: join(box.storage.toolRoot, "roots", rootKey, "tombstones"),
      queueFile: join(box.storage.toolRoot, "roots", rootKey, "queue.json"),
      rootKey,
    }),
  })
}

describe("the interval guard", () => {
  test("lets the first pass run", () => {
    expect(housekeepingIsDue({ schemaVersion: 1, roots: {} }, NOW)).toBe(true)
  })

  test("skips a pass under an hour after the previous one", () => {
    const registry = { schemaVersion: 1 as const, lastHousekeepingAtMs: NOW - 59 * 60 * 1000, roots: {} }
    expect(housekeepingIsDue(registry, NOW)).toBe(false)
  })

  test("allows a pass once an hour has elapsed", () => {
    const registry = {
      schemaVersion: 1 as const,
      lastHousekeepingAtMs: NOW - HOUSEKEEPING_MIN_INTERVAL_MS,
      roots: {},
    }
    expect(housekeepingIsDue(registry, NOW)).toBe(true)
  })

  test("is one hour", () => {
    expect(HOUSEKEEPING_MIN_INTERVAL_MS).toBe(60 * 60 * 1000)
  })
})

describe("running housekeeping", () => {
  test("records when it ran, so the next instance can skip", async () => {
    await withSandbox((box) => {
      expect(housekeep(box, NOW).status).toBe("ran")
      expect(readRegistry(box.storage).lastHousekeepingAtMs).toBe(NOW)
    })
  })

  test("skips the second pass in the same hour rather than repeating the work", async () => {
    await withSandbox((box) => {
      housekeep(box, NOW)
      expect(housekeep(box, NOW + 60_000)).toEqual({ status: "skipped", reason: "tooSoon" })
    })
  })

  test("declines rather than waiting when a sibling instance holds the lock", async () => {
    await withSandbox((box) => {
      const held = acquireLock(box.storage.registryLock)
      try {
        expect(housekeep(box, NOW)).toEqual({ status: "skipped", reason: "lockHeld" })
      } finally {
        held.release()
      }
    })
  })

  test("evicts across every registered root, not only the one that triggered it", async () => {
    await withSandbox((box) => {
      const otherRoot = storageFor(box.homeDir, "/workspace/elsewhere")
      prepareStorage(otherRoot)
      createRunDirectory(otherRoot, "run-stale")
      seedRun(otherRoot, {
        runId: "run-stale",
        state: "completed",
        completedAt: new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString(),
      })

      writeRegistry(box.storage, {
        schemaVersion: 1,
        roots: {
          [box.storage.rootKey]: { lastSeenAtMs: NOW },
          [otherRoot.rootKey]: { lastSeenAtMs: NOW - 30 * 24 * 60 * 60 * 1000 },
        },
      })

      const outcome = housekeep(box, NOW)
      expect(outcome.status).toBe("ran")
      if (outcome.status !== "ran") return
      expect(outcome.reports[otherRoot.rootKey]?.evicted).toEqual(["run-stale"])
    })
  })

  test("skips a root whose lock a live run is holding", async () => {
    await withSandbox((box) => {
      writeRegistry(box.storage, {
        schemaVersion: 1,
        roots: { [box.storage.rootKey]: { lastSeenAtMs: NOW } },
      })
      const held = acquireLock(box.storage.rootLock)
      try {
        const outcome = housekeep(box, NOW)
        expect(outcome.status).toBe("ran")
        if (outcome.status !== "ran") return
        expect(outcome.reports[box.storage.rootKey]).toBeUndefined()
      } finally {
        held.release()
      }
    })
  })
})

describe("the registry", () => {
  test("records a root as seen, so housekeeping can reach it later", async () => {
    await withSandbox((box) => {
      noteRootSeen(box.storage, NOW)
      expect(readRegistry(box.storage).roots[box.storage.rootKey]).toEqual({ lastSeenAtMs: NOW })
    })
  })

  test("rebuilds rather than trusting a malformed file, since it holds no evidence", async () => {
    await withSandbox((box) => {
      mkdirSync(box.storage.registryDir, { recursive: true, mode: 0o700 })
      Bun.write(box.storage.registryFile, "{ not json")
      expect(readRegistry(box.storage)).toEqual({ schemaVersion: 1, roots: {} })
    })
  })
})
