/**
 * The global registry and user-wide housekeeping (ADR 0002's amendment to #3).
 *
 * The interval guard is the whole point of these: without it, a project with no
 * Xcode in it pays for user-wide maintenance on every session start, which is a
 * cost the project has no stake in.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import type { Storage } from "../../src/runner/paths.ts"
import { join } from "node:path"

import { acquireLock } from "../../src/runner/locks.ts"
import { prepareStorage, storageFor, storageForRootKey } from "../../src/runner/paths.ts"
import {
  HOUSEKEEPING_MIN_INTERVAL_MS,
  housekeepingIsDue,
  noteRootSeen,
  readRegistry,
  runHousekeeping,
  writeRegistry,
} from "../../src/runner/housekeeping.ts"
import { fakeProbe, seedRun, withSandbox, type Sandbox } from "./harness.ts"
import { reconcileRoot, type RecoveryStatus } from "../../src/runner/recovery.ts"
import { readQueue, writeQueue, type QueueState } from "../../src/runner/queue.ts"
import { createRunDirectory } from "../../src/runner/paths.ts"

const NOW = Date.parse("2026-09-13T12:00:00.000Z")

function housekeep(box: Sandbox, nowMs: number) {
  return runHousekeeping({
    storage: box.storage,
    now: () => nowMs,
    // Derived rather than assembled: a hand-built view is one field behind
    // the day a path is added, and the field it is missing points at another
    // root's storage.
    storageForRootKey: (rootKey) => storageForRootKey(box.homeDir, rootKey),
  })
}

/**
 * The same pass, with recovery wired in (issue #110).
 *
 * Reconciliation is a port rather than something housekeeping reaches for,
 * because deciding whether a process is alive needs a probe and this file has
 * no business inventing one — recovery already answers that question, and
 * asking it is the whole of the fix.
 */
function housekeepReconciling(box: Sandbox, nowMs: number, processes: Record<number, string>) {
  const probe = fakeProbe({ processes })
  return runHousekeeping({
    storage: box.storage,
    now: () => nowMs,
    storageForRootKey: (rootKey) => storageForRootKey(box.homeDir, rootKey),
    reconcile: (storage) =>
      reconcileRoot({ storage, probe, timestamp: () => new Date(nowMs).toISOString() }),
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

describe("a root whose execution slot is held by a run nobody is running", () => {
  const CACHE_KEY = "1".repeat(64)
  const ROOT = "2".repeat(64)
  const STUCK = "f".repeat(32)

  /** A root holding a slot for a run that never completed, with a cache. */
  function pinned(box: Sandbox): { storage: Storage; cache: string } {
    const storage = storageForRootKey(box.homeDir, ROOT)
    prepareStorage(storage)
    createRunDirectory(storage, STUCK)
    seedRun(storage, { runId: STUCK, state: "launchAuthorized" })
    writeQueue(storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: STUCK })

    // Old enough that the age rule alone would reclaim it, so what these
    // tests vary is the slot and nothing else.
    const cache = join(storage.rootDir, "DerivedData", CACHE_KEY)
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, "Build.o"), "x".repeat(4096))
    const stale = new Date(NOW - 30 * 24 * 60 * 60 * 1000)
    utimesSync(cache, stale, stale)

    writeRegistry(box.storage, { schemaVersion: 1, roots: { [ROOT]: { lastSeenAtMs: NOW } } })
    return { storage, cache }
  }

  test("keeps its cache when nothing reconciles the slot", () => {
    // The current, correct refusal: a cache is safe to delete because it is
    // regenerable, not because it looks idle, and a held slot is the only
    // evidence available that a build may be writing into it.
    withSandbox((box) => {
      const { cache } = pinned(box)
      housekeep(box, NOW)
      expect(existsSync(cache)).toBe(true)
    })
  })

  test("reclaims its cache once recovery has been asked, slot or no slot", () => {
    // The defect (issue #110), and the insight that fixes it. The guard is
    // about a build *writing* into a cache; the slot is a proxy for that, and
    // a good one only while a run is in flight. This run crashed after
    // `launchAuthorized`, so it still needs finalizing and recovery rightly
    // keeps its slot — but nothing is running, and nothing is writing into
    // that cache. On the machine where this was measured, one such root
    // pinned 25.07 GiB of a 25.40 GiB total.
    withSandbox((box) => {
      const { storage, cache } = pinned(box)

      const outcome = housekeepReconciling(box, NOW, {})

      expect(outcome.status).toBe("ran")
      expect(existsSync(cache)).toBe(false)
      // Not silently worked around: the slot is still held, and the run is
      // still there to be finalized by something that can interpret it.
      expect(readQueue(storage).activeRunId).toBe(STUCK)
    })
  })

  test("does not touch the run's own evidence, which nothing can regenerate", () => {
    // Cache reclamation and evidence eviction are separate events. This run is
    // neither complete nor expired, so nothing here may evict it.
    withSandbox((box) => {
      const { storage } = pinned(box)
      housekeepReconciling(box, NOW, {})
      expect(existsSync(join(storage.runsDir, STUCK))).toBe(true)
    })
  })

  test("leaves a slot alone while its owner is alive", () => {
    // Reconciliation is asked, not overruled: recovery decides liveness from
    // process identity, and a live owner keeps the slot and the cache.
    withSandbox((box) => {
      const { storage, cache } = pinned(box)
      seedRun(storage, {
        runId: STUCK,
        state: "launchAuthorized",
        owner: { pid: 4_242, startedAt: "alive" },
      })

      housekeepReconciling(box, NOW, { 4_242: "alive" })

      expect(readQueue(storage).activeRunId).toBe(STUCK)
      expect(existsSync(cache)).toBe(true)
    })
  })
})

