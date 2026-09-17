/**
 * Loading the root's cursor-signing key (issue #118).
 *
 * The key decides whether an opaque cursor is `stale` or `invalid`, so two
 * properties matter and they pull against each other. A key that is valid must
 * come back byte-identical every time, or a restart would silently reclassify
 * every outstanding cursor as tampered; and a key that is not demonstrably
 * ours must never be used, however plausible the bytes at that path look.
 *
 * Both are properties of a single opened object. Checking a pathname and then
 * reading the same pathname is two objects as far as the kernel is concerned,
 * with a window between them in which the first can stop being the second.
 */

import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { cursorSecretPath, loadCursorSecret, SECRET_BYTES } from "../../src/runner/secrets.ts"
import { sandbox, withSandbox, type Sandbox } from "./harness.ts"

/** Bytes no text decoder survives: a NUL, a lone continuation byte, a lone surrogate's lead. */
const HOSTILE = Buffer.from(
  Array.from({ length: SECRET_BYTES }, (_, index) => [0x00, 0x80, 0xed, 0xa0, 0xff][index % 5] ?? 0),
)

describe("a root with no key yet", () => {
  test("gets one, of the documented size and owner-only", async () => {
    await withSandbox((box) => {
      const secret = loadCursorSecret(box.storage)

      expect(secret.length).toBe(SECRET_BYTES)
      expect(statSync(cursorSecretPath(box.storage)).mode & 0o077).toBe(0)
    })
  })

  test("and the same one on every later load, because cursors outlive processes", async () => {
    await withSandbox((box) => {
      const first = loadCursorSecret(box.storage)
      const second = loadCursorSecret(box.storage)

      expect(second.equals(first)).toBe(true)
    })
  })
})

describe("a valid key that is not text", () => {
  // The key is 32 random bytes. Roughly every one of them contains a byte
  // sequence no UTF-8 decoder can represent, and a read that goes through a
  // string returns the replacement character instead — a different key, read
  // as if it were the same one, which is the worst of the available failures:
  // every cursor becomes `invalid` and nothing on disk looks wrong.
  test("comes back byte-identical, NULs and invalid UTF-8 included", async () => {
    await withSandbox((box) => {
      writeFileSync(cursorSecretPath(box.storage), HOSTILE, { mode: 0o600 })

      const loaded = loadCursorSecret(box.storage)

      expect(loaded.equals(HOSTILE)).toBe(true)
    })
  })

  test("is not rewritten by the load, so it survives the next one too", async () => {
    await withSandbox((box) => {
      const path = cursorSecretPath(box.storage)
      writeFileSync(path, HOSTILE, { mode: 0o600 })

      loadCursorSecret(box.storage)

      expect(readFileSync(path).equals(HOSTILE)).toBe(true)
    })
  })
})

describe("a key this tool cannot vouch for", () => {
  /** What a load leaves behind at the key path, given what was there before. */
  function loadOver(prepare: (path: string, box: Sandbox) => void): { secret: Buffer; onDisk: Buffer } {
    const box = sandbox()
    try {
      const path = cursorSecretPath(box.storage)
      prepare(path, box)
      return { secret: loadCursorSecret(box.storage), onDisk: readFileSync(path) }
    } finally {
      box.dispose()
    }
  }

  test("a symlink is replaced rather than followed", () => {
    // The pointed-at file is 32 bytes and owner-only: everything a check of
    // the resolved target would approve of. It is still someone else's choice
    // of key, and signing with it would let them mint cursors.
    const planted = Buffer.alloc(SECRET_BYTES, 7)
    const { secret, onDisk } = loadOver((path, box) => {
      const target = join(box.homeDir, "planted")
      writeFileSync(target, planted, { mode: 0o600 })
      symlinkSync(target, path)
    })

    expect(secret.equals(planted)).toBe(false)
    expect(onDisk.equals(secret)).toBe(true)
  })

  test("a file readable beyond its owner is replaced", () => {
    const { secret } = loadOver((path) => {
      writeFileSync(path, Buffer.alloc(SECRET_BYTES, 9), { mode: 0o600 })
      chmodSync(path, 0o644)
    })

    expect(secret.equals(Buffer.alloc(SECRET_BYTES, 9))).toBe(false)
    expect(secret.length).toBe(SECRET_BYTES)
  })

  test("a file of the wrong size is replaced, short or long", () => {
    for (const size of [SECRET_BYTES - 1, SECRET_BYTES + 1, 0]) {
      const { secret, onDisk } = loadOver((path) => {
        writeFileSync(path, Buffer.alloc(size, 3), { mode: 0o600 })
      })

      expect(secret.length).toBe(SECRET_BYTES)
      expect(onDisk.equals(secret)).toBe(true)
    }
  })

  test("a directory is refused outright rather than reused or destroyed", () => {
    // Nothing here can tell what a directory at this path means, and the two
    // available guesses are both bad: deriving cursors from it is nonsense,
    // and removing it destroys whatever it holds. Failing is the answer.
    const box = sandbox()
    try {
      const path = cursorSecretPath(box.storage)
      mkdirSync(path, { mode: 0o700 })
      writeFileSync(join(path, "someones-data"), "kept")

      expect(() => loadCursorSecret(box.storage)).toThrow()
      expect(readFileSync(join(path, "someones-data"), "utf8")).toBe("kept")
    } finally {
      box.dispose()
    }
  })
})

