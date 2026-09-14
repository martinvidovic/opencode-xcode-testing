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
import { closeSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, readSync } from "node:fs"
import { join } from "node:path"

import type { ResolvedTestRun, TestRunRequest } from "../domain/request.ts"
import type { ResultProvenance, TestRunSummary, TestToolResult } from "../domain/result.ts"
import { NO_DIAGNOSTICS, SCHEMA_VERSION, unobservedEnvelope } from "../domain/result.ts"
import { normalizeRequestedScope, requestedScopeDigest } from "../domain/scope.ts"
import type { ToolchainIdentity } from "../domain/toolchain.ts"
import type { InspectionResponse, InspectRunRequest } from "../domain/inspection.ts"
import { interpretRun } from "../interpreter/interpret.ts"
import { INDEX_VERSION, isNormalizedIndex, type NormalizedIndex } from "../interpreter/index-model.ts"
import { DECODER_VERSION, REQUESTED_SCHEMA_VERSION } from "../interpreter/schema.ts"
import { decodeTestDetails } from "../interpreter/decode.ts"
import type { LazyOutcome } from "../interpreter/focus.ts"
import { toolchainIdentityMatches } from "../interpreter/ports.ts"
import type { LogWindow } from "../interpreter/log.ts"
import {
  inspectIndex,
  inspectLog,
  logAvailability,
  resolveLogWindow,
  type FacetPage,
} from "../interpreter/paging.ts"
import type { XcresultTool } from "../interpreter/ports.ts"
import { SUPERVISOR_STARTUP_DEADLINE_MS } from "../runner/supervisor.ts"
import { createXcresultTool } from "../interpreter/xcresulttool.ts"
import {
  decodeMessages,
  encodeMessage,
  newChannelSecret,
  type ControlMessage,
} from "../runner/control.ts"
import { systemProbe, type ProcessIdentity } from "../runner/identity.ts"
import { admit, QUARANTINE_REASON, releaseSlot, type AdmissionEnvironment } from "../runner/queue.ts"
import {
  createPrivateDirectory,
  createRunDirectory,
  isRunId,
  openPrivateFile,
  readPrivateFile,
  RUN_ARTIFACTS,
  runDirectory,
  sharedDerivedDataFor,
  UnsafeArtifactError,
  writePrivateFileAtomic,
  type Storage,
} from "../runner/paths.ts"
import { reclaimIsolatedDerivedData, reconcileRoot } from "../runner/recovery.ts"
import { resolveTestRun, type ConfigurationOutcome } from "../runner/resolution.ts"
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
  configuration?: ConfigurationOutcome
  toolchain: ToolchainIdentity
  /** The verified Bun that can execute the supervisor entrypoint. */
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
  /**
   * How long the supervisor has to answer the handshake. Defaults to #3's
   * supervisor startup deadline; it is separate from the Test Run timeout,
   * which does not begin until launch is authorized.
   */
  handshakeDeadlineMs?: number
  /** How long a signalled supervisor has to exit. A test seam, like the above. */
  exitDeadlineMs?: number
  /** How this run was made possible. */
  runtime: RuntimeFacts
}

/**
 * The runtime that executed the supervisor and the host that asked for it.
 *
 * The path is machine-local and stays in durable metadata; the versions are
 * safe to surface, because a model can act on *which* Bun ran the supervisor
 * and can do nothing at all with where it lives.
 */
export type RuntimeFacts = {
  path: string
  version?: string
  hostVersion?: string
}

function readerFor(environment: ServiceEnvironment, bundlePath: string): XcresultTool {
  return (
    environment.xcresultToolFor?.(bundlePath) ??
    createXcresultTool({ identity: environment.toolchain, bundlePath })
  )
}

/**
 * A Test Tool family that cannot run anything, and says so.
 *
 * Registering nothing would be worse: the tools simply would not appear, and
 * "no Xcode tools in this session" is indistinguishable from a project that
 * never opted in. A family that registers and returns the diagnostic naming
 * what is missing is the difference between a puzzle and an instruction.
 */
