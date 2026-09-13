/**
 * The concrete Test Tool service: admission, supervision, interpretation.
 *
 * This is the seam where the runner and the interpreter meet. The adapter owns
 * the composition rather than either module, which is what keeps `runner` and
 * `interpreter` from importing each other — they are independent by contract,
 * and the only place that knows about both is here.
 *
 * The supervisor is spawned as a **separate process** through the resolved
 * runtime, because it has to outlive this call: OpenCode may disappear while
 * `xcodebuild` is still running, and a supervisor living inside the adapter's
 * module graph would die with it.
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { ProjectConfiguration, TestRunRequest } from "../domain/request.ts"
import type { TestToolResult } from "../domain/result.ts"
import type { ToolchainIdentity } from "../domain/toolchain.ts"
import type { InspectionResponse, InspectRunRequest } from "../domain/inspection.ts"
import { interpretRun } from "../interpreter/interpret.ts"
import { inspectIndex } from "../interpreter/paging.ts"
import { createXcresultTool } from "../interpreter/xcresulttool.ts"
import {
  decodeMessages,
  encodeMessage,
  newChannelSecret,
  type ControlMessage,
} from "../runner/control.ts"
import { systemProbe } from "../runner/identity.ts"
import { admit, releaseSlot, type AdmissionEnvironment } from "../runner/queue.ts"
import {
  createRunDirectory,
  newRunId,
  RUN_ARTIFACTS,
  runDirectory,
  writePrivateFileAtomic,
  type Storage,
} from "../runner/paths.ts"
import { reconcileRoot } from "../runner/recovery.ts"
import { resolveTestRun } from "../runner/resolution.ts"
import { advance, readRunRecord, writeRunRecord, type RunRecord } from "../runner/state.ts"
import { buildArguments, buildEnvironment, XCODEBUILD } from "../runner/xcodebuild.ts"
import type { AdmittedRun, ProtocolState, RunHandle, TestToolService } from "./tools.ts"

export type ServiceEnvironment = {
  storage: Storage
  trustedRoot: string
  homeDir: string
  configuration?: ProjectConfiguration
  toolchain: ToolchainIdentity
  /** The verified Bun that can execute the supervisor entrypoint. */
  runtimePath: string
  supervisorEntrypoint: string
  now(): number
  timestamp(): string
  sleep(ms: number): Promise<void>
  freeBytes(): number
  /** Durable root-local secret for opaque inspection cursors. */
  cursorSecret: Buffer
}

export function createTestToolService(environment: ServiceEnvironment): TestToolService {
  return {
    start(request, hooks) {
      return startRun(environment, request, hooks)
    },

    inspect(request) {
      return Promise.resolve(inspectRetained(environment, request))
    },

    recover() {
      const report = reconcileRoot({
        storage: environment.storage,
        probe: systemProbe,
        timestamp: environment.timestamp,
      })
      return Promise.resolve({
        status: report.status,
        ...(report.uncertain.length === 0
          ? {}
          : {
              message: `${report.uncertain.length} run(s) could not be accounted for and still hold the execution slot.`,
            }),
      })
    },
  }
}

function startRun(
  environment: ServiceEnvironment,
  request: TestRunRequest,
  hooks: { onState(state: ProtocolState): void },
): RunHandle {
  let resolveAdmitted: (run: AdmittedRun) => void = () => {}
  let rejectAdmitted: (error: Error) => void = () => {}
  const admitted = new Promise<AdmittedRun>((resolve, reject) => {
    resolveAdmitted = resolve
    rejectAdmitted = reject
  })
  // Nobody may be listening if the request never reaches admission.
  admitted.catch(() => {})

  const result = (async (): Promise<TestToolResult> => {
    const resolution = resolveTestRun(request, {
      trustedRoot: environment.trustedRoot,
      ...(environment.configuration === undefined
        ? {}
        : { configuration: environment.configuration }),
    })
    if (resolution.status === "rejected") {
      rejectAdmitted(new Error("the request was rejected before admission"))
      return resolution.result
    }

    // Reconciliation runs before enrollment, never after.
    reconcileRoot({
      storage: environment.storage,
      probe: systemProbe,
      timestamp: environment.timestamp,
    })

    const admission = await admit(admissionEnvironment(environment))
    if (admission.status !== "admitted") {
      rejectAdmitted(new Error("the request did not reach admission"))
      return admission.status === "cancelled"
        ? {
            schemaVersion: 1,
            outcome: "cancelled",
            phase: "queued",
            queuedAt: admission.queuedAt,
            queueDurationMs: admission.queueDurationMs,
          }
        : {
            schemaVersion: 1,
            outcome: "infrastructureFailed",
            phase: "queued",
            reason: admission.reason,
            message: queuedFailureMessage(admission.reason),
            queuedAt: admission.queuedAt,
            queueDurationMs: admission.queueDurationMs,
          }
    }

    const runId = ensureRunDirectory(environment.storage, admission.runId)
    const record: RunRecord = {
      schemaVersion: 1,
      runId,
      rootKey: environment.storage.rootKey,
      state: "admitted",
      admittedAt: admission.admittedAt,
      timeoutSeconds: resolution.resolved.timeoutSeconds.value,
      derivedDataMode: resolution.resolved.derivedData.value.mode,
    }
    writeRunRecord(environment.storage, record)

    resolveAdmitted({
      runId,
      resolved: resolution.resolved,
      admittedAt: admission.admittedAt,
      queueDurationMs: admission.queueDurationMs,
    })
    hooks.onState("admitted")

    const startedAt = environment.now()
    try {
      return await superviseAndInterpret(environment, {
        record,
        request,
        resolution,
        admission,
        hooks,
        startedAt,
      })
    } finally {
      // The slot is released only once the run is durably finished; a
      // quarantined run keeps it, which is the supervisor's decision to make.
      const final = readRunRecord(environment.storage, runId)
      if (final?.quarantined !== true) releaseSlot(environment.storage, runId)
    }
  })()

  return { admitted, result }
}

