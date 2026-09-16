/**
 * Cancellation and post-admission failure through the service (#3, issue #22).
 *
 * These drive the real admission and supervision path with a stand-in runtime,
 * so the outcomes a caller actually receives are asserted rather than the
 * internal states that produce them. No Xcode is involved: the point is what
 * the Test Tool says happened, not what Xcode did.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TestToolResult } from "../../src/domain/result.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"
import { createTestToolService, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { prepareStorage, storageFor } from "../../src/runner/paths.ts"
import { systemProbe } from "../../src/runner/identity.ts"
import { readQueue } from "../../src/runner/queue.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { infrastructureReason, interruption, summaryOf } from "./scenarios.ts"

/** A trusted root with a container that exists, so nothing has to be discovered. */
function project(): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-cancel-"))
  mkdirSync(join(root, "Example.xcodeproj"), { recursive: true })
  writeFileSync(join(root, "Example.xcodeproj", "project.pbxproj"), "// generic fixture\n")
  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const REQUEST = {
  requestedScope: { kind: "all" as const },
  xcodeContainer: { kind: "project" as const, path: "Example.xcodeproj" },
  scheme: "App",
  destination: { kind: "named" as const, platform: "iOS Simulator", name: "iPhone 17" },
}

type Harness = {
  service: ReturnType<typeof createTestToolService>
  environment: ServiceEnvironment
  /** Script the stub supervisor: `silent` never handshakes, `crash` exits non-zero. */
  scriptStub(mode: "silent" | "crash"): void
  dispose(): void
}

const STUB_SUPERVISOR = join(import.meta.dir, "..", "runner", "stub", "stub-supervisor.ts")

/**
 * `entrypoint` selects the supervisor stand-in: the protocol-speaking stub, or
 * a binary that never speaks it at all.
 */
function harness(entrypoint: string): Harness {
  const runtimePath = entrypoint === STUB_SUPERVISOR ? process.execPath : entrypoint
  const repo = project()
  const home = mkdtempSync(join(tmpdir(), "xcode-test-home-"))
  const storage = storageFor(home, repo.root)
  prepareStorage(storage)

  const environment: ServiceEnvironment = {
    storage,
    trustedRoot: repo.root,
    homeDir: home,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: runtimePath },
    supervisorEntrypoint: entrypoint,
    now: () => Date.now(),
    timestamp: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 5),
    // Short enough that the handshake-timeout path is reachable in a test.
    handshakeDeadlineMs: 750,
    xcresultToolFor: () => ({
      identity: identityFor(loadFixture("passed")),
      run: async () => ({ ok: false as const, failure: "bundleMissing" as const, message: "none" }),
    }),
  }

  return {
    service: createTestToolService(environment),
    environment,
    scriptStub(mode) {
      writeFileSync(join(repo.root, ".stub-mode"), `${mode}\n`)
    },
    dispose() {
      repo.dispose()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

async function withHarness<T>(entrypoint: string, work: (h: Harness) => Promise<T>): Promise<T> {
  const h = harness(entrypoint)
  try {
    return await work(h)
  } finally {
    h.dispose()
  }
}

const noop = { onState: () => {} }

/** A cancellation the test flips by hand, so *when* it arrives is controlled. */
function deferredCancellation() {
  let aborted = false
  let announce: () => void = () => {}
  const whenAborted = new Promise<void>((resolve) => {
    announce = resolve
  })
  return {
    signal: {
      get aborted() {
        return aborted
      },
      whenAborted,
    },
    cancel() {
      aborted = true
      announce()
    },
  }
}

describe("a supervisor that fails after admission", () => {
  test("reports a run-scoped infrastructure failure, not a queued one", async () => {
    // The run was admitted and has a runId. Reporting it as a queued failure
    // would tell the caller no Test Run ever existed, and hide the run they
    // could otherwise inspect.
    await withHarness("/bin/false", async (h) => {
      const result: TestToolResult = await h.service.start(REQUEST, noop).result

      expect(result.outcome).toBe("infrastructureFailed")
      expect(infrastructureReason(result)).toBe("runnerFailure")
    })
  }, 30_000)

  test("gives the execution slot back rather than leaking it", async () => {
    await withHarness("/bin/false", async (h) => {
      await h.service.start(REQUEST, noop).result
      expect(readQueue(h.environment.storage).activeRunId).toBeUndefined()
    })
  }, 30_000)

  test("leaves the run in a coherent terminal state", async () => {
    await withHarness("/bin/false", async (h) => {
      const result = await h.service.start(REQUEST, noop).result
      if (!isTestRunSummary(result)) throw new Error("expected a Test Run summary")

      const record = readRunRecord(h.environment.storage, result.runId)
      expect(record?.state).toBe("completed")
      expect(record?.completedAt).toBeDefined()
    })
  }, 30_000)
})

describe("cancellation during interpretation", () => {
    async function cancelAfterAdmission(h: Harness) {
      const { signal, cancel } = deferredCancellation()
      const handle = h.service.start(REQUEST, noop, signal)
      // Cancelling only once the run holds the slot puts the cancellation past
      // admission and into the work that follows it.
      await handle.admitted
      cancel()
      return handle.result
    }

  test("returns cancelled in phase interpreting", async () => {
    // The process deadline is no longer active once the process is gone, so a
    // cancellation here is a cancellation — not a timeout, and not a defect.
    await withHarness(STUB_SUPERVISOR, async (h) => {
      const result = await cancelAfterAdmission(h)

      expect(result.outcome).toBe("cancelled")
      if (!isTestRunSummary(result)) throw new Error("expected a Test Run summary")
      expect(interruption(result)).toBe("interpreting")
    })
  }, 30_000)

  test("is not a process-termination trigger", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      const result = await cancelAfterAdmission(h)

      if (!isTestRunSummary(result)) throw new Error("expected a Test Run summary")
      expect(result.terminationTrigger).toBe("none")
      expect(result.termination.requested).toBe("no")
    })
  }, 30_000)

  test("still releases the execution slot", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      await cancelAfterAdmission(h)
      expect(readQueue(h.environment.storage).activeRunId).toBeUndefined()
    })
  }, 30_000)
})