export function unavailableService(message: string): TestToolService {
  const refuse = (): TestToolResult => ({
    schemaVersion: SCHEMA_VERSION,
    outcome: "infrastructureFailed",
    phase: "resolving",
    reason: "runnerFailure",
    message,
  })

  return {
    start() {
      // Admission never happens, and never throwing for a domain outcome means
      // it does not reject either — the result carries the whole answer.
      return { admitted: new Promise<never>(() => {}), result: Promise.resolve(refuse()) }
    },
    inspect: () => Promise.resolve({ status: "invalid", message }),
    recover: () => Promise.resolve({ status: "failed", message }),
  }
}

export function createTestToolService(environment: ServiceEnvironment): TestToolService {
  return {
    start(request, hooks, cancellation) {
      return startRun(environment, request, hooks, cancellation)
    },

    inspect(request) {
      return inspectRetained(environment, request)
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
      ...(cancellation === undefined ? {} : { signal: cancellation }),
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
          runtimePath: environment.runtime.path,
          ...(environment.runtime.version === undefined
            ? {}
            : { runtimeVersion: environment.runtime.version }),
          ...(environment.runtime.hostVersion === undefined
            ? {}
            : { hostVersion: environment.runtime.hostVersion }),
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
      : sharedDerivedDataFor(storage, input.resolution.containerAbsolutePath)

  // Created here rather than left to xcodebuild, which would make it with the
  // ambient umask. Tool-managed storage is owner-only wherever it is reached
  // from, not only where it happens to be nested under something that is.
  createPrivateDirectory(derivedDataPath)

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
    // Read back rather than reused: the supervisor writes to this record too,
    // and publishing from the stale copy this call started with would undo
    // whatever it recorded on the way down.
    const latest = readRunRecord(storage, input.record.runId) ?? input.record
    const failed =
      supervision.quarantine === undefined
        ? latest
        : {
            ...latest,
            quarantined: true,
            quarantineReason: supervision.quarantine,
            ...(supervision.supervisor === undefined ? {} : { supervisor: supervision.supervisor }),
          }

    // Durable before the summary is published, because `releaseOwnership`
    // reads it back from disk: a crash between the two must leave the root
    // held rather than silently released.
    if (supervision.quarantine !== undefined) writeRunRecord(storage, failed)

    const summary = withRuntimeProvenance(
      environment,
      runnerFailureSummary(environment, input, supervision.message, supervision.phase),
    )
    publishTerminal(environment, failed, summary, emptyIndex(environment, input.record.runId))
    return summary
  }

  input.hooks.onState("interpreting")

  const stabilized = stabilize(
    storage,
    readRunRecord(storage, input.record.runId) ?? input.record,
    resultBundlePath,
  )
  const record = stabilized.record
  const processDurationMs = environment.now() - input.startedAt

  const { summary, index } = await interpretRun({
    facts: {
      runId: record.runId,
      trustedRoot: environment.trustedRoot,
      resultBundlePresent: existsSync(resultBundlePath),
      bundleDigestVerified: stabilized.verified,
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
    ...(input.cancellation === undefined ? {} : { signal: input.cancellation }),
  })

  const provenanced = withRuntimeProvenance(environment, summary)
  publishTerminal(environment, record, provenanced, index)
  return provenanced
}

/**
 * Add the runtime and host versions to a summary's provenance.
 *
 * The interpreter cannot know them — it is host-agnostic by contract, and
 * these are facts about the process that ran the tests rather than about the
 * Result Bundle. Paths are deliberately absent: only versions are safe to put
 * in front of a model.
 */
function withRuntimeProvenance<T extends { provenance?: ResultProvenance }>(
  environment: ServiceEnvironment,
  summary: T,
): T {
  return {
    ...summary,
    provenance: {
      // A run that never reached a Result Bundle still knows which toolchain
      // and runtime it was asked from, and saying so is how the report
      // explains itself. An interpreted summary overwrites all of it.
      xcodeVersion: environment.toolchain.xcodeVersion,
      xcodeBuild: environment.toolchain.xcodeBuild,
      xcresulttoolVersion: environment.toolchain.xcresulttoolVersion,
      requestedSchemaVersion: REQUESTED_SCHEMA_VERSION,
      interpreterDecoderVersion: DECODER_VERSION,
      ...summary.provenance,
      ...(environment.runtime.version === undefined
        ? {}
        : { runtimeVersion: environment.runtime.version }),
      ...(environment.runtime.hostVersion === undefined
        ? {}
        : { hostVersion: environment.runtime.hostVersion }),
    },
  }
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
  const completed = advance(storage, record, "completed", {
    completedAt: environment.timestamp(),
    bundleDigestVerified: index.bundleDigestVerified,
  })
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
function emptyIndex(environment: ServiceEnvironment, runId: string): NormalizedIndex {
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
    diagnostics: { completeness: "unavailable" },
    fullMessages: {},
    toolchain: environment.toolchain,
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
  const found = readRunRecord(environment.storage, runId)
  if (found === undefined) return

  const directory = runDirectory(environment.storage, runId)
  const resultBundlePath = join(directory, RUN_ARTIFACTS.resultBundle)

  // Nothing was ever authorized to run, so there is nothing to interpret and
  // no bundle to read. This is the whole of what recovery knows, and saying
  // less than it would be as wrong as saying more.
  if (!reachedLaunch(found)) return finalizePreLaunch(environment, found)

  // A run that crashed before stabilization never recorded a digest. Recording
  // one now is what lets any later read say whether the bytes changed.
  const stabilized = stabilize(environment.storage, found, resultBundlePath)
  const record = stabilized.record
  const scope = record.requestedScope ?? { kind: "all" as const }

  // Only the states between where it got to and the end it actually reached.
  // A run that executed and crashed before publishing did pass through these;
  // one that never launched did not, and is handled above.
  let current = record
  for (const state of ["executionCompleted"] as const) {
    if (RUN_STATES.indexOf(current.state) < RUN_STATES.indexOf(state)) {
      current = advance(environment.storage, current, state)
    }
  }

  if (record.resolved === undefined) {
    // Nothing describes what this run was asked to do, so no honest summary can
    // be written — fabricating one would look authoritative and be wrong. An
    // empty index is still published, so inspection answers "nothing retained"
    // rather than "never known", and the artifacts stay for review.
    publishIndexOnly(environment, current, emptyIndex(environment, runId))
    releaseOwnership(environment, runId)
    return
  }

  const { summary, index } = await interpretRun({
    facts: {
      runId,
      trustedRoot: environment.trustedRoot,
      resultBundlePresent: existsSync(resultBundlePath),
      // Verified against the digest recorded at stabilization, whether that
      // happened on the eager path or a moment ago. A mismatch degrades
      // bundle-backed detail without invalidating what was already read.
      bundleDigestVerified: stabilized.verified,
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
 * Whether this run ever got as far as being allowed to start Xcode.
 *
 * `launchAuthorized` is the durable point at which the gated child was told to
 * `exec`. Before it, no Result Bundle can exist, because nothing was running
 * to write one.
 */
function reachedLaunch(record: RunRecord): boolean {
  return RUN_STATES.indexOf(record.state) >= RUN_STATES.indexOf("launchAuthorized")
}

/**
 * Finish a run that never launched, without inventing what it would have done.
 *
 * The temptation is to march the record forward through the states a complete
 * run passes through and then interpret whatever is on disk. That produces a
 * summary indistinguishable from a real one — same shape, same fields, a
 * plausible zero count — describing a test run that never happened. So the
 * states it did not reach are not written, the bundle that does not exist is
 * not read, and the summary says exactly what took place: the runner failed
 * while launching, and nothing executed.
 */
async function finalizePreLaunch(
  environment: ServiceEnvironment,
  record: RunRecord,
): Promise<void> {
  const index = emptyIndex(environment, record.runId)

  if (record.resolved === undefined) {
    // Nothing describes what this run was asked to do, so no honest summary
    // can be written — fabricating one would look authoritative and be wrong.
    publishIndexOnly(environment, record, index)
    releaseOwnership(environment, record.runId)
    return
  }

  const summary = withRuntimeProvenance(
    environment,
    runnerFailureSummary(
      environment,
      {
        record,
        request: { requestedScope: record.requestedScope ?? { kind: "all" } },
        resolution: { resolved: record.resolved },
        admission: {
          admittedAt: record.admittedAt,
          queueDurationMs: record.queueDurationMs ?? 0,
        },
        // The original elapsed time was never observed, and recovery does not
        // invent one: the reported total measures from where it took over.
        startedAt: environment.now(),
      },
      "the Test Run was interrupted before it was authorized to start, and no test process ran",
      "launching",
    ),
  )

  publishTerminal(environment, record, summary, index)
  releaseOwnership(environment, record.runId)
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
    // A regular file or nothing: the size of whatever a link points at is not
    // a fact about this run's retained log.
    const stats = lstatSync(path)
    if (!stats.isFile()) return { retainedBytesExact: false }
    return { retainedBytes: stats.size, retainedBytesExact: true }
  } catch {
    return { retainedBytesExact: false }
  }
}

/**
 * The terminal summary for a run whose supervision failed after admission.
 *
 * This is a **run-scoped** result, not a queued one. The run holds a `runId`
 * and retained artifacts; reporting it as a pre-execution failure would tell
 * the caller no Test Run ever existed and hide evidence they could inspect.
 *
 * The trigger comes from the record when the supervisor already fixed and
 * persisted one. A supervisor that was cancelled and then exited non-zero was
 * still cancelled, and overwriting that here would make the outcome depend on
 * which layer reported it last.
 */
function runnerFailureSummary(
  environment: ServiceEnvironment,
  input: {
    record: RunRecord
    request: TestRunRequest
    resolution: { resolved: ResolvedTestRun }
    admission: { admittedAt: string; queueDurationMs: number }
    startedAt: number
  },
  message: string,
  phase: "launching" | "terminating",
): TestRunSummary {
  const scope = input.request.requestedScope
  const normalized = normalizeRequestedScope(scope)
  const record = readRunRecord(environment.storage, input.record.runId) ?? input.record

  const envelope = unobservedEnvelope({
    runId: input.record.runId,
    resolved: input.resolution.resolved,
    scope: {
      kind: scope.kind,
      digest: requestedScopeDigest(scope),
      requestedSelectionCount: normalized.kind === "selected" ? normalized.tests.length : 0,
      verdict: "notReached",
      attestations: [],
      shown: 0,
      truncated: false,
    },
    timing: {
      admittedAt: input.admission.admittedAt,
      queueDurationMs: input.admission.queueDurationMs,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      totalDurationMs: environment.now() - input.startedAt,
    },
    // A runner operational failure that initiates termination fixes the
    // outcome with trigger `toolFailure` (#7) — but only when nothing had
    // already fixed one.
    terminationTrigger:
      record.terminationTrigger !== undefined && record.terminationTrigger !== "none"
        ? record.terminationTrigger
        : "toolFailure",
    // Nothing launched means nothing executed; anything later is unobserved.
    execObserved: record.execObserved ?? (phase === "launching" ? "no" : "unknown"),
  })

  return {
    ...envelope,
    termination: {
      ...envelope.termination,
      requested: record.terminationTrigger !== undefined && record.terminationTrigger !== "none" ? "yes" : "no",
    },
    outcome: "infrastructureFailed",
    reason: "runnerFailure",
    message,
    diagnostics: NO_DIAGNOSTICS,
  }
}

// --- the supervisor process -----------------------------------------------

/**
 * Why supervision ended, and where. The phase matters: a supervisor that never
 * completed its handshake failed in `launching`, and the child it would have
 * created provably never ran.
 */
type SupervisionOutcome =
  | { ok: true }
  | {
      ok: false
      message: string
      phase: "launching" | "terminating"
      /**
       * Set when the run's lifecycle could not be confirmed, and why. The root
       * is held until recovery can establish that nothing attributable to it
       * is still running.
       */
      quarantine?: string
      /** The process the root is being held over, for recovery to validate. */
      supervisor?: ProcessIdentity
    }

const HANDSHAKE_TIMEOUT_MESSAGE =
  "the supervisor did not complete its handshake within its startup deadline"

/**
 * How long a signalled supervisor has to actually exit.
 *
 * Short on purpose: this is a process that has already failed to reach its own
 * handshake and has been sent `SIGKILL`, which the kernel does not let it
 * ignore. Waiting longer would only delay the moment the root is held.
 */
export const SUPERVISOR_EXIT_DEADLINE_MS = 5_000


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
    const child = spawn(environment.runtime.path, [environment.supervisorEntrypoint], {
      cwd: environment.trustedRoot,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      // Detached so it outlives this call, with a private inherited control
      // channel: fd 3 is ours to write, fd 4 is the supervisor's to answer on.
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    })

    const toSupervisor = child.stdio[3]
    const fromSupervisor = child.stdio[4]

    let settled = false
    let handshook = false
    let spawnFailed = false
    let channelLost = false
    let timedOut = false
    let exitTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: SupervisionOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(handshakeTimer)
      if (exitTimer !== undefined) clearTimeout(exitTimer)
      resolve(outcome)
    }

    // A write to a channel whose far end has gone is channel loss, not a
    // failure to start. Conflating the two misreports where the run died.
    toSupervisor?.on("error", () => {
      channelLost = true
    })
    fromSupervisor?.on("error", () => {
      channelLost = true
    })

    const handshakeTimer = setTimeout(() => {
      // It never handshook, so it never authorized a launch and owns no child.
      // But "we signalled it" is not "it is gone": returning here would hand
      // the execution slot back while a process nobody is tracking carries on,
      // which is the exact condition quarantine exists to prevent. So the
      // signal is attempted, the exit is waited for, and anything short of a
      // confirmed exit holds the root instead of releasing it.
      timedOut = true
      let signalled = true
      try {
        child.kill("SIGKILL")
      } catch {
        signalled = false
      }

      if (!signalled) {
        // Signalling fails for two very different reasons. The process is
        // already gone, which is the outcome we were trying to bring about; or
        // it is there and cannot be reached, which is the worst case there is.
        const supervisor = systemProbe.identify(child.pid ?? -1)
        finish({
          ok: false,
          message: HANDSHAKE_TIMEOUT_MESSAGE,
          phase: "launching",
          ...(supervisor === undefined
            ? {}
            : {
                quarantine: "the supervisor could not be signalled after its handshake deadline",
                supervisor,
              }),
        })
        return
      }

      // `exit` resolves this if it arrives; this is what happens when it does
      // not, and an unconfirmed exit is uncertainty, not success.
      exitTimer = setTimeout(() => {
        // Ask the operating system directly before declaring uncertainty. A
        // process that has already gone is a confirmed exit whether or not the
        // event reached us.
        const supervisor = systemProbe.identify(child.pid ?? -1)
        if (supervisor === undefined) {
          finish({ ok: false, message: HANDSHAKE_TIMEOUT_MESSAGE, phase: "launching" })
          return
        }

        finish({
          ok: false,
          message: HANDSHAKE_TIMEOUT_MESSAGE,
          phase: "launching",
          quarantine: "the supervisor did not exit after being signalled",
          // Recorded so recovery has something it can validate. A quarantine
          // backed by no identity is one nothing can ever confirm safe, and a
          // root held on that basis is held until somebody deletes state by
          // hand.
          supervisor,
        })
      }, environment.exitDeadlineMs ?? SUPERVISOR_EXIT_DEADLINE_MS)
    }, environment.handshakeDeadlineMs ?? SUPERVISOR_STARTUP_DEADLINE_MS)

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
        if (message.type === "ready") {
          handshook = true
          input.onState("supervisorReady")
        }
        if (message.type === "state") input.onState(message.state as ProtocolState)
        if (message.type === "completed") input.onState("executionCompleted")
      }
    })

    child.on("error", () => {
      spawnFailed = true
      finish({
        ok: false,
        message: "the supervisor process could not be started",
        phase: "launching",
      })
    })

    child.on("exit", (code) => {
      if (spawnFailed) return
      if (timedOut) {
        // The signal worked and the process is gone. Still a launching-phase
        // failure, and now a certain one: nothing of this run survives it.
        finish({ ok: false, message: HANDSHAKE_TIMEOUT_MESSAGE, phase: "launching" })
        return
      }
      if (!handshook) {
        finish({
          ok: false,
          message: channelLost
            ? "the supervisor's control channel closed before it completed its handshake"
            : "the supervisor exited before completing its handshake",
          phase: "launching",
        })
        return
      }
      if (code === 0) {
        finish({ ok: true })
        return
      }
      finish({
        ok: false,
        message: `the supervisor exited with status ${code ?? "unknown"}`,
        phase: "terminating",
      })
    })
  })
}