describe("what recovery's verdict is allowed to mean", () => {
  const ROOT = "3".repeat(64)
  const RUN = "e".repeat(32)

  /** A root with an old cache, reclaimable the moment nothing holds it. */
  function withCache(box: Sandbox, queue: Partial<QueueState> = {}): { storage: Storage; cache: string } {
    const storage = storageForRootKey(box.homeDir, ROOT)
    prepareStorage(storage)
    createRunDirectory(storage, RUN)
    seedRun(storage, { runId: RUN, state: "launchAuthorized" })
    // A slot by default, so what these vary is recovery's verdict about it.
    writeQueue(storage, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: RUN, ...queue })

    const cache = join(storage.rootDir, "DerivedData", "4".repeat(64))
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, "Build.o"), "x".repeat(4096))
    const stale = new Date(NOW - 30 * 24 * 60 * 60 * 1000)
    utimesSync(cache, stale, stale)

    writeRegistry(box.storage, { schemaVersion: 1, roots: { [ROOT]: { lastSeenAtMs: NOW } } })
    return { storage, cache }
  }

  /** Housekeeping whose reconciliation returns a status without probing. */
  function housekeepReturning(box: Sandbox, status: RecoveryStatus) {
    return runHousekeeping({
      storage: box.storage,
      now: () => NOW,
      storageForRootKey: (rootKey) => storageForRootKey(box.homeDir, rootKey),
      reconcile: () => ({ status }),
    })
  }

  test("only a status that means recovery looked and found nothing", () => {
    // "Anything but busy" was the tempting shape and it is wrong in three
    // reachable ways. `stillQuarantined` means an identity could not be shown
    // to be gone — an unaccounted-for `xcodebuild` that may be writing the
    // very cache this would delete. `deferred` is returned without probing at
    // all. `failed` means the coordination state could not be read, which the
    // reclamation guard deliberately treats as held.
    for (const status of ["stillQuarantined", "deferred", "failed", "cancelled"] as const) {
      withSandbox((box) => {
        const { cache } = withCache(box)
        housekeepReturning(box, status)
        expect({ status, kept: existsSync(cache) }).toEqual({ status, kept: true })
      })
    }

    for (const status of ["recovered", "alreadyHealthy"] as const) {
      withSandbox((box) => {
        const { cache } = withCache(box)
        housekeepReturning(box, status)
        expect({ status, kept: existsSync(cache) }).toEqual({ status, kept: false })
      })
    }
  })

  test("a quarantined root keeps its caches, slot or no slot", () => {
    // Publishing a quarantine *clears* `activeRunId` — the two must never both
    // look true — so a root held for the strongest possible reason has no slot
    // to show for it. A guard reading only the slot would reclaim the caches
    // of the one kind of root whose lifecycle could not be confirmed.
    withSandbox((box) => {
      const { storage, cache } = withCache(box)
      // A quarantine is published *instead of* a slot, never beside one.
      writeQueue(storage, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [],
        quarantine: { runId: RUN, reason: "terminationUnconfirmed", since: "2026-09-17T00:00:00.000Z" },
      })

      housekeepReturning(box, "recovered")
      expect(existsSync(cache)).toBe(true)
    })
  })

  test("says which roots it left holding, rather than leaving a total unexplained", () => {
    withSandbox((box) => {
      withCache(box)
      const outcome = housekeepReturning(box, "deferred")

      expect(outcome.status).toBe("ran")
      expect(outcome.status === "ran" ? outcome.held : []).toEqual([ROOT])
    })
  })
})
