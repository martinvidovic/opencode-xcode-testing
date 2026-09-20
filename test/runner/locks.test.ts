/**
 * Advisory locking and private storage (#3).
 *
 * The cross-process assertion spawns a second process on purpose: a lock that
 * only excludes callers inside one runtime is exactly the process-local mutex
 * the contract rules out, and only a second process can tell the difference.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  assertSafeDirectory,
  createRunDirectory,
  newRunId,
  rootKeyFor,
  storageFor,
  UnsafeArtifactError,
  writePrivateFileAtomic,
} from "../../src/runner/paths.ts"
import { acquireLock, tryLock, withLock, withTryLock } from "../../src/runner/locks.ts"
import { sandbox, withSandbox } from "./harness.ts"

describe("the advisory lock", () => {
  test("excludes a second holder in the same process", async () => {
    await withSandbox((box) => {
      const held = acquireLock(box.storage.rootLock)
      try {
        expect(tryLock(box.storage.rootLock)).toBeUndefined()
      } finally {
        held.release()
      }
      const after = tryLock(box.storage.rootLock)
      expect(after).toBeDefined()
      after?.release()
    })
  })

  test("excludes a second holder in another process", async () => {
    await withSandbox((box) => {
      const held = acquireLock(box.storage.rootLock)
      try {
        const probe = spawnSync(
          process.execPath,
          [
            "-e",
            `import { tryLock } from "${join(import.meta.dir, "..", "..", "src", "runner", "locks.ts")}";` +
              `process.stdout.write(tryLock(${JSON.stringify(box.storage.rootLock)}) === undefined ? "held" : "free")`,
          ],
          { encoding: "utf8" },
        )
        expect(probe.stdout).toBe("held")
      } finally {
        held.release()
      }
    })
  }, 30_000)

  test("releases even when the work throws", async () => {
    await withSandbox((box) => {
      expect(() =>
        withLock(box.storage.rootLock, () => {
          throw new Error("boom")
        }),
      ).toThrow("boom")
      const after = tryLock(box.storage.rootLock)
      expect(after).toBeDefined()
      after?.release()
    })
  })

  test("lets a try-lock decline rather than queue behind a sibling", async () => {
    await withSandbox((box) => {
      const held = acquireLock(box.storage.registryLock)
      try {
        expect(withTryLock(box.storage.registryLock, () => "ran")).toBeUndefined()
      } finally {
        held.release()
      }
      expect(withTryLock(box.storage.registryLock, () => "ran")).toBe("ran")
    })
  })
})

describe("the storage layout", () => {
  test("preserves the root-level storage identity while keeping its path private", () => {
    const key = storageFor("/home/somebody", "/workspace/example").rootKey
    expect(key).toBe("ee22d65fd4c3c5421d9145d522b67d9aa1a5640bdd893a61ad22efd7bde3cc7c")
    expect(key).not.toContain("workspace")
  })

  test("keys different roots differently and the same root stably", () => {
    expect(rootKeyFor("/a")).not.toBe(rootKeyFor("/b"))
    expect(rootKeyFor("/a")).toBe(rootKeyFor("/a"))
  })

  test("separates module scopes while preserving root-level storage", () => {
    expect(rootKeyFor("/repo", "/repo")).toBe(rootKeyFor("/repo"))
    expect(rootKeyFor("/repo", "/repo/a")).not.toBe(rootKeyFor("/repo", "/repo/b"))
    expect(rootKeyFor("/repo", "/repo/a")).toBe(rootKeyFor("/repo", "/repo/a"))
  })

  test("lives outside the repository, under Application Support", () => {
    const storage = storageFor("/home/somebody", "/workspace/example")
    expect(storage.toolRoot).toBe("/home/somebody/Library/Application Support/opencode-xcode-test")
    expect(storage.rootDir.startsWith(storage.toolRoot)).toBe(true)
  })

  test("creates every directory owner-only", async () => {
    await withSandbox((box) => {
      for (const dir of [box.storage.rootDir, box.storage.runsDir, box.storage.trashDir]) {
        expect(lstatSync(dir).mode & 0o777).toBe(0o700)
      }
    })
  })

  test("rejects a symlink where a directory should be", async () => {
    await withSandbox((box) => {
      const target = join(box.homeDir, "elsewhere")
      mkdirSync(target, { mode: 0o700 })
      const link = join(box.homeDir, "link")
      symlinkSync(target, link)
      expect(() => assertSafeDirectory(link)).toThrow(UnsafeArtifactError)
    })
  })

  test("rejects a directory readable beyond its owner", async () => {
    await withSandbox((box) => {
      const open = join(box.homeDir, "open")
      mkdirSync(open, { mode: 0o755 })
      chmodSync(open, 0o755)
      expect(() => assertSafeDirectory(open)).toThrow(UnsafeArtifactError)
    })
  })
})

describe("run identifiers and directories", () => {
  test("are 128 random bits, carrying no guessable structure", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newRunId()))
    expect(ids.size).toBe(64)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  test("are created atomically, so a collision is refused rather than shared", async () => {
    await withSandbox((box) => {
      const runId = newRunId()
      expect(createRunDirectory(box.storage, runId)).toBeDefined()
      expect(createRunDirectory(box.storage, runId)).toBeUndefined()
    })
  })
})

describe("atomic writes", () => {
  test("leave the file complete and owner-only", async () => {
    await withSandbox((box) => {
      const path = join(box.storage.rootDir, "state.json")
      writePrivateFileAtomic(path, '{"a":1}\n')
      expect(readFileSync(path, "utf8")).toBe('{"a":1}\n')
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
    })
  })

  test("replace an existing file rather than appending to it", async () => {
    await withSandbox((box) => {
      const path = join(box.storage.rootDir, "state.json")
      writeFileSync(path, "old", { mode: 0o600 })
      writePrivateFileAtomic(path, "new")
      expect(readFileSync(path, "utf8")).toBe("new")
    })
  })
})

describe("the sandbox itself", () => {
  test("prepares a storage tree that passes its own safety checks", () => {
    const box = sandbox()
    try {
      assertSafeDirectory(box.storage.runsDir)
    } finally {
      box.dispose()
    }
  })
})