// --- inspection -----------------------------------------------------------

async function inspectRetained(
  environment: ServiceEnvironment,
  request: InspectRunRequest,
): Promise<InspectionResponse<unknown>> {
  // A handle that cannot address storage names nothing, and is answered as
  // such. It never reaches the filesystem, so there is no traversal to
  // defend against further down.
  if (!isRunId(request.runId)) return { status: "notFound", subject: "run" }

  const path = join(runDirectory(environment.storage, request.runId), INDEX_ARTIFACT)

  let contents: string
  try {
    // The index is tool-managed storage, so it must still be a private regular
    // file owned by this user. A symlink here would let anything on the
    // machine decide what a Test Run is reported to have found.
    contents = readPrivateFile(path)
  } catch (error) {
    // "Nothing is here" and "something is here that must not be trusted" are
    // different facts, and reporting the second as the first would hide the
    // only signal anyone gets that the storage was tampered with.
    if (error instanceof UnsafeArtifactError) {
      return { status: "invalid", message: "the retained index for this Test Run is not trustworthy" }
    }
    // A tombstone distinguishes "deleted" from "never known"; without one, the
    // run is genuinely unknown within this trusted root's namespace.
    return tombstoneExists(environment.storage, request.runId)
      ? { status: "expired" }
      : { status: "notFound", subject: "run" }
  }

  // Everything past this point concerns a file that is *present*. Unreadable
  // content is therefore `invalid`, never `notFound`: the evidence exists and
  // cannot be trusted, which is a different thing to tell a caller than that
  // the run was never known.
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { status: "invalid", message: "the retained index for this Test Run could not be read" }
  }

  if (!isNormalizedIndex(parsed)) {
    return { status: "invalid", message: "the retained index for this Test Run could not be read" }
  }
  // The index names the run it was published for. A file that disagrees is not
  // this run's evidence, whatever directory it was found in.
  if (parsed.runId !== request.runId) {
    return { status: "invalid", message: "the retained index does not belong to this Test Run" }
  }

  if (request.facet === "log") {
    return inspectRetainedLog(environment, parsed, request) as InspectionResponse<unknown>
  }

  const lazy =
    request.diagnosticId === undefined && request.testId === undefined
      ? undefined
      : await lazyDetailFor(environment, parsed, request)

  return inspectIndex(
    parsed,
    request,
    environment.cursorSecret,
    environment.trustedRoot,
    lazy,
  ) as InspectionResponse<unknown>
}

