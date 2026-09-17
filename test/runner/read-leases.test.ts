/**
 * Read leases, and what housekeeping does about them (issue #116).
 *
 * User-wide retention runs in whichever OpenCode instance reaches the hour
 * first. It evicts completed runs by age and by byte target, and it did that
 * without any way of knowing that a *different* instance, in a different
 * window, was in the middle of reading one. The reader is told `notFound` for
 * evidence that existed when it asked, or meets an `ENOENT` part-way through a
 * Result Bundle it had already opened.
 *
 * So the lease is a file. That is not an implementation detail here — it is
 * the property: the two processes share nothing else, and a set held in memory
 * is a claim one instance makes to itself while the other one deletes. These
 * tests therefore publish leases from a genuinely separate process wherever
 * the point is cross-process visibility.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { noteRootSeen, runHousekeeping, STALE_ROOT_MAX_AGE_MS } from "../../src/runner/housekeeping.ts"
import { acquireReadLease, anyLeaseHeld, LEASE_LIFETIME_MS, reconcileLeases } from "../../src/runner/leases.ts"
import { createRunDirectory, runDirectory, storageForRootKey, type Storage } from "../../src/runner/paths.ts"
import { writeQueue } from "../../src/runner/queue.ts"
import { RETENTION } from "../../src/runner/retention.ts"
import { seedRun, withSandbox, type Sandbox } from "./harness.ts"

const NOW = Date.parse("2026-09-13T12:00:00.000Z")
const OLD_RUN = "a".repeat(32)

/** A completed run old enough that age alone evicts it. */
function ancientRun(box: Sandbox, runId = OLD_RUN): void {
  createRunDirectory(box.storage, runId)
  seedRun(box.storage, {
    runId,
    state: "completed",
    completedAt: new Date(NOW - RETENTION.maxAgeMs - 60_000).toISOString(),
  })
  writeFileSync(join(runDirectory(box.storage, runId), "index.json"), "{}", { mode: 0o600 })
}

function housekeep(box: Sandbox, nowMs = NOW, seenAtMs = nowMs) {
  // Registered, because the registry is the only record that a root exists
  // and a pass visits what the registry names. `seenAtMs` is when the root
  // was last *opened*, which is the only thing whole-root collection judges
  // it by.
  noteRootSeen(box.storage, seenAtMs)
  return runHousekeeping({
    storage: box.storage,
    now: () => nowMs,
    storageForRootKey: (rootKey) => storageForRootKey(box.homeDir, rootKey),
  })
}

/**
 * Publish a lease from a separate process, and leave it behind.
 *
 * The process exits immediately; the file is what outlives it, which is the
 * whole mechanism. Nothing in the calling process ever knows this lease
 * exists except by reading the root.
 */
function leaseFromAnotherProcess(storage: Storage, runId: string, nowMs: number): void {
  const module = join(import.meta.dir, "..", "..", "src", "runner", "leases.ts")
  const script = [
    `import { acquireReadLease } from ${JSON.stringify(module)}`,
    `acquireReadLease(${JSON.stringify({ leasesDir: storage.leasesDir })}, ${JSON.stringify(runId)}, ${nowMs})`,
  ].join("\n")
  const spawned = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" })
  expect(spawned.status).toBe(0)
}

describe("an old completed run another process is reading", () => {
  test("is not evicted, though age alone would evict it", async () => {
    // The production path, start to finish: a lease published by a process
    // that has already exited, and a housekeeping pass in this one that has
    // to notice it.
    await withSandbox((box) => {
      ancientRun(box)
      leaseFromAnotherProcess(box.storage, OLD_RUN, NOW)

      const outcome = housekeep(box)

      expect(outcome.status).toBe("ran")
      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(true)
    })
  })

  test("becomes evictable again once the lease is released", async () => {
    // The other half, and the one that says this is a lease rather than a
    // pin: evidence held while it is being read, and let go afterwards.
    await withSandbox((box) => {
      ancientRun(box)
      const lease = acquireReadLease(box.storage, OLD_RUN, NOW)
      lease.release()

      housekeep(box)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(false)
    })
  })

  test("is let go when its holder crashed, rather than pinned for ever", async () => {
    // Nobody releases a lease held by a process that died. The bound is what
    // makes that survivable without a process probe — and a probe is the
    // wrong instrument anyway, since PID reuse would make a lease outlive its
    // holder in exactly the case it exists to cover.
    await withSandbox((box) => {
      ancientRun(box)
      leaseFromAnotherProcess(box.storage, OLD_RUN, NOW)

      housekeep(box, NOW + LEASE_LIFETIME_MS + 1)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(false)
    })
  })
})

