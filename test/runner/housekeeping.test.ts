/**
 * The global registry and user-wide housekeeping (ADR 0002's amendment to #3).
 *
 * The interval guard is the whole point of these: without it, a project with no
 * Xcode in it pays for user-wide maintenance on every session start, which is a
 * cost the project has no stake in.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
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

describe("a root nobody has opened for two months", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const STALE = "c".repeat(64)
  const FRESH = "d".repeat(64)

  /** Two registered roots, one long unopened, both with storage on disk. */
  function twoRoots(box: Sandbox, nowMs: number): { stale: string; fresh: string } {
    for (const rootKey of [STALE, FRESH]) {
      mkdirSync(join(box.storage.toolRoot, "roots", rootKey, "runs"), { recursive: true })
      // `0600`, because coordination state is read under the same owner-only
      // rule as everything else the runner writes — a fixture at `0644` is
      // rejected, which is the read failing closed rather than the test
      // arranging something impossible.
      writeFileSync(
        join(box.storage.toolRoot, "roots", rootKey, "queue.json"),
        JSON.stringify({ schemaVersion: 1, nextSequence: 1, tickets: [] }),
        { mode: 0o600 },
      )
    }
    writeRegistry(box.storage, {
      schemaVersion: 1,
      roots: {
        [STALE]: { lastSeenAtMs: nowMs - 90 * DAY_MS },
        [FRESH]: { lastSeenAtMs: nowMs - DAY_MS },
      },
    })
    return {
      stale: join(box.storage.toolRoot, "roots", STALE),
      fresh: join(box.storage.toolRoot, "roots", FRESH),
    }
  }

  test("is collected whole, and one opened yesterday is not", () => {
    // The only signal there is. The registry stores a hash and a timestamp by
    // design and never a path, so nothing here can ask whether a repository
    // still exists — which is the privacy property, and also why an age policy
    // is the whole of what stale collection can be. Without one these
    // directories are permanent: 344 had accumulated on the machine where this
    // was written, against a handful of real projects.
    withSandbox((box) => {
      const paths = twoRoots(box, NOW)
      const outcome = housekeep(box, NOW)

      expect(outcome.status).toBe("ran")
      expect(outcome.status === "ran" ? outcome.staleRoots : []).toEqual([STALE])
      expect(existsSync(paths.stale)).toBe(false)
      expect(existsSync(paths.fresh)).toBe(true)
    })
  })

  test("loses its registry entry with its directory, not before or instead", () => {
    // An entry left behind would have every later pass collect the same root
    // for ever; an entry removed first would leave a directory nothing knows
    // about, which is the accumulation this exists to end.
    withSandbox((box) => {
      twoRoots(box, NOW)
      housekeep(box, NOW)

      const roots = readRegistry(box.storage).roots
      expect(Object.keys(roots)).toEqual([FRESH])
    })
  })

  test("is left alone while an instance holds its lock", () => {
    // A held root lock is the clearest possible evidence that a root is not
    // stale: something is using it right now.
    withSandbox((box) => {
      const paths = twoRoots(box, NOW)
      const held = acquireLock(join(paths.stale, "root.lock"))
      try {
        const outcome = housekeep(box, NOW)
        expect(outcome.status === "ran" ? outcome.staleRoots : ["x"]).toEqual([])
        expect(existsSync(paths.stale)).toBe(true)
        expect(readRegistry(box.storage).roots[STALE]).toBeDefined()
      } finally {
        held.release()
      }
    })
  })

  test("is not retained against the byte targets of the roots that survive", () => {
    // Collected before the user-wide total is taken, or a single pass evicts
    // evidence from live roots to make room for storage it then deletes.
    withSandbox((box) => {
      const paths = twoRoots(box, NOW)
      const outcome = housekeep(box, NOW)

      expect(outcome.status === "ran" ? Object.keys(outcome.reports) : []).not.toContain(STALE)
      expect(existsSync(paths.stale)).toBe(false)
    })
  })
})