/**
 * Detail read from the Result Bundle, under #8's lazy contract.
 *
 * Three things can go wrong and they are three different answers, which is the
 * whole point of returning an outcome rather than `undefined`:
 *
 * - **The installation is gone or is no longer the one that wrote the bundle.**
 *   `unsupported`. A different Xcode may decode the same file differently and
 *   silently, and #8's identity includes the binary digest precisely because a
 *   path-and-version match is not enough.
 * - **The right toolchain ran and could not finish the job.** `incomplete`,
 *   with an annotation — an expired deadline and an ambiguous association are
 *   both this, and they ask different things of a caller.
 * - **It worked.** `available`.
 *
 * None of it can touch the published summary, counts, or outcome: the index is
 * immutable and ordinary paging never comes here.
 */
async function lazyDetailFor(
  environment: ServiceEnvironment,
  index: NormalizedIndex,
  request: InspectRunRequest,
): Promise<LazyOutcome> {
  // One fixed monotonic deadline covering toolchain verification, digest
  // verification and extraction together, per #8. Checked between steps, so a
  // step that finishes late cannot spend the next one's budget.
  const deadline = environment.now() + LAZY_DEADLINE_MS
  const expired = () => environment.now() >= deadline

  const occurrence = occurrenceFor(index, request)
  if (occurrence.status !== "found") return occurrence.outcome

  const bundlePath = join(
    runDirectory(environment.storage, index.runId),
    RUN_ARTIFACTS.resultBundle,
  )
  // Gone, not wrong: the indexed view is still entirely readable, and only
  // the part that would have come from the bundle is missing. `unsupported`
  // is reserved for a toolchain that must not read it.
  if (!existsSync(bundlePath)) return INCOMPLETE_NO_BUNDLE

  const tool = readerFor(environment, bundlePath)
  // The identity recorded when the index was written, not the one this reader
  // happens to carry. Comparing a value with itself verifies nothing.
  if (!toolchainIdentityMatches(tool.identity, index.toolchain)) return { status: "unsupported" }
  if (expired()) return TIMED_OUT

  // Re-verified now, not read off the stabilization flag: the question is
  // whether the bundle is *still* the one the index describes. #8 is explicit
  // that verification is never skipped, only reported as unfinished.
  const record = readRunRecord(environment.storage, index.runId)
  if (record?.bundleDigest === undefined) return INCOMPLETE_DIGEST
  const digest = bundleDigest(bundlePath, Math.max(0, deadline - environment.now()))
  if (digest === undefined) return TIMED_OUT
  if (digest !== record.bundleDigest) return INCOMPLETE_MUTATED
  if (expired()) return TIMED_OUT

  const response = await tool.run(
    "get test-results test-details",
    Math.max(0, deadline - environment.now()),
    occurrence.subject,
  )
  if (!response.ok) return { status: "incomplete", annotation: response.message }

  const decoded = decodeTestDetails(response.payload)
  if (!decoded.ok) return { status: "incomplete", annotation: decoded.message }

  return {
    status: "available",
    detail: {
      activities: decoded.value.activities,
      attachments: decoded.value.attachments,
    },
  }
}