describe("replacement, once it happens", () => {
  test("leaves no temporary file beside the key", async () => {
    // A `.tmp` sibling left behind is a copy of the signing key with nobody
    // responsible for it.
    await withSandbox((box) => {
      writeFileSync(cursorSecretPath(box.storage), Buffer.alloc(8), { mode: 0o600 })
      loadCursorSecret(box.storage)

      const strays = readdirSync(box.storage.rootDir).filter((name) => name.endsWith(".tmp"))
      expect(strays).toEqual([])
    })
  })

  test("writes the new key owner-only, not merely renames it into place", async () => {
    await withSandbox((box) => {
      const path = cursorSecretPath(box.storage)
      writeFileSync(path, Buffer.alloc(8), { mode: 0o600 })
      loadCursorSecret(box.storage)

      expect(statSync(path).mode & 0o077).toBe(0)
    })
  })
})

describe("the window between deciding a key is safe and reading it", () => {
  /**
   * The race, made deterministic.
   *
   * A pathname check followed by a pathname read is two resolutions of the
   * same name, and nothing holds the name still between them. Waiting for a
   * real attacker to win that window is not a test, so the window is opened
   * from inside the check: the ownership assertion asks the process for its
   * uid, and answering is the last thing that happens before the bytes are
   * read. What `during` does therefore lands after validation and before the
   * read — precisely the window — and `loadWhile` fails if the question is
   * never asked, because a window that stopped being opened would otherwise
   * turn every test here into one that passes by doing nothing.
   */
  function loadWhile(
    prepare: (path: string, box: Sandbox) => void,
    during: (path: string, box: Sandbox) => void,
  ): { secret: Buffer; onDisk: Buffer } {
    const box = sandbox()
    const real = process.getuid
    let opened = false
    try {
      const path = cursorSecretPath(box.storage)
      prepare(path, box)
      Object.defineProperty(process, "getuid", {
        configurable: true,
        value: () => {
          if (!opened) {
            opened = true
            during(path, box)
          }
          return real?.call(process) ?? 0
        },
      })
      const secret = loadCursorSecret(box.storage)
      expect(opened).toBe(true)
      return { secret, onDisk: readFileSync(path) }
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: real })
      box.dispose()
    }
  }

  test("cannot be used to substitute a different key", () => {
    // A key loaded through one descriptor does not care what the name points
    // at by the time it is read; a key loaded by name gets whatever was
    // swapped in, and signs every cursor with somebody else's choice.
    const ours = Buffer.alloc(SECRET_BYTES, 1)
    const theirs = Buffer.alloc(SECRET_BYTES, 2)
    const { secret } = loadWhile(
      (path, box) => {
        writeFileSync(path, ours, { mode: 0o600 })
        const target = join(box.homeDir, "theirs")
        writeFileSync(target, theirs, { mode: 0o600 })
        symlinkSync(target, join(box.homeDir, "link"))
      },
      (path, box) => renameSync(join(box.homeDir, "link"), path),
    )

    expect(secret.equals(theirs)).toBe(false)
    expect(secret.equals(ours)).toBe(true)
  })

  test("is not read past the size that was validated", () => {
    // The descriptor said eight bytes, which is not a key. Deciding that from
    // the bytes that arrive instead of from the size that was checked means
    // accepting a key nothing ever validated.
    const grown = Buffer.alloc(SECRET_BYTES, 5)
    const { secret } = loadWhile(
      (path) => writeFileSync(path, Buffer.alloc(8), { mode: 0o600 }),
      (path) => writeFileSync(path, grown, { mode: 0o600 }),
    )

    expect(secret.length).toBe(SECRET_BYTES)
    expect(secret.equals(grown)).toBe(false)
  })

  test("is not accepted short when the file shrinks before the read", () => {
    // The mirror image: validated at 32 bytes and truncated before the read.
    // A short buffer returned here is a weaker key than the contract says,
    // and nothing downstream would notice.
    const { secret } = loadWhile(
      (path) => writeFileSync(path, Buffer.alloc(SECRET_BYTES, 6), { mode: 0o600 }),
      (path) => writeFileSync(path, Buffer.alloc(4), { mode: 0o600 }),
    )

    expect(secret.length).toBe(SECRET_BYTES)
  })

  test("a failure that says nothing about the key is raised, not answered with a new key", () => {
    // The difference between "this key is unusable" and "this machine is
    // momentarily unable to answer". Treating the second as the first throws
    // away a perfectly good key — and every cursor derived from it — for a
    // condition that passes on its own.
    const transient = Object.assign(new Error("too many open files"), { code: "EMFILE" })
    const original = Buffer.alloc(SECRET_BYTES, 8)

    expect(() =>
      loadWhile(
        (path) => writeFileSync(path, original, { mode: 0o600 }),
        () => {
          throw transient
        },
      ),
    ).toThrow(transient)
  })
})

describe("the descriptor the load opens", () => {
  test("is closed whichever way the load ends", async () => {
    // The lowest free descriptor number is the cheapest honest witness there
    // is: it only moves if something is still holding one. A leak here is
    // invisible until a long-lived host runs out of them, which is the worst
    // way to find out.
    await withSandbox((box) => {
      const probe = () => {
        const fd = openSync("/dev/null", "r")
        closeSync(fd)
        return fd
      }
      const path = cursorSecretPath(box.storage)
      const before = probe()

      loadCursorSecret(box.storage) // created
      loadCursorSecret(box.storage) // read back
      writeFileSync(path, Buffer.alloc(3), { mode: 0o600 })
      loadCursorSecret(box.storage) // refused for its size, then replaced

      expect(probe()).toBe(before)
    })
  })
})
