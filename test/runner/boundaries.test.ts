/**
 * The storage and inspection boundary (#26).
 *
 * Every input in this file is one a model can write: the `runId` of an
 * inspection, the container path of a request, and the contents of files that
 * a crash, a full volume, or anything else on the machine may have left
 * behind. The property under test is single and blunt — none of it can read,
 * write, retain or inspect anything outside the containment root it belongs to.
 *
 * These are real temp directories with real symlinks, because the guarantees
 * are filesystem guarantees: a mock would only prove that the mock agrees.
 */

import { describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createRunDirectory,
  isRunId,
  runDirectory,
  sharedDerivedDataFor,
  UnknownRunError,
  type Storage,
} from "../../src/runner/paths.ts"
import { noteRootSeen, readRegistry } from "../../src/runner/housekeeping.ts"
import { readQueue, writeQueue, CoordinationStateError } from "../../src/runner/queue.ts"
import { metadataPath, readRunRecord } from "../../src/runner/state.ts"
import { collectRuns, directorySize, readTombstone, publishTombstone } from "../../src/runner/retention.ts"
import { validateContainerPath } from "../../src/runner/resolution.ts"
import { sandbox, seedRun, withSandbox } from "./harness.ts"

/** Everything a model could put where an opaque handle belongs. */
const HOSTILE_RUN_IDS = [
  "..",
  ".",
  "../../etc",
  "a/../../b",
  "runs/../../queue.json",
  "/etc/passwd",
  "..%2f..%2fetc",
  // A NUL, a space and a dot: separately harmless-looking, and each one a
  // reason a path or an argument list stops meaning what it reads like.
  "run\u0000id",
  "run id",
  "run.id",
  ".hidden",
  "-rf",
  "",
  "a".repeat(65),
]

describe("a caller-supplied run identifier", () => {
  test("is rejected before any path is derived from it", () => {
    for (const runId of HOSTILE_RUN_IDS) {
      expect(isRunId(runId)).toBe(false)
    }
  })

  test("cannot address a directory outside the runs directory", async () => {
    await withSandbox(({ storage }) => {
      for (const runId of HOSTILE_RUN_IDS) {
        expect(() => runDirectory(storage, runId)).toThrow(UnknownRunError)
      }
    })
  })

  test("still accepts the identifiers this tool actually issues", async () => {
    await withSandbox(({ storage }) => {
      const issued = "0f8a2c91b4e7d6538a1c0b2e4f6a8d31"
      expect(isRunId(issued)).toBe(true)
      expect(runDirectory(storage, issued)).toBe(join(storage.runsDir, issued))
    })
  })
})

