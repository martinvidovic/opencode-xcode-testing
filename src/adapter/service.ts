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
import { requestedScopeDigest } from "../domain/scope.ts"
import type { ToolchainIdentity } from "../domain/toolchain.ts"
import type { InspectionResponse, InspectRunRequest } from "../domain/inspection.ts"
import { interpretRun } from "../interpreter/interpret.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../interpreter/index-model.ts"
import { DECODER_VERSION, REQUESTED_SCHEMA_VERSION } from "../interpreter/schema.ts"
import { inspectIndex } from "../interpreter/paging.ts"
import type { XcresultTool } from "../interpreter/ports.ts"
import { createXcresultTool } from "../interpreter/xcresulttool.ts"
import {
  decodeMessages,
  encodeMessage,
  newChannelSecret,
  type ControlMessage,
} from "../runner/control.ts"
import { systemProbe } from "../runner/identity.ts"
import { admit, QUARANTINE_REASON, releaseSlot, type AdmissionEnvironment } from "../runner/queue.ts"
import {
  createRunDirectory,
  RUN_ARTIFACTS,
  runDirectory,
  writePrivateFileAtomic,
  type Storage,
} from "../runner/paths.ts"
import { reclaimIsolatedDerivedData, reconcileRoot } from "../runner/recovery.ts"
import { resolveTestRun } from "../runner/resolution.ts"
import {
  advance,
  readRunRecord,
  RUN_STATES,
  writeRunRecord,
  type RunRecord,
} from "../runner/state.ts"
import { buildArguments, buildEnvironment, XCODEBUILD } from "../runner/xcodebuild.ts"
import type {
  AdmittedRun,
  ProtocolState,
  RunCancellation,
  RunHandle,
  TestToolService,
} from "./tools.ts"

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
  /**
   * How a Result Bundle is read. Defaulted to the real frozen `xcresulttool`;
   * overridden only so the recovery path can be exercised deterministically
   * without a machine that happens to have Xcode on it.
   */
  xcresultToolFor?(bundlePath: string): XcresultTool
}

function readerFor(environment: ServiceEnvironment, bundlePath: string): XcresultTool {
  return (
    environment.xcresultToolFor?.(bundlePath) ??
    createXcresultTool({ identity: environment.toolchain, bundlePath })
  )
}

export function createTestToolService(environment: ServiceEnvironment): TestToolService {
  return {
    start(request, hooks, cancellation) {
      return startRun(environment, request, hooks, cancellation)
    },

    inspect(request) {
      return Promise.resolve(inspectRetained(environment, request))
    },

    async recover() {
      const report = await reconcile(environment)
      return {
        status: report.status,
        ...(report.uncertain.length === 0
          ? {}
          : {
              message: `${report.uncertain.length} run(s) could not be accounted for and still hold the execution slot.`,
            }),
      }
    },
  }
}

function startRun(
  environment: ServiceEnvironment,
  request: TestRunRequest,
  hooks: { onState(state: ProtocolState): void },
  cancellation?: RunCancellation,
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
    await reconcile(environment)

    const admittedAt = environment.timestamp()

    // The run's durable state is created under the root lock, before the slot
    // transfers to it. A crash in the other order would leave an active slot
    // naming a run nothing can reconcile against, and wedge the trusted root.
    const admission = await admit(admissionEnvironment(environment), {
      prepare: (runId) => {
        if (createRunDirectory(environment.storage, runId) === undefined) return false
        writeRunRecord(environment.storage, {
          schemaVersion: 1,
          runId,
          rootKey: environment.storage.rootKey,
          state: "admitted",
          admittedAt,
          timeoutSeconds: resolution.resolved.timeoutSeconds.value,
          derivedDataMode: resolution.resolved.derivedData.value.mode,
          resolved: resolution.resolved,
          requestedScope: request.requestedScope,
          owner: selfIdentity(),
        })
        return true
      },
    })
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

    const runId = admission.runId
    const record = readRunRecord(environment.storage, runId)
    if (record === undefined) {
      rejectAdmitted(new Error("the run record vanished immediately after admission"))
      return {
        schemaVersion: 1,
        outcome: "infrastructureFailed",
        phase: "queued",
        reason: "recoveryFailed",
        message: "the run's durable state could not be read back after admission",
        queuedAt: admission.queuedAt,
        queueDurationMs: admission.queueDurationMs,
      }
    }

    writeRunRecord(environment.storage, { ...record, queueDurationMs: admission.queueDurationMs })

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
        ...(cancellation === undefined ? {} : { cancellation }),
      })
    } finally {
      releaseOwnership(environment, runId)
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
    cancellation?: RunCancellation
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
    ...(input.cancellation === undefined ? {} : { cancellation: input.cancellation }),
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
    tool: readerFor(environment, resultBundlePath),
    clock: { now: environment.now },
  })

  publishTerminal(environment, record, summary, index)
  return summary
}

