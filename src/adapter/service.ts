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
import { createHash, type Hash } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
} from "node:fs"
import { join } from "node:path"

import { isRecord } from "../domain/json.ts"
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
import { monotonicNow } from "../domain/clock.ts"
import { createXcresultTool } from "../interpreter/xcresulttool.ts"
import {
  decodeMessages,
  encodeMessage,
  newChannelSecret,
  type ControlMessage,
} from "../runner/control.ts"
import { signallingIsSafe, systemProbe, type ProcessIdentity } from "../runner/identity.ts"
import {
  admit,
  QUARANTINE_REASON,
  QUARANTINE_REASONS,
  releaseSlot,
  type AdmissionEnvironment,
} from "../runner/queue.ts"
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
import {
  reclaimIsolatedDerivedData,
  reconcileRoot,
  type RecoveryReport,
} from "../runner/recovery.ts"
import { resolveTestRun, type ConfigurationOutcome } from "../runner/resolution.ts"
import {
  advance,
  readRunRecord,
  RUN_STATES,
  writeRunRecord,
  type ChildRecord,
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
  /**
   * How an unhandshaken supervisor is signalled, and how the machine is asked
   * whether it is still there. Both default to the real thing; both are
   * overridden only by tests, because "the signal could not be delivered" is
   * not a state a real machine can be asked to produce on demand.
   */
  killProcess?(pid: number): boolean
  identifyProcess?(pid: number): ProcessIdentity | undefined
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
      const message = recoveryMessage(report)
      return {
        status: report.status,
        ...(message === undefined ? {} : { message }),
      }
    },
  }
}

/**
 * What to say about a recovery pass beyond its status.
 *
 * `deferred` needs one most: on its own it is a word for "nothing happened",
 * and without a reason a caller cannot tell it from "nothing needed to
 * happen" — which would make retrying look pointless when it is exactly what
 * to do.
 */