describe("retention", () => {
  test("never counts bytes it does not own", () => {
    const outside = mkdtempSync(join(tmpdir(), "xcode-test-outside-"))
    const inside = mkdtempSync(join(tmpdir(), "xcode-test-inside-"))
    try {
      writeFileSync(join(outside, "big"), "x".repeat(4_096))
      writeFileSync(join(inside, "small"), "x".repeat(10))
      symlinkSync(join(outside, "big"), join(inside, "link"))

      // A link is not evidence, and counting it would let anything on the
      // machine drive this root's eviction decisions.
      expect(directorySize(inside)).toBe(10)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      rmSync(inside, { recursive: true, force: true })
    }
  })

  test("terminates on a directory link that points back at an ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "xcode-test-loop-"))
    try {
      mkdirSync(join(root, "nested"))
      writeFileSync(join(root, "nested", "file"), "xxx")
      symlinkSync(root, join(root, "nested", "loop"))

      expect(directorySize(root)).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("ignores anything in the runs directory that is not a run of ours", async () => {
    await withSandbox(({ storage }) => {
      createRunDirectory(storage, "run-real")
      seedRun(storage, { runId: "run-real", state: "completed", completedAt: "2026-09-13T10:00:00.000Z" })
      mkdirSync(join(storage.runsDir, ".hidden"))
      writeFileSync(join(storage.runsDir, "loose.json"), "{}\n")
      symlinkSync(storage.trashDir, join(storage.runsDir, "run-link"))

      const runs = collectRuns({ storage, now: () => 0 })
      expect(runs.map((run) => run.runId)).toEqual(["run-real"])
    })
  })

  test("refuses a tombstone that is a link, whatever it points at", async () => {
    await withSandbox(({ storage }) => {
      publishTombstone(storage, "run-real", 1_000)
      const elsewhere = join(storage.rootDir, "planted.json")
      writeFileSync(elsewhere, JSON.stringify({ schemaVersion: 1, runId: "run-fake", expiresAtMs: 1 }))
      symlinkSync(elsewhere, join(storage.tombstonesDir, "run-fake.json"))

      expect(readTombstone(storage, "run-real")).toMatchObject({ runId: "run-real" })
      expect(readTombstone(storage, "run-fake")).toBeUndefined()
    })
  })

  test("refuses a tombstone whose expiry is not a number", async () => {
    await withSandbox(({ storage }) => {
      // `expiresAtMs` is the sort key sweeping deletes by. A NaN comparison
      // does not throw — it silently reorders what gets removed.
      writeFileSync(
        join(storage.tombstonesDir, "run-bad.json"),
        JSON.stringify({ schemaVersion: 1, runId: "run-bad", expiresAtMs: "soon" }),
        { mode: 0o600 },
      )
      expect(readTombstone(storage, "run-bad")).toBeUndefined()
    })
  })
})

describe("durable coordination state", () => {
  test("fails closed on a partly-valid ticket rather than admitting it", async () => {
    await withSandbox(({ storage }) => {
      writeFileSync(
        storage.queueFile,
        JSON.stringify({
          schemaVersion: 1,
          nextSequence: 2,
          tickets: [{ sequence: 1, ticketId: "t", createdAt: "now", deadlineAtMs: 1 }],
        }),
        { mode: 0o600 },
      )
      expect(() => readQueue(storage)).toThrow(CoordinationStateError)
    })
  })

  test("fails closed on an active run identifier that could address anything", async () => {
    await withSandbox(({ storage }) => {
      writeFileSync(
        storage.queueFile,
        JSON.stringify({ schemaVersion: 1, nextSequence: 1, tickets: [], activeRunId: "../../elsewhere" }),
        { mode: 0o600 },
      )
      expect(() => readQueue(storage)).toThrow(CoordinationStateError)
    })
  })

  test("fails closed when the queue file is a symbolic link", async () => {
    await withSandbox(({ storage }) => {
      const planted = join(storage.rootDir, "planted.json")
      writeFileSync(planted, JSON.stringify({ schemaVersion: 1, nextSequence: 1, tickets: [] }))
      symlinkSync(planted, storage.queueFile)

      expect(() => readQueue(storage)).toThrow(CoordinationStateError)
    })
  })

  test("still round-trips the state it writes itself", async () => {
    await withSandbox(({ storage }) => {
      writeQueue(storage, {
        schemaVersion: 1,
        nextSequence: 3,
        tickets: [
          {
            sequence: 2,
            ticketId: "ticket",
            owner: { pid: 42, startedAt: "2026-09-13T10:00:00.000Z" },
            createdAt: "2026-09-13T10:00:00.000Z",
            deadlineAtMs: 5_000,
          },
        ],
        activeRunId: "run-active",
      })
      expect(readQueue(storage).tickets).toHaveLength(1)
      expect(readQueue(storage).activeRunId).toBe("run-active")
    })
  })
})

describe("a caller-supplied container path", () => {
  function repository(build: (root: string) => void): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "xcode-test-container-")))
    build(root)
    return root
  }

  function codesOf(path: string, build: (root: string) => void): string[] {
    const root = repository(build)
    try {
      const errors: Array<{ field: string; code: string }> = []
      validateContainerPath({ kind: "project", path }, root, errors as never)
      return errors.map((error) => error.code)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test("may not leave the repository lexically", () => {
    expect(codesOf("../Other.xcodeproj", () => {})).toEqual(["traversal"])
  })

  test("may not leave the repository through a link", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "xcode-test-elsewhere-")))
    try {
      mkdirSync(join(outside, "Other.xcodeproj"))
      expect(
        codesOf("Escape.xcodeproj", (root) => {
          symlinkSync(join(outside, "Other.xcodeproj"), join(root, "Escape.xcodeproj"))
        }),
      ).toEqual(["symlinkEscape"])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("may not be absolute", () => {
    expect(codesOf("/etc/Other.xcodeproj", () => {})).toEqual(["notRelative"])
  })

  test("yields the canonical path, so what is validated is what is executed", () => {
    const root = repository((created) => {
      mkdirSync(join(created, "real", "App.xcodeproj"), { recursive: true })
      symlinkSync(join(created, "real"), join(created, "link"))
    })
    try {
      const validated = validateContainerPath(
        { kind: "project", path: "link/App.xcodeproj" },
        root,
        [] as never,
      )
      expect(validated?.absolutePath).toBe(join(root, "real", "App.xcodeproj"))
      // The relative path is still the one a result explains itself with.
      expect(validated?.container.path).toBe("link/App.xcodeproj")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("shared DerivedData", () => {
  function storage(): Storage {
    return sandbox().storage
  }

  test("is a different directory for each container in one repository", () => {
    const store = storage()
    const first = sharedDerivedDataFor(store, "/repo/One.xcodeproj")
    const second = sharedDerivedDataFor(store, "/repo/Two.xcodeproj")

    expect(first).not.toBe(second)
    // Both still live inside this root's private storage.
    expect(first.startsWith(store.rootDir)).toBe(true)
    expect(second.startsWith(store.rootDir)).toBe(true)
  })

  test("is stable for the same canonical container", () => {
    const store = storage()
    expect(sharedDerivedDataFor(store, "/repo/One.xcodeproj")).toBe(
      sharedDerivedDataFor(store, "/repo/One.xcodeproj"),
    )
  })

  test("names no part of the container's path", () => {
    const store = storage()
    const path = sharedDerivedDataFor(store, "/Users/someone/Secret/App.xcodeproj")
    // Only the leaf is ours to judge: everything above it is the tool root,
    // which says nothing about the container.
    const leaf = path.slice(store.rootDir.length)
    expect(leaf).not.toContain("someone")
    expect(leaf).not.toContain("Secret")
    expect(leaf).not.toContain("App.xcodeproj")
  })
})

describe("the user-wide registry", () => {
  test("is rebuilt rather than trusted when a root key could name anything", async () => {
    await withSandbox(({ storage }) => {
      // Every key here becomes a directory housekeeping renames and deletes
      // recursively. One that escapes the tool root would evict someone's
      // documents, so the whole file is discarded rather than partly believed.
      writeFileSync(
        storage.registryFile,
        JSON.stringify({
          schemaVersion: 1,
          roots: { "../../../Documents": { lastSeenAtMs: 1 } },
        }),
        { mode: 0o600 },
      )
      expect(readRegistry(storage).roots).toEqual({})
    })
  })

  test("is rebuilt when it is a symbolic link", async () => {
    await withSandbox(({ storage }) => {
      const planted = join(storage.rootDir, "planted.json")
      writeFileSync(
        planted,
        JSON.stringify({ schemaVersion: 1, roots: { [storage.rootKey]: { lastSeenAtMs: 1 } } }),
      )
      symlinkSync(planted, storage.registryFile)

      expect(readRegistry(storage).roots).toEqual({})
    })
  })

  test("still round-trips the keys this tool produces", async () => {
    await withSandbox(({ storage }) => {
      noteRootSeen(storage, 1_000)
      expect(Object.keys(readRegistry(storage).roots)).toEqual([storage.rootKey])
    })
  })
})

describe("a persisted run record", () => {
  test("is unreadable when its recorded process group could be any group", async () => {
    await withSandbox(({ storage }) => {
      // `child.pgid` is passed to kill(2). A record that reached recovery with
      // a planted value would signal a process group of its own choosing —
      // the sharpest thing anything in this codebase does.
      createRunDirectory(storage, "run-bad")
      writeFileSync(
        metadataPath(storage, "run-bad"),
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-bad",
          rootKey: storage.rootKey,
          state: "childRecorded",
          admittedAt: "2026-09-13T10:00:00.000Z",
          timeoutSeconds: 900,
          child: { pid: 5, startedAt: "then", pgid: -1 },
        }),
        { mode: 0o600 },
      )
      expect(readRunRecord(storage, "run-bad")).toBeUndefined()
    })
  })

  test("is unreadable when it claims to belong to another root", async () => {
    await withSandbox(({ storage }) => {
      createRunDirectory(storage, "run-bad")
      writeFileSync(
        metadataPath(storage, "run-bad"),
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-bad",
          rootKey: "not-a-root-key",
          state: "admitted",
          admittedAt: "2026-09-13T10:00:00.000Z",
          timeoutSeconds: 900,
        }),
        { mode: 0o600 },
      )
      expect(readRunRecord(storage, "run-bad")).toBeUndefined()
    })
  })

  test("still round-trips what the runner writes", async () => {
    await withSandbox(({ storage }) => {
      createRunDirectory(storage, "run-good")
      seedRun(storage, {
        runId: "run-good",
        child: { pid: 5, startedAt: "then", pgid: 5 },
      })
      expect(readRunRecord(storage, "run-good")).toMatchObject({ runId: "run-good" })
    })
  })

  test("is unreadable when its metadata is a symbolic link", async () => {
    await withSandbox(({ storage }) => {
      createRunDirectory(storage, "run-linked")
      const planted = join(storage.rootDir, "planted.json")
      writeFileSync(
        planted,
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-linked",
          rootKey: storage.rootKey,
          state: "admitted",
          admittedAt: "2026-09-13T10:00:00.000Z",
          timeoutSeconds: 900,
        }),
      )
      symlinkSync(planted, metadataPath(storage, "run-linked"))

      expect(readRunRecord(storage, "run-linked")).toBeUndefined()
    })
  })
})

describe("two containment roots", () => {
  test("share no run storage, even for the same run identifier", async () => {
    await withSandbox(({ homeDir, storage }) => {
      const other = sandbox("/workspace/other")
      try {
        createRunDirectory(storage, "run-same")
        seedRun(storage, { runId: "run-same" })

        // The identifier is the same string; the directories are not, and
        // nothing a caller supplies can make them meet.
        expect(runDirectory(storage, "run-same")).not.toBe(runDirectory(other.storage, "run-same"))
        expect(readdirSync(other.storage.runsDir)).toEqual([])
      } finally {
        other.dispose()
      }
      expect(homeDir.length).toBeGreaterThan(0)
    })
  })
})