describe("a lease that cannot be read", () => {
  test("stops everything in the root from being evicted", async () => {
    // The fact that is missing is *which* run is being read, so the only safe
    // answer covers all of them. Deleting is irreversible; waiting a pass is
    // not.
    await withSandbox((box) => {
      ancientRun(box)
      writeFileSync(join(box.storage.leasesDir, "broken.json"), "{ not json", { mode: 0o600 })

      housekeep(box)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(true)
    })
  })

  test("is not a pin: it ages out like any other lease", async () => {
    await withSandbox((box) => {
      ancientRun(box)
      const path = join(box.storage.leasesDir, "broken.json")
      writeFileSync(path, "{ not json", { mode: 0o600 })
      const old = (NOW - LEASE_LIFETIME_MS - 60_000) / 1000
      utimesSync(path, old, old)

      housekeep(box)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(false)
      expect(existsSync(path)).toBe(false)
    })
  })

  test("a leases directory that cannot be listed is held, not ignored", async () => {
    await withSandbox((box) => {
      rmSync(box.storage.leasesDir, { recursive: true, force: true })
      writeFileSync(box.storage.leasesDir, "not a directory", { mode: 0o600 })

      expect(anyLeaseHeld(reconcileLeases(box.storage, NOW))).toBe(true)
    })
  })

  test("but a root that has never been inspected is not", async () => {
    // Absent is absent. Reading "no leases directory" as "something may be
    // held" would mean no root is ever maintained until it has been inspected
    // once.
    await withSandbox((box) => {
      rmSync(box.storage.leasesDir, { recursive: true, force: true })

      expect(anyLeaseHeld(reconcileLeases(box.storage, NOW))).toBe(false)
    })
  })
})

describe("a queue nobody can read", () => {
  test("protects the whole root's evidence rather than none of it", async () => {
    // "No run is active" and "nobody could say" are different facts, and only
    // one is permission to delete. Answering `undefined` here would make the
    // root whose ownership is least known the one whose evidence is least
    // protected — and every neighbouring decision about this same file fails
    // closed.
    await withSandbox((box) => {
      ancientRun(box)
      writeFileSync(box.storage.queueFile, "{ not json", { mode: 0o600 })

      housekeep(box)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(true)
    })
  })
})

describe("the run that holds the execution slot", () => {
  test("keeps its evidence, though its metadata says it is evictable", async () => {
    // Retention judges a run by its Run Record, and a record can say
    // `completed` while the queue still names that run as the active one —
    // a run finalizing, or one whose slot has not yet been released. The
    // queue is the authority on which run owns the root, and housekeeping
    // now reads it under the root lock rather than being told.
    await withSandbox((box) => {
      ancientRun(box)
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [],
        activeRunId: OLD_RUN,
      })

      housekeep(box)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(true)
    })
  })

  test("and its neighbours do not", async () => {
    // The protection is one run's, not the root's. A pass that stopped at the
    // first protected run would leave a root that never converges.
    await withSandbox((box) => {
      ancientRun(box)
      ancientRun(box, "b".repeat(32))
      writeQueue(box.storage, {
        schemaVersion: 1,
        nextSequence: 2,
        tickets: [],
        activeRunId: OLD_RUN,
      })

      housekeep(box)

      expect(existsSync(runDirectory(box.storage, OLD_RUN))).toBe(true)
      expect(existsSync(runDirectory(box.storage, "b".repeat(32)))).toBe(false)
    })
  })
})

describe("a lease under a root that would otherwise be collected whole", () => {
  test("stops the collection", async () => {
    // `lastSeenAtMs` records when a root was last *opened*, and inspecting
    // two-month-old evidence does not open it. So the timestamp can say sixty
    // days while another process has a Result Bundle in this tree open now —
    // and whole-root collection renames the tree, which takes the evidence
    // and the reader's descriptors with it.
    await withSandbox((box) => {
      ancientRun(box)
      leaseFromAnotherProcess(box.storage, OLD_RUN, NOW)

      // Last opened long enough ago to be collected whole, which is the
      // situation the lease has to survive: collection renames the entire
      // tree, taking the evidence and the reader's descriptors with it.
      const outcome = housekeep(box, NOW, NOW - STALE_ROOT_MAX_AGE_MS - 60_000)
      expect(outcome.status).toBe("ran")
      if (outcome.status !== "ran") return

      expect(outcome.staleRoots).toEqual([])
      expect(existsSync(box.storage.rootDir)).toBe(true)
    })
  })

  test("and without one, that root does go", async () => {
    // The other half. Without it the test above would pass against a
    // collector that never collects anything.
    await withSandbox((box) => {
      ancientRun(box)

      const outcome = housekeep(box, NOW, NOW - STALE_ROOT_MAX_AGE_MS - 60_000)
      expect(outcome.status).toBe("ran")
      if (outcome.status !== "ran") return

      expect(outcome.staleRoots).toEqual([box.storage.rootKey])
      expect(existsSync(box.storage.rootDir)).toBe(false)
    })
  })
})

describe("the lease file itself", () => {
  test("names the run and nothing about the machine", async () => {
    await withSandbox((box) => {
      acquireReadLease(box.storage, OLD_RUN, NOW)

      const names = readdirSync(box.storage.leasesDir)
      expect(names).toHaveLength(1)
      expect(reconcileLeases(box.storage, NOW).runs).toEqual(new Set([OLD_RUN]))
    })
  })

  test("does not stop a second reader of the same run", async () => {
    // Two windows reading one run is the ordinary case, and a lease that
    // excluded the second would be a lock — which is not what this is.
    await withSandbox((box) => {
      const first = acquireReadLease(box.storage, OLD_RUN, NOW)
      acquireReadLease(box.storage, OLD_RUN, NOW)
      first.release()

      expect(reconcileLeases(box.storage, NOW).runs).toEqual(new Set([OLD_RUN]))
    })
  })
})
