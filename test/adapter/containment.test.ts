/**
 * Filesystem failures are answers, not crashes (issue #77).
 *
 * Everything an inspection or a recovery touches is a filesystem another
 * process, a full volume, or a permission change can alter between one call
 * and the next. Two things went wrong with that.
 *
 * A digest walk swallowed a directory it could not read and carried on, so it
 * returned a perfectly good digest of a subtree — which compares unequal to
 * the recorded one and is therefore reported as somebody having tampered with
 * the Result Bundle. A permission problem, told as evidence of mutation.
 *
 * Everything else threw. An `lstat` on an entry that had just been removed, a
 * file that could not be opened, a lock that could not be taken: each left the
 * tool boundary as a host error carrying whatever path the operating system
 * put in its message, straight into a model's context.
 *
 * Real directories with real modes throughout. Permission is a property of the
 * filesystem, and a mock would only prove that the mock agrees.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { bundleDigest, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"
import { executeInspect, executeRecover, type ToolDeps } from "../../src/adapter/tools.ts"

/** A bundle with one readable file, and whatever else the test adds. */
function bundle(): string {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-containment-"))
  writeFileSync(join(root, "Info.plist"), "contents")
  return root
}

function withBundle(work: (root: string) => void): void {
  const root = bundle()
  try {
    work(root)
  } finally {
    // Restored first: a directory left at mode 0 cannot be removed through.
    restore(root)
    rmSync(root, { recursive: true, force: true })
  }
}

function restore(root: string): void {
  try {
    chmodSync(root, 0o700)
    chmodSync(join(root, "nested"), 0o700)
  } catch {
    // Whatever the test did not create.
  }
}

describe("digesting a Result Bundle", () => {
  test("refuses to digest a tree whose top it cannot list", () => {
    withBundle((root) => {
      chmodSync(root, 0o000)

      // Not a digest of nothing, and emphatically not a digest: an answer
      // computed over what happened to be readable is a truthful digest of
      // something that is not this bundle.
      expect(bundleDigest(root)).toEqual({ status: "incomplete", reason: "unreadable" })
    })
  })

  test("refuses when a nested directory cannot be listed", () => {
    withBundle((root) => {
      const nested = join(root, "nested")
      mkdirSync(nested)
      writeFileSync(join(nested, "deep.bin"), "deep")
      chmodSync(nested, 0o000)

      // The case the swallowed `catch` was written for, and got wrong. The
      // top of the tree read fine, so the walk carried on and produced a
      // digest over everything except the part it could not see.
      expect(bundleDigest(root)).toEqual({ status: "incomplete", reason: "unreadable" })
    })
  })

  test("refuses when a file cannot be opened", () => {
    withBundle((root) => {
      const blocked = join(root, "blocked.bin")
      writeFileSync(blocked, "secret")
      chmodSync(blocked, 0o000)

      // The same branch an entry that vanished between the listing and the
      // open takes: it was there a moment ago and cannot be examined now, and
      // both mean this is not a tree we finished looking at.
      expect(bundleDigest(root)).toEqual({ status: "incomplete", reason: "unreadable" })
    })
  })

  test("still digests a tree it can read", () => {
    withBundle((root) => {
      // The negative control. Without it, every assertion above would pass on
      // an implementation that called everything unreadable.
      const digested = bundleDigest(root)

      expect(digested.status).toBe("digested")
      if (digested.status !== "digested") return
      expect(digested.digest).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  test("tells a deadline apart from an unreadable tree", () => {
    withBundle((root) => {
      // They ask different things of a caller: one means try again, the other
      // means something on this machine needs looking at. Collapsing them told
      // a caller to retry a permission problem forever.
      expect(bundleDigest(root, 0)).toEqual({ status: "incomplete", reason: "deadline" })
    })
  })
})

describe("a defect that reaches the tool boundary", () => {
  const PLANTED = "/Users/someone/private/checkout"

  function depsThatThrow(where: "inspect" | "recover"): ToolDeps {
    const error = new Error(`EACCES: permission denied, scandir '${PLANTED}/run.xcresult'`)
    return {
      service: {
        start: () => {
          throw new Error("not used")
        },
        inspect: () => {
          if (where === "inspect") return Promise.reject(error)
          return Promise.resolve({ status: "notFound", subject: "run" })
        },
        recover: () => {
          if (where === "recover") return Promise.reject(error)
          return Promise.resolve({ status: "alreadyHealthy" })
        },
      },
    } as unknown as ToolDeps
  }

  test("becomes an ordinary inspection answer rather than a thrown host error", async () => {
    const text = await executeInspect(
      { runId: "a".repeat(32), facet: "failures" },
      {} as never,
      depsThatThrow("inspect"),
    )

    // A defect is an answer about the evidence. The caller is told the
    // retained evidence could not be read, which is exactly what happened.
    expect(text).toContain("incomplete")
    expect(text).toContain("could not be read")
  })

  test("names the kind of failure and never the machine", async () => {
    const text = await executeInspect(
      { runId: "a".repeat(32), facet: "failures" },
      {} as never,
      depsThatThrow("inspect"),
    )

    // Enough to tell a permission denial from a missing file, and nothing
    // that says where this machine keeps things.
    expect(text).toContain("EACCES")
    expect(text).not.toContain(PLANTED)
    expect(text).not.toContain("/Users")
  })

  test("becomes a failed recovery rather than a thrown host error", async () => {
    // With more at stake than inspection: recovery walks storage a crash left
    // behind, so an unreadable lock or a vanished run directory is the
    // expected environment rather than the surprising one.
    const text = await executeRecover({}, {} as never, depsThatThrow("recover"))

    expect(text).toContain("Recovery: failed")
    expect(text).toContain("EACCES")
    expect(text).not.toContain(PLANTED)
  })
})

describe("the redaction itself", () => {
  test("keeps the kind of every representative POSIX failure, and the path of none", () => {
    // The messages the operating system actually produces at these
    // boundaries. Each keeps the errno — which is the part a reader acts on —
    // and loses the path, which is the part that belongs to whoever ran it.
    const cases = [
      "EACCES: permission denied, scandir '/Users/someone/Library/run.xcresult'",
      "ENOENT: no such file or directory, lstat '/private/tmp/xcode-test-abc/x'",
      "EMFILE: too many open files, open '/Users/someone/code/App/Info.plist'",
      "ENOTDIR: not a directory, scandir '/Users/someone/thing/file'",
      "EPERM: operation not permitted, unlink '/Users/someone/locked'",
    ]

    for (const message of cases) {
      const safe = safeFailure(new Error(message))

      expect(safe).toContain(message.slice(0, message.indexOf(":")))
      expect(safe).not.toContain("/Users")
      expect(safe).not.toContain("/private")
    }
  })

  test("says something honest about a value that is not an error at all", () => {
    // A `throw "string"` from anywhere below would otherwise render as
    // `undefined`, which reads like a bug in this tool rather than like one
    // somewhere else.
    expect(safeFailure("a bare string")).toBe("an unrecognized failure")
    expect(safeFailure(undefined)).toBe("an unrecognized failure")
  })
})