const TIMED_OUT: LazyOutcome = {
  status: "incomplete",
  annotation: "the lazy detail deadline expired before the detail could be read",
}
const INCOMPLETE_NO_BUNDLE: LazyOutcome = {
  status: "incomplete",
  annotation: "the Result Bundle is no longer retained, so no further detail can be read from it",
}
const INCOMPLETE_DIGEST: LazyOutcome = {
  status: "incomplete",
  annotation: "no bundle digest was recorded for this Test Run, so detail cannot be trusted to describe it",
}
const INCOMPLETE_MUTATED: LazyOutcome = {
  status: "incomplete",
  annotation: "the Result Bundle no longer matches the digest recorded for this Test Run",
}

/**
 * The one occurrence a focused request is about, and the Xcode identifier that
 * addresses it.
 *
 * #8 associates detail to occurrences by recorded configuration and device
 * IDs, then by canonical identity — and requires that **exactly one** retained
 * match attaches it. A canonical identity may repeat across occurrences (the
 * same test on two devices is two occurrences), so an ambiguous match returns
 * `incomplete` rather than attaching a sibling occurrence's detail to this one.
 */
function occurrenceFor(
  index: NormalizedIndex,
  request: InspectRunRequest,
):
  | { status: "found"; subject: string }
  | { status: "unresolved"; outcome: LazyOutcome } {
  const testId =
    request.testId ??
    index.testFailures.find((entry) => entry.id === request.diagnosticId)?.testId

  const occurrence = index.occurrences.find((entry) => entry.id === testId)
  if (occurrence === undefined) {
    // A build error belongs to no occurrence, and nothing in the bundle's
    // test details describes it. That is not a failure to read anything.
    return { status: "unresolved", outcome: { status: "incomplete", annotation: NO_ASSOCIATION } }
  }

  const siblings = index.occurrences.filter(
    (entry) =>
      entry.identity.canonical === occurrence.identity.canonical &&
      entry.configurationId === occurrence.configurationId &&
      entry.deviceId === occurrence.deviceId,
  )
  if (siblings.length !== 1) {
    return { status: "unresolved", outcome: { status: "incomplete", annotation: AMBIGUOUS } }
  }

  return { status: "found", subject: occurrence.identity.canonical }
}

