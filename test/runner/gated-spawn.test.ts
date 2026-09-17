/**
 * What the gate does when the spawn itself goes wrong (issue #117).
 *
 * The gate exists so that no `xcodebuild` can be running without the
 * supervisor knowing about it. Every failure here is therefore a failure of
 * the thing that makes that guarantee, and the two ways it can go wrong are
 * opposite: a child that runs when it should not, and a supervisor that waits
 * for a child that will never exist.
 *
 * The second is the quieter one. `recorded` and `exited` are the only two
 * observations supervision has; if a spawn fails in a way that settles
 * neither, the supervisor waits forever holding an Execution Slot, and nothing
 * in the run record ever says why.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { spawnGatedChild, type GateOptions, type GatedChild } from "../../src/runner/gate.ts"
import { withSandbox, type Sandbox } from "./harness.ts"

const SHELL_ARGS = ["-c", "printf out; printf err 1>&2"]

/** An argument `spawn` refuses where it stands, before creating anything. */
const REFUSED_ARGUMENT = String.fromCharCode(0)

/** A gated child over `logPath`, with every option the tests do not care about. */
function gate(box: Sandbox, logPath: string, overrides: Partial<GateOptions> = {}): GatedChild {
  return spawnGatedChild({
    command: "/bin/echo",
    args: ["done"],
    cwd: box.homeDir,
    environment: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    logPath,
    ...overrides,
  })
}

/** The lowest free descriptor number: it only moves when one is being held. */
function lowestFreeDescriptor(): number {
  const fd = openSync("/dev/null", "r")
  closeSync(fd)
  return fd
}

/** Both observations, with a bound, so a test that would hang fails instead. */
async function settle(
  child: GatedChild,
  budgetMs = 5_000,
): Promise<{ recorded: string; exited: string }> {
  const within = (work: Promise<unknown>): Promise<string> =>
    Promise.race([
      work.then(() => "settled", () => "rejected"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), budgetMs)),
    ])
  return { recorded: await within(child.recorded), exited: await within(child.exited) }
}

/**
 * Anything that reached the event loop with nobody listening, while `work`
 * ran. Both kinds: an `error` event with no handler arrives as an uncaught
 * exception, and a rejected promise with no handler as an unhandled
 * rejection. Watching only one of them would pass a regression that moved the
 * failure to the other.
 */
async function unhandled(work: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = []
  const collect = (error: unknown): void => void escaped.push(error)
  process.on("uncaughtException", collect)
  process.on("unhandledRejection", collect)
  try {
    await work()
    // An `EPIPE` on a write that already returned arrives a turn later.
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    process.off("uncaughtException", collect)
    process.off("unhandledRejection", collect)
  }
  return escaped
}

describe("a raw-log path that is not a raw log", () => {
  test("a symlink is refused, and what it points at is untouched", async () => {
    // The run directory is ours, but the log path is the one name in it that
    // a run is guaranteed to open for writing. A link planted there before
    // the run starts redirects every byte `xcodebuild` writes, and `O_APPEND`
    // means the target is added to rather than replaced, so nothing about it
    // looks disturbed afterwards.
    await withSandbox(async (box) => {
      const victim = join(box.homeDir, "victim")
      writeFileSync(victim, "precious", { mode: 0o600 })
      const logPath = join(box.homeDir, "raw.log")
      symlinkSync(victim, logPath)

      const settled = await settle(gate(box, logPath))

      expect(settled.recorded).toBe("rejected")
      expect(settled.exited).toBe("settled")
      expect(readFileSync(victim, "utf8")).toBe("precious")
    })
  })

  test("a named pipe is refused rather than waited on", async () => {
    // Opening a FIFO for writing blocks until somebody opens it for reading.
    // Nobody ever will, so a supervisor that opened it would stop before it
    // had a child, a record, or any way of saying so — the failure with no
    // diagnostic at all.
    await withSandbox(async (box) => {
      const logPath = join(box.homeDir, "raw.log")
      expect(spawnSync("mkfifo", [logPath]).status).toBe(0)

      const settled = await settle(gate(box, logPath), 2_000)

      expect(settled.recorded).toBe("rejected")
      expect(settled.exited).toBe("settled")
    })
  })

  test("a directory is refused", async () => {
    await withSandbox(async (box) => {
      const logPath = join(box.homeDir, "raw.log")
      mkdirSync(logPath, { mode: 0o700 })

      const settled = await settle(gate(box, logPath))

      expect(settled.recorded).toBe("rejected")
    })
  })

  test("an existing log readable beyond its owner is refused", async () => {
    // A raw log holds absolute paths, source excerpts and whatever the build
    // prints. Appending to a file anyone can read publishes all of it.
    await withSandbox(async (box) => {
      const logPath = join(box.homeDir, "raw.log")
      writeFileSync(logPath, "", { mode: 0o644 })

      const settled = await settle(gate(box, logPath))

      expect(settled.recorded).toBe("rejected")
    })
  })
})