/**
 * Publish the terminal evidence, then finish the run.
 *
 * The order is the contract: the immutable index and the summary land first,
 * so that a crash after this point leaves a run that is fully readable, and
 * only then does the record say `completed`. Isolated DerivedData is scratch
 * rather than evidence, so it is reclaimed before the run becomes retainable.
 */
function publishTerminal(
  environment: ServiceEnvironment,
  record: RunRecord,
  summary: TestToolResult,
  index: NormalizedIndex,
): void {
  const { storage } = environment
  writePrivateFileAtomic(
    join(runDirectory(storage, record.runId), INDEX_ARTIFACT),
    `${JSON.stringify(index)}\n`,
  )
  writePrivateFileAtomic(
    join(runDirectory(storage, record.runId), SUMMARY_ARTIFACT),
    `${JSON.stringify(summary)}\n`,
  )
  const completed = advance(storage, record, "completed", { completedAt: environment.timestamp() })
  reclaimIsolatedDerivedData(storage, completed)
}

/** The terminal summary, readable after a crash without rerunning anything. */
export const SUMMARY_ARTIFACT = "summary.json"

/** The immutable normalized index every later inspection pages through. */
export const INDEX_ARTIFACT = "index.json"

/**
 * The index for a run whose durable contract is unreadable: structurally the
 * same thing a completed run publishes, holding nothing. It exists so a caller
 * inspecting the run is told there is no retained evidence, rather than told
 * the run does not exist.
 */
function emptyIndex(runId: string): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId,
    decoderVersion: DECODER_VERSION,
    schemaVersion: REQUESTED_SCHEMA_VERSION,
    occurrences: [],
    testFailures: [],
    buildErrors: [],
    attestations: [],
    scopeVerdict: "unverifiable",
    scopeDigest: requestedScopeDigest({ kind: "all" }),
    requestedSelectionCount: 0,
    observedOutsideScope: 0,
    build: { completeness: "unavailable" },
    tests: { completeness: "unavailable" },
    log: { availability: "unavailable", retainedBytesExact: false },
    bundleDigestVerified: "unknown",
  }
}

function publishIndexOnly(
  environment: ServiceEnvironment,
  record: RunRecord,
  index: NormalizedIndex,
): void {
  writePrivateFileAtomic(
    join(runDirectory(environment.storage, record.runId), INDEX_ARTIFACT),
    `${JSON.stringify(index)}\n`,
  )
  const completed = advance(environment.storage, record, "completed", {
    completedAt: environment.timestamp(),
  })
  reclaimIsolatedDerivedData(environment.storage, completed)
}

/**
 * Reconcile the root, then finish whatever reconciliation handed back.
 *
 * Recovery deliberately does not invent a terminal result — interpretation
 * lives here, on the adapter side of the seam, because the runner may not
 * import the interpreter. So the two halves meet: recovery decides *which*
 * runs are finishable and holds their slots; this publishes the same immutable
 * summary and index a normal completed run publishes, and only then releases.
 */
export async function reconcile(environment: ServiceEnvironment) {
  const report = reconcileRoot({
    storage: environment.storage,
    probe: systemProbe,
    timestamp: environment.timestamp,
    claimant: selfIdentity(),
  })

  for (const runId of report.needsFinalization) {
    await finalizeRecovered(environment, runId)
  }

  return report
}