async function superviseAndInterpret(
  environment: ServiceEnvironment,
  input: {
    record: RunRecord
    request: TestRunRequest
    resolution: Extract<ReturnType<typeof resolveTestRun>, { status: "resolved" }>
    admission: { admittedAt: string; queueDurationMs: number }
    hooks: { onState(state: ProtocolState): void }
    startedAt: number
  },
): Promise<TestToolResult> {
  const { storage } = environment
  const directory = runDirectory(storage, input.record.runId)
  const resultBundlePath = join(directory, RUN_ARTIFACTS.resultBundle)
  const derivedDataPath =
    input.resolution.resolved.derivedData.value.mode === "isolated"
      ? join(directory, RUN_ARTIFACTS.derivedData)
      : join(storage.rootDir, RUN_ARTIFACTS.derivedData)

  const args = buildArguments(input.resolution.resolved, input.request.requestedScope, {
    containerAbsolutePath: input.resolution.containerAbsolutePath,
    resultBundlePath,
    derivedDataPath,
  })

  const supervision = await runSupervisor(environment, {
    runId: input.record.runId,
    args,
    onState: input.hooks.onState,
  })

  if (!supervision.ok) {
    return runnerFailure(environment, input, supervision.message)
  }

  input.hooks.onState("interpreting")

  const record = readRunRecord(storage, input.record.runId) ?? input.record
  const processDurationMs = environment.now() - input.startedAt

  const { summary, index } = await interpretRun({
    facts: {
      runId: record.runId,
      trustedRoot: environment.trustedRoot,
      resultBundlePresent: existsSync(resultBundlePath),
      bundleDigestVerified: "yes",
      toolchain: environment.toolchain,
      log: logFacts(join(directory, RUN_ARTIFACTS.rawLog)),
    },
    requestedScope: input.request.requestedScope,
    resolved: input.resolution.resolved,
    timing: {
      admittedAt: input.admission.admittedAt,
      queueDurationMs: input.admission.queueDurationMs,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      processDurationMs,
      elapsedBeforeInterpretationMs: processDurationMs,
    },
    terminationTrigger: record.terminationTrigger ?? "none",
    termination: {
      requested: record.terminationTrigger === undefined ? "no" : "yes",
      gracefulTerminationObserved: "unknown",
      forceEscalationRequired: "unknown",
      terminationGraceExceeded: "unknown",
      descendantsConfirmedExited: record.descendantsConfirmedExited ?? "unknown",
    },
    execution: {
      execObserved: record.execObserved ?? "unknown",
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      successfulExit: record.signal !== undefined ? "no" : record.exitCode === 0 ? "yes" : "no",
    },
    tool: createXcresultTool({ identity: environment.toolchain, bundlePath: resultBundlePath }),
    clock: { now: environment.now },
  })

  publishIndex(storage, record, index)
  advance(storage, record, "completed", { completedAt: environment.timestamp() })
  return summary
}

/**
 * The index is what every later inspection reads. Publishing it is what makes
 * "a completed run is never reinterpreted" true rather than aspirational.
 */
function publishIndex(storage: Storage, record: RunRecord, index: unknown): void {
  writePrivateFileAtomic(
    join(runDirectory(storage, record.runId), "index.json"),
    `${JSON.stringify(index)}\n`,
  )
}

function logFacts(path: string): { retainedBytes?: number; retainedBytesExact: boolean } {
  try {
    return { retainedBytes: statSync(path).size, retainedBytesExact: true }
  } catch {
    return { retainedBytesExact: false }
  }
}