describe("a raw log that is what it should be", () => {
  test("is appended to, keeping what a previous attempt wrote", async () => {
    await withSandbox(async (box) => {
      const logPath = join(box.homeDir, "raw.log")
      writeFileSync(logPath, "earlier\n", { mode: 0o600 })

      const child = gate(box, logPath, { command: "/bin/sh", args: SHELL_ARGS })
      child.authorize()
      await child.exited

      expect(readFileSync(logPath, "utf8")).toContain("earlier\n")
    })
  })

  test("takes standard output and standard error in the order the kernel wrote them", async () => {
    // One descriptor for both is the whole design: it is what makes the
    // interleaving authoritative instead of a guess assembled from two pipes.
    await withSandbox(async (box) => {
      const logPath = join(box.homeDir, "raw.log")

      const child = gate(box, logPath, { command: "/bin/sh", args: SHELL_ARGS })
      child.authorize()
      await child.exited

      expect(readFileSync(logPath, "utf8")).toBe("outerr")
    })
  })

  test("is created owner-only when it does not exist yet", async () => {
    await withSandbox(async (box) => {
      const logPath = join(box.homeDir, "raw.log")

      const child = gate(box, logPath)
      child.authorize()
      await child.exited

      expect(statSync(logPath).mode & 0o077).toBe(0)
    })
  })
})

describe("the supervisor's own copy of the log descriptor", () => {
  test("does not outlive the spawn that needed it", async () => {
    // The child holds its own duplicate from the moment it exists. Keeping
    // ours open past that point pins the file for the life of the supervisor
    // and spends a descriptor per attempt, which is how a long-lived process
    // arrives at `EMFILE` for reasons nothing logs.
    await withSandbox(async (box) => {
      const before = lowestFreeDescriptor()

      const child = gate(box, join(box.homeDir, "raw.log"))
      const after = lowestFreeDescriptor()
      child.abandon()
      await child.exited

      expect(after).toBe(before)
    })
  })

  test("is closed even when the spawn refuses the arguments outright", async () => {
    // `spawn` validates its arguments before it creates anything and throws
    // where it stands. The descriptor is already open by then.
    await withSandbox(async (box) => {
      const before = lowestFreeDescriptor()

      const child = gate(box, join(box.homeDir, "raw.log"), { args: [REFUSED_ARGUMENT] })
      const settled = await settle(child)

      expect(lowestFreeDescriptor()).toBe(before)
      expect(settled).toEqual({ recorded: "rejected", exited: "settled" })
    })
  })
})

describe("a child the kernel never creates", () => {
  test("settles both observations instead of leaving supervision waiting", async () => {
    // A working directory that has gone is reported asynchronously, and no
    // `exit` ever follows it — there was no process to exit. Both promises
    // must still settle, because supervision awaits both and holds the run's
    // Execution Slot while it does.
    await withSandbox(async (box) => {
      const settled = await settle(
        gate(box, join(box.homeDir, "raw.log"), { cwd: join(box.homeDir, "gone") }),
      )

      expect(settled).toEqual({ recorded: "rejected", exited: "settled" })
    })
  })

  test("reports that Xcode did not execute, rather than that nobody knows", async () => {
    // `unknown` is reserved for a channel that could not say. Here there was
    // no process, which is a thing this code knows for certain.
    await withSandbox(async (box) => {
      const child = gate(box, join(box.homeDir, "raw.log"), { cwd: join(box.homeDir, "gone") })

      expect(await child.execObserved).toBe("no")
    })
  })

  test("does not take the process down with an unhandled error", async () => {
    // A failed `spawn` arrives as an `error` event, and an `error` event with
    // no listener is a throw out of the event loop. The supervisor is the
    // process holding the deadline and the obligation to publish; it is the
    // last thing that should die of a launch that never happened.
    await withSandbox(async (box) => {
      const escaped = await unhandled(async () => {
        await settle(gate(box, join(box.homeDir, "raw.log"), { cwd: join(box.homeDir, "gone") }))
      })

      expect(escaped).toEqual([])
    })
  })
})

describe("driving a gate whose child is already gone", () => {
  test("authorizing and abandoning stay silent", async () => {
    // Authorization is persisted first and released second, so there is
    // always a window in which the child has exited before the write. An
    // `EPIPE` there arrives after the call has returned, and takes the
    // supervisor with it rather than the run.
    await withSandbox(async (box) => {
      const escaped = await unhandled(async () => {
        const child = gate(box, join(box.homeDir, "raw.log"), { cwd: join(box.homeDir, "gone") })
        await settle(child)

        expect(() => child.authorize()).not.toThrow()
        expect(() => child.abandon()).not.toThrow()
      })

      expect(escaped).toEqual([])
    })
  })

  test("the same, for a child that exited on its own", async () => {
    await withSandbox(async (box) => {
      const escaped = await unhandled(async () => {
        const child = gate(box, join(box.homeDir, "raw.log"), {
          command: "/bin/sh",
          args: ["-c", "exit 0"],
        })
        child.authorize()
        await child.exited

        expect(() => child.authorize()).not.toThrow()
      })

      expect(escaped).toEqual([])
    })
  })
})