describe("a supervisor that never speaks the protocol", () => {
  test("is a launching-phase failure, not a successful run", async () => {
    // Exiting zero without a handshake is a failure to start, whatever the
    // status code says. Treating it as success would let interpretation run
    // against a bundle no process ever wrote.
    await withHarness("/bin/true", async (h) => {
      const result = await h.service.start(REQUEST, noop).result

      expect(result.outcome).toBe("infrastructureFailed")
      expect(infrastructureReason(result)).toBe("runnerFailure")
      expect(summaryOf(result).execution.execObserved).toBe("no")
    })
  }, 30_000)

  test("still gives the slot back", async () => {
    await withHarness("/bin/true", async (h) => {
      await h.service.start(REQUEST, noop).result
      expect(readQueue(h.environment.storage).activeRunId).toBeUndefined()
    })
  }, 30_000)
})

describe("cancellation before admission", () => {
  test("is a queued cancellation, with no run and no run id", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      const result = await h.service.start(REQUEST, noop, {
        aborted: true,
        whenAborted: Promise.resolve(),
      }).result

      expect(isTestRunSummary(result)).toBe(false)
      expect(result).toMatchObject({ outcome: "cancelled", phase: "queued" })
    })
  }, 30_000)

  test("launches no work at all", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      await h.service.start(REQUEST, noop, {
        aborted: true,
        whenAborted: Promise.resolve(),
      }).result

      const state = readQueue(h.environment.storage)
      expect(state.activeRunId).toBeUndefined()
      expect(state.tickets).toEqual([])
      // No run directory was ever allocated, so nothing was ever supervised.
      expect(readdirSync(h.environment.storage.runsDir)).toEqual([])
    })
  }, 30_000)
})

describe("across a sequence of runs", () => {
  test("leaks neither the execution slot nor an unfinished run", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      for (let index = 0; index < 3; index += 1) {
        const cancelled = index === 1
        await h.service.start(
          REQUEST,
          noop,
          cancelled ? { aborted: true, whenAborted: Promise.resolve() } : undefined,
        ).result
      }

      const state = readQueue(h.environment.storage)
      expect(state.activeRunId).toBeUndefined()
      expect(state.tickets).toEqual([])
      expect(state.quarantine).toBeUndefined()

      // Every run reached a terminal state; none is left looking in progress.
      for (const runId of readdirSync(h.environment.storage.runsDir)) {
        expect(readRunRecord(h.environment.storage, runId)?.state).toBe("completed")
      }
    })
  }, 60_000)
})

describe("a supervisor that handshakes and then dies", () => {
  test("is a terminating-phase failure, and the run is still readable", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      h.scriptStub("crash")
      const result = await h.service.start(REQUEST, noop).result

      expect(result.outcome).toBe("infrastructureFailed")
      expect(infrastructureReason(result)).toBe("runnerFailure")
      // It got far enough to run something, so execution is unobserved rather
      // than provably absent.
      expect(summaryOf(result).execution.execObserved).not.toBe("no")
      expect(readQueue(h.environment.storage).activeRunId).toBeUndefined()
    })
  }, 30_000)
})

describe("a supervisor that never answers", () => {
  test("fails on its startup deadline rather than hanging", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      h.scriptStub("silent")
      const started = Date.now()
      const result = await h.service.start(REQUEST, noop).result

      expect(result.outcome).toBe("infrastructureFailed")
      expect(infrastructureReason(result)).toBe("runnerFailure")
      // The Test Run timeout is 900s; this bound can only come from the
      // supervisor's own startup deadline.
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(readQueue(h.environment.storage).activeRunId).toBeUndefined()
    })
  }, 30_000)
})

describe("a finished run", () => {
  test("leaves no supervisor process behind", async () => {
    await withHarness(STUB_SUPERVISOR, async (h) => {
      await h.service.start(REQUEST, noop).result

      const record = readRunRecord(
        h.environment.storage,
        readdirSync(h.environment.storage.runsDir)[0] as string,
      )
      const supervisor = record?.supervisor
      if (supervisor === undefined) return

      // The identity, not the number: a reused PID is not our supervisor.
      const current = systemProbe.identify(supervisor.pid)
      expect(current === undefined || current.startedAt !== supervisor.startedAt).toBe(true)
    })
  }, 30_000)
})