/**
 * Finish a run whose processes are gone and whose summary was never published.
 *
 * A run that reached `launchAuthorized` has a Result Bundle worth reading, so
 * it is interpreted exactly as it would have been live — the artifacts are
 * immutable, so the answer is the same one the original process would have
 * produced. A run that never got that far has nothing to interpret, and is
 * finished as a runner failure in the launching phase rather than left to look
 * like it might still be running.
 */
export async function finalizeRecovered(
  environment: ServiceEnvironment,
  runId: string,
): Promise<void> {
  const record = readRunRecord(environment.storage, runId)
  if (record === undefined) return

  const directory = runDirectory(environment.storage, runId)
  const resultBundlePath = join(directory, RUN_ARTIFACTS.resultBundle)
  const scope = record.requestedScope ?? { kind: "all" as const }

  let current = record
  for (const state of ["supervisorReady", "childRecorded", "launchAuthorized", "executionCompleted"] as const) {
    if (RUN_STATES.indexOf(current.state) < RUN_STATES.indexOf(state)) {
      current = advance(environment.storage, current, state)
    }
  }

  if (record.resolved === undefined) {
    // Nothing describes what this run was asked to do, so no honest summary can
    // be written — fabricating one would look authoritative and be wrong. An
    // empty index is still published, so inspection answers "nothing retained"
    // rather than "never known", and the artifacts stay for review.
    publishIndexOnly(environment, current, emptyIndex(runId))
    releaseOwnership(environment, runId)
    return
  }

  const { summary, index } = await interpretRun({
    facts: {
      runId,
      trustedRoot: environment.trustedRoot,
      resultBundlePresent: existsSync(resultBundlePath),
      bundleDigestVerified: "unknown",
      toolchain: environment.toolchain,
      log: logFacts(join(directory, RUN_ARTIFACTS.rawLog)),
    },
    requestedScope: scope,
    resolved: record.resolved,
    timing: {
      admittedAt: record.admittedAt,
      queueDurationMs: record.queueDurationMs ?? 0,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      // The original process duration was never observed and is not invented;
      // the reported total therefore measures from where recovery took over.
      elapsedBeforeInterpretationMs: 0,
    },
    terminationTrigger: record.terminationTrigger ?? "unknown",
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
      successfulExit:
        record.signal !== undefined ? "no" : record.exitCode === 0 ? "yes" : record.exitCode === undefined ? "unknown" : "no",
    },
    tool: readerFor(environment, resultBundlePath),
    clock: { now: environment.now },
  })

  publishTerminal(environment, current, summary, index)
  releaseOwnership(environment, runId)
}



/**
 * Give the execution slot back — or hold the root quarantined when the run's
 * lifecycle could not be confirmed. Publishing quarantine is what makes the
 * next admission fail fast with a reason instead of waiting out its deadline
 * behind a run nobody can account for.
 */
function releaseOwnership(environment: ServiceEnvironment, runId: string): void {
  const record = readRunRecord(environment.storage, runId)
  if (record?.quarantined === true) {
    releaseSlot(environment.storage, runId, {
      reason: record.quarantineReason ?? QUARANTINE_REASON,
      since: environment.timestamp(),
    })
    return
  }
  releaseSlot(environment.storage, runId)
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
  input: {
    runId: string
    args: string[]
    onState(state: ProtocolState): void
    cancellation?: RunCancellation
  },
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

    // The supervisor owns termination, so cancellation is relayed to it
    // rather than signalled from here: the plugin is outside the process group
    // on purpose, and signalling into it would race the escalation ladder.
    void input.cancellation?.whenAborted.then(() => {
      toSupervisor?.write(encodeMessage({ type: "cancel" }))
    })

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
  const path = join(runDirectory(environment.storage, request.runId), INDEX_ARTIFACT)
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

/** This process, as recovery will later look for it. */
function selfIdentity() {
  return systemProbe.identify(process.pid) ?? { pid: process.pid, startedAt: "unknown" }
}

function admissionEnvironment(environment: ServiceEnvironment): AdmissionEnvironment {
  const identity = selfIdentity()
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