describe("what stale collection refuses to touch", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const KEY = "e".repeat(64)

  /** One long-unopened root, with whatever coordination state a test wants. */
  function longUnopened(box: Sandbox, queue: unknown): string {
    const rootDir = join(box.storage.toolRoot, "roots", KEY)
    mkdirSync(join(rootDir, "runs"), { recursive: true })
    writeFileSync(join(rootDir, "queue.json"), JSON.stringify(queue), { mode: 0o600 })
    writeRegistry(box.storage, {
      schemaVersion: 1,
      roots: { [KEY]: { lastSeenAtMs: NOW - 90 * DAY_MS } },
    })
    return rootDir
  }

  const idle = { schemaVersion: 1, nextSequence: 1, tickets: [] }

  test("a root holding the execution slot, whatever its timestamp says", () => {
    // The slot means a run is live in there. The root lock is taken around
    // admission transitions and not for a build's duration, so holding it
    // proves only that nothing was changing the queue at that instant.
    withSandbox((box) => {
      const rootDir = longUnopened(box, { ...idle, activeRunId: "a".repeat(32) })
      const outcome = housekeep(box, NOW)

      expect(outcome.status === "ran" ? outcome.staleRoots : ["x"]).toEqual([])
      expect(existsSync(rootDir)).toBe(true)
    })
  })

  test("a quarantined root, which is state a recovery pass has to find", () => {
    // Sixty days of silence is not permission to discard it.
    withSandbox((box) => {
      const rootDir = longUnopened(box, {
        ...idle,
        quarantine: { runId: "a".repeat(32), reason: "terminationUnconfirmed", since: 1 },
      })
      const outcome = housekeep(box, NOW)

      expect(outcome.status === "ran" ? outcome.staleRoots : ["x"]).toEqual([])
      expect(existsSync(rootDir)).toBe(true)
    })
  })

  test("a root whose coordination state cannot be read at all", () => {
    // Nothing can say it is idle, and the answer to that is to leave it rather
    // than delete it and find out.
    withSandbox((box) => {
      const rootDir = join(box.storage.toolRoot, "roots", KEY)
      mkdirSync(join(rootDir, "runs"), { recursive: true })
      writeFileSync(join(rootDir, "queue.json"), "{ not json", { mode: 0o600 })
      writeRegistry(box.storage, {
        schemaVersion: 1,
        roots: { [KEY]: { lastSeenAtMs: NOW - 90 * DAY_MS } },
      })

      const outcome = housekeep(box, NOW)
      expect(outcome.status === "ran" ? outcome.staleRoots : ["x"]).toEqual([])
      expect(existsSync(rootDir)).toBe(true)
    })
  })
})

describe("a root directory nobody registered", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const ORPHAN = "f".repeat(64)

  /** Storage with no registry entry — a crash between the two writes. */
  function orphan(box: Sandbox, ageDays: number): string {
    const rootDir = join(box.storage.toolRoot, "roots", ORPHAN)
    mkdirSync(join(rootDir, "runs"), { recursive: true })
    writeFileSync(join(rootDir, "queue.json"), JSON.stringify({ schemaVersion: 1, nextSequence: 1, tickets: [] }), {
      mode: 0o600,
    })
    const when = new Date(NOW - ageDays * DAY_MS)
    utimesSync(rootDir, when, when)
    writeRegistry(box.storage, { schemaVersion: 1, roots: {} })
    return rootDir
  }

  test("is collected by its own age, because no policy can otherwise see it", () => {
    // The registry entry is the only record that a root exists, so storage
    // without one is invisible to every policy including this one — and the
    // entry and the directory are written by different calls, so a crash
    // between them leaves exactly this.
    withSandbox((box) => {
      const rootDir = orphan(box, 90)
      const outcome = housekeep(box, NOW)

      expect(outcome.status === "ran" ? outcome.staleRoots : []).toEqual([ORPHAN])
      expect(existsSync(rootDir)).toBe(false)
    })
  })

  test("is left alone while it is young, which is what a live root looks like", () => {
    // Storage is prepared before the registry entry is written, so a root
    // being created right now is briefly indistinguishable from an orphan.
    withSandbox((box) => {
      const rootDir = orphan(box, 0)
      housekeep(box, NOW)
      expect(existsSync(rootDir)).toBe(true)
    })
  })
})

describe("a registry entry whose storage has already gone", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const GHOST = "a".repeat(64)

  test("is collected, rather than reconsidered on every later pass", () => {
    // The commoner orphan, and the reverse of the other one: storage removed
    // by hand, or by an earlier pass that could not finish. There is nothing
    // left to delete, so the entry is what this collects — and it has to be,
    // or every pass for ever reopens the same question about a root that does
    // not exist. This machine had 417 entries against 348 directories.
    withSandbox((box) => {
      writeRegistry(box.storage, {
        schemaVersion: 1,
        roots: { [GHOST]: { lastSeenAtMs: NOW - 90 * DAY_MS } },
      })

      const outcome = housekeep(box, NOW)

      expect(outcome.status === "ran" ? outcome.staleRoots : []).toEqual([GHOST])
      expect(readRegistry(box.storage).roots[GHOST]).toBeUndefined()
    })
  })

  test("is left alone while it is recent, whatever it points at", () => {
    withSandbox((box) => {
      writeRegistry(box.storage, {
        schemaVersion: 1,
        roots: { [GHOST]: { lastSeenAtMs: NOW - DAY_MS } },
      })

      housekeep(box, NOW)
      expect(readRegistry(box.storage).roots[GHOST]).toBeDefined()
    })
  })
})