function recoveryMessage(report: RecoveryReport): string | undefined {
  if (report.status === "deferred") {
    return "another OpenCode instance is reconciling this project right now. Nothing was examined; try again in a moment."
  }
  if (report.uncertain.length > 0) {
    return `${report.uncertain.length} run(s) could not be accounted for and still hold the execution slot.`
  }
  return undefined
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

  // The one state this run did reach and never recorded: it launched, so it
  // ran, and the process is gone. Everything earlier it passed through
  // already; everything later belongs to publication.
  const current =
    RUN_STATES.indexOf(record.state) < RUN_STATES.indexOf("executionCompleted")
      ? advance(environment.storage, record, "executionCompleted")
      : record

  if (record.resolved === undefined) {
    return publishRecovered(environment, current, undefined, emptyIndex(environment, runId))
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

  publishRecovered(environment, current, summary, index)
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

  // A run that reached `childRecorded` has a gated child that was spawned and
  // never authorized to `exec`. Recovery normally establishes it is gone
  // before handing the run here, but this function is reachable on its own,
  // and releasing a root with a live gated child on it is precisely what
  // quarantine exists to prevent.
  const survivor = attributableChild(environment, record)
  const finished =
    survivor === undefined
      ? record
      : {
          ...record,
          quarantined: true,
          quarantineReason: QUARANTINE_REASONS.gatedChildStillRunning,
        }
  if (survivor !== undefined) writeRunRecord(environment.storage, finished)

  if (record.resolved === undefined) {
    return publishRecovered(environment, finished, undefined, index)
  }

  const summary = withRuntimeProvenance(
    environment,
    runnerFailureSummary(
      environment,
      {
        record: finished,
        request: { requestedScope: record.requestedScope ?? { kind: "all" } },
        resolution: { resolved: record.resolved },
        admission: {
          admittedAt: record.admittedAt,
          queueDurationMs: record.queueDurationMs ?? 0,
        },
        // Admission through classification, per #7 — measured from the
        // admission this run actually recorded, because that moment is known.
        // The original process duration was never observed and is not invented.
        startedAt: admissionMs(environment, record),
      },
      preLaunchMessage(record),
      "launching",
    ),
  )

  publishRecovered(environment, finished, summary, index)
}

/**
 * Publish what recovery concluded, then give the root back.
 *
 * One function because the order is the guarantee: the artifacts land before
 * ownership moves, so a crash in between leaves a finished run holding a slot
 * — which the next reconciliation resolves — rather than a released root with
 * nothing written to explain it.
 *
 * A missing summary is not an omission: when nothing on the record describes
 * what the run was asked to do, no honest summary can be written, and one that
 * looked authoritative would be worse than none. The index is still published
 * so a later inspection answers "nothing was retained" instead of "never
 * known".
 */
function publishRecovered(
  environment: ServiceEnvironment,
  record: RunRecord,
  summary: TestRunSummary | undefined,
  index: NormalizedIndex,
): void {
  if (summary === undefined) publishIndexOnly(environment, record, index)
  else publishTerminal(environment, record, summary, index)
  releaseOwnership(environment, record.runId)
}

/** The gated child, if one was recorded and is still identifiably running. */
function attributableChild(
  environment: ServiceEnvironment,
  record: RunRecord,
): ChildRecord | undefined {
  if (record.child === undefined) return undefined
  return signallingIsSafe(systemProbe, {
    pgid: record.child.pgid,
    processes: [record.child],
  })
    ? record.child
    : undefined
}

/**
 * What actually happened, by how far the run got.
 *
 * A run that was never admitted past `admitted` started no process at all; one
 * that recorded a child did start one, and it was never allowed to become
 * `xcodebuild`. Saying "no test process ran" for both would be true of neither
 * in the way a reader needs.
 */
function preLaunchMessage(record: RunRecord): string {
  return record.child === undefined
    ? "the Test Run was interrupted before any process was started for it"
    : "the Test Run was interrupted before its process was authorized to start the tests"
}

/**
 * When this run was admitted, as a monotonic-comparable millisecond value.
 *
 * The one place a wall clock is read on purpose. `admittedAt` is an ISO
 * timestamp written by a process that may since have crashed, so there is no
 * monotonic reading of it to recover — the two clocks have to be bridged
 * somewhere, and here is where. It produces a reported duration rather than a
 * deadline, so a clock that has moved skews a number a reader sees instead of
 * cutting work short or letting it run unbounded.
 */
function admissionMs(environment: ServiceEnvironment, record: RunRecord): number {
  const admitted = Date.parse(record.admittedAt)
  return Number.isNaN(admitted) ? environment.now() : environment.now() - (Date.now() - admitted)
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

/**
 * What became of a supervisor that never handshook.
 *
 * The operating system is asked directly rather than inferred from an event: a
 * process that has already gone is a confirmed exit whether or not `exit`
 * reached us, and that certainty is what lets the root go back. One that
 * answers is uncertainty, and its identity travels with the quarantine —
 * because a quarantine backed by no identity is one nothing can ever confirm
 * safe, and a root held on that basis is held until somebody deletes state by
 * hand.
 */
export function unhandshaken(
  supervisor: ProcessIdentity | undefined,
  reason: string,
): SupervisionOutcome {
  return supervisor === undefined
    ? { ok: false, message: HANDSHAKE_TIMEOUT_MESSAGE, phase: "launching" }
    : { ok: false, message: HANDSHAKE_TIMEOUT_MESSAGE, phase: "launching", quarantine: reason, supervisor }
}


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
      const pid = child.pid ?? -1
      const identify = environment.identifyProcess ?? systemProbe.identify
      const kill = environment.killProcess ?? (() => child.kill("SIGKILL"))

      let signalled = true
      try {
        signalled = kill(pid) !== false
      } catch {
        signalled = false
      }

      if (!signalled) {
        // Signalling fails for two very different reasons: the process is
        // already gone, which is the outcome we were trying to bring about, or
        // it is there and cannot be reached, which is the worst case there is.
        finish(unhandshaken(identify(pid), QUARANTINE_REASONS.supervisorUnsignalled))
        return
      }

      // `exit` resolves this if it arrives; this is what happens when it does
      // not, and an unconfirmed exit is uncertainty, not success.
      exitTimer = setTimeout(() => {
        finish(unhandshaken(identify(pid), QUARANTINE_REASONS.supervisorStillRunning))
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
        // A handshake for this run, on a descriptor only the supervisor we
        // spawned holds. Both halves are the authentication: the channel says
        // who is speaking, and the identifier says what they are speaking
        // about. A frame naming some other run is a protocol error, and
        // treating it as this run's hello would disarm a deadline on the
        // strength of somebody else's startup.
        if (message.type === "ready" && message.runId === input.runId) {
          // The startup deadline governs startup and nothing else (issue #72).
          // Left armed, it fires part-way through a perfectly healthy Test Run
          // — `SIGKILL` to the supervisor, and a run that was passing reported
          // as a launching-phase runner failure — for the sole reason that the
          // suite ran longer than the supervisor was given to say hello.
          //
          // Disarmed here and nowhere else, permanently. A handshake cannot be
          // taken back, and everything after it belongs to the Test Run's own
          // timeout and to cancellation. Deliberately the only thing standing
          // between a healthy supervisor and that `SIGKILL`: a second guard
          // inside the timer would read as prudence and would in fact mean no
          // test could tell whether this line still worked.
          handshook = true
          clearTimeout(handshakeTimer)
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
      // `incomplete`, not `invalid`. `invalid` is the contract's answer to a
      // malformed *request*, and the request here is fine — a caller told
      // `invalid` would reasonably go and change what they asked for, when
      // nothing they can ask will help. What went wrong is on this machine,
      // and it is the evidence that cannot be trusted, so it is reported at
      // the level the evidence lives at.
      return untrustworthyEvidence()
    }
    // A tombstone distinguishes "deleted" from "never known"; without one, the
    // run is genuinely unknown within this trusted root's namespace.
    return tombstoneExists(environment.storage, request.runId)
      ? { status: "expired" }
      : { status: "notFound", subject: "run" }
  }

  // Everything past this point concerns a file that is *present*, so none of
  // it is `notFound`: the evidence exists, and what it cannot be trusted to
  // say is a different thing to tell a caller than that the run was never
  // known. #8 then separates the two ways it can fail to say anything.
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return corruptedIndex()
  }

  // A readable index this decoder does not know how to read. Retained indexes
  // outlive decoders within the retention window, and "written by a version
  // that came after this one" is a different answer from "damaged" — nothing
  // is wrong with it, and nothing here can read it.
  //
  // It has to *declare* a version to qualify. A file with no version at all is
  // not an index from another decoder; it is damage that happens to parse.
  const declared = isRecord(parsed) ? parsed["indexVersion"] : undefined
  if (typeof declared === "number" && declared !== INDEX_VERSION) {
    return { status: "unsupported", facet: request.facet }
  }

  if (!isNormalizedIndex(parsed)) return corruptedIndex()
  // The index names the run it was published for. A file that disagrees is not
  // this run's evidence, whatever directory it was found in.
  if (parsed.runId !== request.runId) {
    // Also evidence rather than request: the run id asked for is a perfectly
    // good one, and what is wrong is the file found under it.
    return untrustworthyEvidence()
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
  // step that finishes late cannot spend the next one's budget — and after the
  // last one, so a read that finished everything late is not reported as one
  // that finished in time.
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
  const digested = bundleDigest(bundlePath, Math.max(0, deadline - environment.now()))
  // Two different answers, and they ask different things: a deadline means try
  // again, an unreadable tree means something on this machine needs looking
  // at. Collapsing them told a caller to retry a permission problem.
  if (digested.status !== "digested") {
    return digested.reason === "deadline" ? TIMED_OUT : INCOMPLETE_UNREADABLE
  }
  if (digested.digest !== record.bundleDigest) return INCOMPLETE_MUTATED
  if (expired()) return TIMED_OUT

  const response = await tool.run(
    "get test-results test-details",
    Math.max(0, deadline - environment.now()),
    occurrence.subject,
  )
  if (!response.ok) return { status: "incomplete", annotation: response.message }

  const decoded = decodeTestDetails(response.payload)
  if (!decoded.ok) return { status: "incomplete", annotation: decoded.message }

  // The last check, and the one that makes the deadline cover everything
  // rather than everything except the part that reshapes the payload.
  // Decoding is real work over a structure whose size nothing here controls,
  // and a lazy read that finished it past its budget did not finish in time —
  // reporting it as `available` would make the deadline advisory.
  if (expired()) return TIMED_OUT

  return {
    status: "available",
    detail: {
      activities: decoded.value.activities,
      attachments: decoded.value.attachments,
    },
  }
}

/**
 * Why a lazy detail read came back short, in the caller's words.
 *
 * Gathered into one object so there is a place to *look* at them together, and
 * exported so a test can require them to be distinct rather than assert that
 * each of them is printed — printing them all is satisfied just as well by
 * printing the same sentence four times. They ask different things: a deadline
 * means try again, a bundle retention deleted means it is gone for good.
 *
 * Every one is a literal written here. Nothing in this file interpolates a
 * path, a payload value or another process's output into an annotation, which
 * is what makes rendering one safe rather than merely sanitized.
 */
export const LAZY_ANNOTATIONS = {
  deadlineExpired: "the lazy detail deadline expired before the detail could be read",
  bundleGone: "the Result Bundle is no longer retained, so no further detail can be read from it",
  noDigest:
    "no bundle digest was recorded for this Test Run, so detail cannot be trusted to describe it",
  mutated: "the Result Bundle no longer matches the digest recorded for this Test Run",
  unreadable:
    "the Result Bundle could not be read through completely, so it cannot be verified as the one this Test Run produced",
  noAssociation: "this diagnostic is not associated with a retained test occurrence",
  ambiguous:
    "more than one retained occurrence matches this test's configuration, device and identity",
} as const

const TIMED_OUT: LazyOutcome = {
  status: "incomplete",
  annotation: LAZY_ANNOTATIONS.deadlineExpired,
}
const INCOMPLETE_NO_BUNDLE: LazyOutcome = {
  status: "incomplete",
  annotation: LAZY_ANNOTATIONS.bundleGone,
}
const INCOMPLETE_DIGEST: LazyOutcome = {
  status: "incomplete",
  annotation: LAZY_ANNOTATIONS.noDigest,
}
const INCOMPLETE_MUTATED: LazyOutcome = {
  status: "incomplete",
  annotation: LAZY_ANNOTATIONS.mutated,
}
const INCOMPLETE_UNREADABLE: LazyOutcome = {
  status: "incomplete",
  annotation: LAZY_ANNOTATIONS.unreadable,
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
    return { status: "unresolved", outcome: { status: "incomplete", annotation: LAZY_ANNOTATIONS.noAssociation } }
  }

  const siblings = index.occurrences.filter(
    (entry) =>
      entry.identity.canonical === occurrence.identity.canonical &&
      entry.configurationId === occurrence.configurationId &&
      entry.deviceId === occurrence.deviceId,
  )
  if (siblings.length !== 1) {
    return { status: "unresolved", outcome: { status: "incomplete", annotation: LAZY_ANNOTATIONS.ambiguous } }
  }

  return { status: "found", subject: occurrence.identity.canonical }
}


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
      // Evidence, like every other untrustworthy artifact here: the request
      // named a real run and a real facet, and what cannot be trusted is a
      // file on this machine.
      return untrustworthyEvidence()
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

/**
 * Damaged retained evidence, in the shape #8 asks for.
 *
 * `incomplete` rather than `invalid`: the run happened, its index was
 * published, and what is on disk no longer describes it. A caller is being
 * told the evidence is partial — which it is, to the point of being absent —
 * not that their request was malformed.
 *
 * The message says nothing about what was found. It is describing a file this
 * tool did not write and cannot vouch for, and quoting it would be quoting
 * whatever wrote it.
 */
function damagedEvidence(annotation: string): InspectionResponse<unknown> {
  return {
    status: "incomplete",
    data: undefined,
    truncation: {
      fieldTruncated: false,
      collectionTruncated: false,
      responseTruncated: false,
      hasMore: false,
    },
    annotation,
  }
}

/** Evidence that could not be read at all. */
function corruptedIndex(): InspectionResponse<unknown> {
  return damagedEvidence("the retained evidence for this Test Run could not be read")
}

/**
 * Evidence that is present and must not be trusted.
 *
 * Worded apart from `corruptedIndex` on purpose: damage and tampering are
 * different things to have found, and a reader deciding whether to go and look
 * at their machine needs to know which.
 */
function untrustworthyEvidence(): InspectionResponse<unknown> {
  return damagedEvidence("the retained evidence for this Test Run is not trustworthy")
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

  const digested = bundleDigest(bundlePath, budgetMs)
  if (digested.status !== "digested") {
    // Verification is never skipped, but it is bounded — and it is now also
    // allowed to fail. Saying `unknown` is how an unfinished check reaches the
    // caller instead of a guess, and an unreadable tree is unfinished for a
    // different reason rather than a different answer.
    return { record, verified: "unknown" }
  }
  if (record.bundleDigest !== undefined && record.bundleDigest !== digested.digest) {
    // The bundle changed under us. What was read is still what was read; it is
    // the next read that can no longer be trusted to describe the same thing.
    return { record, verified: "no" }
  }

  const next = { ...record, bundleDigest: digested.digest }
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
 * How much of a file is held in memory at once while digesting it.
 *
 * A Result Bundle near the 5 GiB retention target contains single files far
 * larger than anything that should be resident, and a digest is a streaming
 * operation by nature: the hash never needs more than the chunk in front of
 * it. Reading a file whole to hash it turns a bounded operation into one whose
 * memory is whatever the project happened to produce.
 */
export const DIGEST_CHUNK_BYTES = 1024 * 1024

/**
 * A deterministic content digest (#8): recursive, name-ordered, and dependent
 * on nothing but the bytes — so two machines reading the same bundle agree.
 *
 * Bounded in both directions. Memory is one chunk at a time, whatever the file
 * size; time is the caller's budget, checked *inside* each file as well as
 * between them, because a single large file is exactly where an overrun would
 * otherwise go unnoticed.
 *
 * Never returns a digest for a tree it did not finish walking (issue #77). A
 * directory it could not read, an entry that vanished mid-walk, a file it
 * could not open: each of those is a *different* bundle from the one on disk,
 * and a digest computed over what happened to be readable would compare
 * unequal to the recorded one — reporting a permission problem as evidence
 * that somebody tampered with the bundle.
 *
 * Which is why the answer is typed rather than `undefined`. A deadline means
 * try again; an unreadable tree means something is wrong with the machine, and
 * a caller told the first will keep trying.
 */
export type BundleDigest =
  | { status: "digested"; digest: string }
  | { status: "incomplete"; reason: "deadline" | "unreadable" }

export function bundleDigest(path: string, budgetMs = DIGEST_BUDGET_MS): BundleDigest {
  const hash = createHash("sha256")

  // Monotonic, and a *duration* from the caller rather than an instant. The
  // caller is measuring its own remaining budget on its own clock; handing it
  // an instant would mean two clocks in one deadline, and a wall clock would
  // mean a deadline an NTP step can move while the walk is still running.
  const deadline = monotonicNow() + budgetMs
  let incomplete: "deadline" | "unreadable" | undefined

  const walk = (current: string) => {
    if (incomplete !== undefined) return

    let entries: string[]
    try {
      entries = readdirSync(current).sort()
    } catch {
      // Was swallowed, and the walk carried on. That produced a digest over a
      // subtree, which is a perfectly good digest of something that is not
      // this bundle.
      incomplete = "unreadable"
      return
    }

    for (const entry of entries) {
      if (monotonicNow() >= deadline) {
        incomplete = "deadline"
        return
      }
      const child = join(current, entry)
      hash.update(entry)

      try {
        // A link is hashed as the text it holds, never followed. Following one
        // would make a bundle's identity depend on bytes outside it, and a
        // link to an ancestor would make the walk depend on the budget to end.
        const stats = lstatSync(child)
        if (stats.isSymbolicLink()) hash.update(readlinkSync(child))
        else if (stats.isDirectory()) walk(child)
        else if (stats.isFile() && !hashFile(hash, child, deadline)) {
          incomplete = "deadline"
          return
        }
      } catch {
        // An entry that was listed a moment ago and cannot be examined now:
        // removed underneath us, or never readable in the first place. Both
        // are the same answer — this is not a tree we finished looking at.
        incomplete = "unreadable"
        return
      }

      if (incomplete !== undefined) return
    }
  }

  walk(path)
  return incomplete === undefined
    ? { status: "digested", digest: hash.digest("hex") }
    : { status: "incomplete", reason: incomplete }
}

/**
 * Stream one file into the hash. False when the budget ran out part-way.
 *
 * Opened with `O_NOFOLLOW` but not with the owner-only checks tool-managed
 * files get: the contents of a Result Bundle are written by `xcodebuild` with
 * the ambient umask, and what protects them is the `0700` run directory they
 * sit inside, not their own mode. The caller has already established this
 * entry is a regular file rather than a link.
 */
function hashFile(hash: Hash, path: string, deadline: number): boolean {
  const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)

  try {
    while (true) {
      if (monotonicNow() >= deadline) return false
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) return true
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
}
