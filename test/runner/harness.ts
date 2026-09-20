/**
 * Shared scaffolding for the runner test layers (ADR 0001, Layers 2 and 3).
 *
 * Every helper here works against a real temp directory rather than a mocked
 * filesystem: the properties under test — advisory locks, atomic renames,
 * ownership modes, apparent file size — are properties of the filesystem, and a
 * mock would only prove that the mock agrees with itself.
 */

import { spawn, type ChildProcess } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ProcessIdentity, ProcessProbe } from "../../src/runner/identity.ts"
import type { Cancellation } from "../../src/runner/supervisor.ts"
import { prepareStorage, storageFor, type Storage } from "../../src/runner/paths.ts"
import type { RunRecord } from "../../src/runner/state.ts"
import { writeRunRecord } from "../../src/runner/state.ts"

export const TRUSTED_ROOT = "/workspace/example"

export type Sandbox = {
  homeDir: string
  storage: Storage
  dispose(): void
}

/** A private storage tree under a temp home, prepared and owner-only. */
export function sandbox(containmentRoot = TRUSTED_ROOT): Sandbox {
  const homeDir = mkdtempSync(join(tmpdir(), "xcode-test-runner-"))
  const storage = storageFor(homeDir, containmentRoot)
  prepareStorage(storage)
  return {
    homeDir,
    storage,
    dispose() {
      rmSync(homeDir, { recursive: true, force: true })
    },
  }
}

/** Run `work` against a fresh sandbox, cleaning up even if it throws. */
export async function withSandbox<T>(
  work: (box: Sandbox) => T | Promise<T>,
  containmentRoot = TRUSTED_ROOT,
): Promise<T> {
  const box = sandbox(containmentRoot)
  try {
    return await work(box)
  } finally {
    box.dispose()
  }
}

export function seedRun(storage: Storage, record: Partial<RunRecord> & { runId: string }): RunRecord {
  const full: RunRecord = {
    schemaVersion: 1,
    rootKey: storage.rootKey,
    state: "admitted",
    admittedAt: "2026-09-13T10:00:00.000Z",
    timeoutSeconds: 900,
    ...record,
  }
  writeRunRecord(storage, full)
  return full
}

/**
 * A probe over a declared world. Recovery and quarantine need process states a
 * real machine cannot be asked to produce on demand — a PID that was reused, a
 * group whose number is live but whose members are not ours.
 */
export function fakeProbe(world: {
  processes?: Record<number, string>
  groups?: Record<number, number[]>
}): ProcessProbe & { signals: Array<{ pgid: number; signal: string }> } {
  const signals: Array<{ pgid: number; signal: string }> = []
  return {
    signals,
    identify(pid: number): ProcessIdentity | undefined {
      const startedAt = world.processes?.[pid]
      return startedAt === undefined ? undefined : { pid, startedAt }
    },
    membersOf(pgid: number): number[] {
      return world.groups?.[pgid] ?? []
    },
    signalGroup(pgid: number, signal: NodeJS.Signals): void {
      signals.push({ pgid, signal })
    },
  }
}

export const IMMEDIATE_ESCALATION = [
  { signal: "SIGINT" as const, waitMs: 150 },
  { signal: "SIGTERM" as const, waitMs: 150 },
  { signal: "SIGKILL" as const, waitMs: 300 },
]

/**
 * A promise that never settles.
 *
 * Only useful as a deliberate stand-in for evidence that does not arrive —
 * a child that never reports its exit, an observation that never resolves.
 * A test that uses one is asserting that something else bounds the wait.
 */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

/** A cancellation the test drives, in the shape supervision expects. */
export function cancellable(): { cancellation: Cancellation; cancel: () => void } {
  let aborted = false
  let announce: () => void = () => {}
  const whenAborted = new Promise<void>((resolve) => {
    announce = resolve
  })
  return {
    cancellation: {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A monotonic clock reading real elapsed milliseconds. */
export function monotonic(): () => number {
  const origin = process.hrtime.bigint()
  return () => Number((process.hrtime.bigint() - origin) / 1_000_000n)
}

export const STUB_PROCESS = join(import.meta.dir, "stub", "stub-process.ts")

/** The real supervisor, for the tests that drive it as a process. */
export const SUPERVISOR_ENTRYPOINT = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "runner",
  "supervisor-entry.ts",
)

export type ProcessEnd = { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }

/**
 * Run a script under this runtime with a private control channel, and report
 * how it ended.
 *
 * The channel is the supervisor's own shape — fd 3 to read, fd 4 to answer —
 * because the properties these tests are about are properties of descriptors.
 * `stderr` comes back with the status because the thing most worth knowing
 * about a process that chose its own exit code is whether it chose it: an
 * unheard `error` event leaves through the default handler, which is a
 * non-zero status *and* a throw on stderr.
 */
export function spawnWithControlChannel(
  entrypoint: string,
  options: { cwd: string },
): {
  child: ChildProcess
  /** fd 3 — what the supervisor reads. Writable from here. */
  toSupervisor: Writable | undefined
  /** fd 4 — what the supervisor answers on. Readable from here. */
  fromSupervisor: Readable | undefined
  ended: Promise<ProcessEnd>
} {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: options.cwd,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  })

  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })

  const ended = new Promise<ProcessEnd>((resolve) => {
    child.on("exit", (exitCode, signal) => resolve({ exitCode, signal, stderr }))
  })

  // Named here rather than indexed at each use. `child.stdio` is typed as the
  // five standard entries with union element types, because `spawn` in general
  // may be handed anything; this call was handed a fixed list two lines above,
  // so which of these is readable and which writable was decided there.
  const [, , , toSupervisor, fromSupervisor] = child.stdio as unknown as [
    unknown,
    unknown,
    unknown,
    Writable | undefined,
    Readable | undefined,
  ]

  return { child, toSupervisor, fromSupervisor, ended }
}