function runnerFailure(
  environment: ServiceEnvironment,
  input: { record: RunRecord; admission: { admittedAt: string; queueDurationMs: number } },
  message: string,
): TestToolResult {
  return {
    schemaVersion: 1,
    outcome: "infrastructureFailed",
    phase: "queued",
    reason: "recoveryFailed",
    message,
    queuedAt: input.admission.admittedAt,
    queueDurationMs: input.admission.queueDurationMs,
  }
}

// --- the supervisor process -----------------------------------------------

type SupervisionOutcome = { ok: true } | { ok: false; message: string }

function runSupervisor(
  environment: ServiceEnvironment,
  input: { runId: string; args: string[]; onState(state: ProtocolState): void },
): Promise<SupervisionOutcome> {
  return new Promise((resolve) => {
    const child = spawn(environment.runtimePath, [environment.supervisorEntrypoint], {
      cwd: environment.trustedRoot,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      // Detached so it outlives this call, with a private inherited control
      // channel: fd 3 is ours to write, fd 4 is the supervisor's to answer on.
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    })

    const toSupervisor = child.stdio[3]
    const fromSupervisor = child.stdio[4]

    const secret = newChannelSecret()
    toSupervisor?.write(
      encodeMessage({
        type: "hello",
        secret,
        homeDir: environment.homeDir,
        trustedRoot: environment.trustedRoot,
        runId: input.runId,
        command: XCODEBUILD,
        args: input.args,
        environment: buildEnvironment(
          { PATH: process.env["PATH"] },
          environment.toolchain.developerDirectory,
        ),
        developerDirectory: environment.toolchain.developerDirectory,
      } as ControlMessage & Record<string, unknown>),
    )

    let buffer = ""
    fromSupervisor?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const message of messages) {
        if (message.type === "ready") input.onState("supervisorReady")
        if (message.type === "state") input.onState(message.state as ProtocolState)
        if (message.type === "completed") input.onState("executionCompleted")
      }
    })

    child.on("error", () => {
      resolve({ ok: false, message: "the supervisor process could not be started" })
    })
    child.on("exit", (code) => {
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, message: `the supervisor exited with status ${code ?? "unknown"}` },
      )
    })
  })
}

// --- inspection -----------------------------------------------------------

function inspectRetained(
  environment: ServiceEnvironment,
  request: InspectRunRequest,
): InspectionResponse<unknown> {
  const path = join(runDirectory(environment.storage, request.runId), "index.json")
  let index: unknown
  try {
    index = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    // A tombstone distinguishes "deleted" from "never known"; without one, the
    // run is genuinely unknown within this trusted root's namespace.
    return tombstoneExists(environment.storage, request.runId)
      ? { status: "expired" }
      : { status: "notFound", subject: "run" }
  }

  return inspectIndex(
    index as Parameters<typeof inspectIndex>[0],
    request,
    environment.cursorSecret,
  ) as InspectionResponse<unknown>
}

function tombstoneExists(storage: Storage, runId: string): boolean {
  try {
    return readdirSync(storage.tombstonesDir).includes(`${runId}.json`)
  } catch {
    return false
  }
}

// --- shared ---------------------------------------------------------------

function admissionEnvironment(environment: ServiceEnvironment): AdmissionEnvironment {
  const identity = systemProbe.identify(process.pid) ?? {
    pid: process.pid,
    startedAt: "unknown",
  }
  return {
    storage: environment.storage,
    probe: systemProbe,
    now: environment.now,
    timestamp: environment.timestamp,
    freeBytes: environment.freeBytes,
    owner: identity,
    sleep: environment.sleep,
  }
}

function ensureRunDirectory(storage: Storage, preferred: string): string {
  let runId = preferred
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (createRunDirectory(storage, runId) !== undefined) return runId
    runId = newRunId()
  }
  throw new Error("a private run directory could not be created")
}

function queuedFailureMessage(reason: string): string {
  switch (reason) {
    case "executionSlotQuarantined":
      return "the execution slot is quarantined until recovery clears it. Run xcode_test_recover."
    case "concurrencyWaitTimedOut":
      return "another Test Run held this project's execution slot for the whole wait."
    case "insufficientStorage":
      return "there is not enough free space on the artifact volume to start a Test Run."
    default:
      return "the Test Run could not be admitted."
  }
}

/** A deterministic content digest, computed once at stabilization (#8). */
export function bundleDigest(path: string): string {
  const hash = createHash("sha256")
  const walk = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(current, entry)
      hash.update(entry)
      if (statSync(child).isDirectory()) walk(child)
      else hash.update(readFileSync(child))
    }
  }
  walk(path)
  return hash.digest("hex")
}