const NO_ASSOCIATION = "this diagnostic is not associated with a retained test occurrence"
const AMBIGUOUS =
  "more than one retained occurrence matches this test's configuration, device and identity"

/**
 * One bounded window of the retained raw log.
 *
 * The window is resolved before the file is opened and only those bytes are
 * read: a retained log can be gigabytes, and "read it, then return a slice" is
 * the one implementation that cannot be made to fit the response cap.
 */
function inspectRetainedLog(
  environment: ServiceEnvironment,
  index: NormalizedIndex,
  request: InspectRunRequest,
): InspectionResponse<FacetPage> {
  const resolved = resolveLogWindow(index, request, environment.cursorSecret)
  if (!resolved.ok) return resolved.response

  // Asked before the file is opened. "No log was ever retained" and "the
  // retained log is gone" are different answers, and only the index can tell
  // them apart — a missing file looks identical from the filesystem.
  const unavailable = logAvailability(index)
  if (unavailable !== undefined) return unavailable

  let read: { bytes: Buffer; totalBytes: number }
  try {
    read = readLogWindow(
      join(runDirectory(environment.storage, request.runId), RUN_ARTIFACTS.rawLog),
      resolved.window,
    )
  } catch (error) {
    // The index said the log was retained and it is not readable now. That is
    // a retained artifact that stopped being one, not a facet this run never
    // had, so it reads as expiry rather than as "unsupported".
    if (error instanceof UnsafeArtifactError) {
      return { status: "invalid", message: "the retained log for this Test Run is not trustworthy" }
    }
    return { status: "expired" }
  }

  return inspectLog(index, read.bytes, resolved.window, read.totalBytes, environment.cursorSecret)
}

/** Read the window, from a descriptor validated as private. */
function readLogWindow(path: string, window: LogWindow): { bytes: Buffer; totalBytes: number } {
  const handle = openPrivateFile(path)
  try {
    const totalBytes = handle.size
    if (window.byteOffset >= totalBytes) return { bytes: Buffer.alloc(0), totalBytes }

    const bytes = Buffer.alloc(Math.min(window.maxBytes, totalBytes - window.byteOffset))
    const read = readSync(handle.fd, bytes, 0, bytes.length, window.byteOffset)
    return { bytes: bytes.subarray(0, read), totalBytes }
  } finally {
    closeSync(handle.fd)
  }
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

/**
 * Record the Result Bundle's digest once the bundle is stable.
 *
 * Stabilization is the lifecycle phase after the process has exited and the
 * capture handles are closed, and it sits **outside** the eager interpretation
 * budget deliberately: a bundle near the retention target is not something a
 * 120-second deadline can absorb. Recording it here is what lets a later read
 * say whether it is looking at the same bytes.
 */
function stabilize(
  storage: Storage,
  record: RunRecord,
  bundlePath: string,
  budgetMs = DIGEST_BUDGET_MS,
): { record: RunRecord; verified: "yes" | "no" | "unknown" } {
  if (!existsSync(bundlePath)) return { record, verified: "unknown" }

  const digest = bundleDigest(bundlePath, budgetMs)
  if (digest === undefined) {
    // Verification is never skipped, but it is bounded. Saying `unknown` is
    // how an unfinished check reaches the caller instead of a guess.
    return { record, verified: "unknown" }
  }
  if (record.bundleDigest !== undefined && record.bundleDigest !== digest) {
    // The bundle changed under us. What was read is still what was read; it is
    // the next read that can no longer be trusted to describe the same thing.
    return { record, verified: "no" }
  }

  const next = { ...record, bundleDigest: digest }
  writeRunRecord(storage, next)
  return { record: next, verified: "yes" }
}

/**
 * How long digesting a Result Bundle may take before the answer becomes
 * `unknown`. Bundles near the retention target make this nontrivial, and a
 * digest that never finishes must not hold a run open.
 */
export const DIGEST_BUDGET_MS = 30_000

/**
 * One fixed monotonic deadline per lazy detail operation, per #8.
 *
 * It covers toolchain verification, digest verification and extraction
 * together rather than each separately, because the caller is waiting on the
 * whole operation and dividing the budget would let three steps that each
 * finished "in time" take three times as long.
 */
export const LAZY_DEADLINE_MS = 60_000

/**
 * A deterministic content digest (#8): recursive, name-ordered, and dependent
 * on nothing but the bytes — so two machines reading the same bundle agree.
 *
 * Returns `undefined` when the budget runs out. Verification is never skipped;
 * an unfinished one is reported as unfinished.
 */
export function bundleDigest(path: string, budgetMs = DIGEST_BUDGET_MS): string | undefined {
  const hash = createHash("sha256")
  const deadline = Date.now() + budgetMs
  let expired = false

  const walk = (current: string) => {
    if (expired) return
    let entries: string[]
    try {
      entries = readdirSync(current).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        expired = true
        return
      }
      const child = join(current, entry)
      hash.update(entry)

      // A link is hashed as the text it holds, never followed. Following one
      // would make a bundle's identity depend on bytes outside it, and a link
      // to an ancestor would make the walk depend on the budget to end.
      const stats = lstatSync(child)
      if (stats.isSymbolicLink()) hash.update(readlinkSync(child))
      else if (stats.isDirectory()) walk(child)
      else if (stats.isFile()) hash.update(readFileSync(child))
    }
  }

  walk(path)
  return expired ? undefined : hash.digest("hex")
}
