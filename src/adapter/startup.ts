/**
 * The plugin-startup sequence (ADR 0002).
 *
 * The factory is awaited before every other host service, so nothing here may
 * block indefinitely. The shape follows from that:
 *
 * - **Gates first, sequentially.** The enablement marker and the structural
 *   tree check are the only steps that can short-circuit everything behind
 *   them, and both are sub-millisecond.
 * - **Unmarked-root fast path.** When the marker is absent the factory skips
 *   the probe, the version read and root-local reconciliation *entirely* — not
 *   merely registration. This is what keeps a project with no Xcode in it from
 *   paying anything at all.
 * - **Everything else bounded and concurrent** under a shared 10-second
 *   ceiling. That ceiling is a defect guard, not an expected cost: the work is
 *   independent, so the expected worst case is nearer five seconds. On expiry
 *   the factory returns with whatever finished — every item is idempotent,
 *   retried next start, or degradable to `unknown`.
 *
 * Structural verification exists because a static import graph cannot protect a
 * file that is merely read at runtime. A partial copy of the plugin is a
 * different failure class from host-version skew, and registering tools that
 * cannot work is worse than registering none.
 */

export const STARTUP_DEADLINE_MS = 10_000
export const RUNTIME_PROBE_BUDGET_MS = 2_000
export const HOST_VERSION_BUDGET_MS = 2_000
export const RECONCILIATION_BUDGET_MS = 5_000
export const HOUSEKEEPING_BUDGET_MS = 5_000

/** Enumerated explicitly. Adding one is a deliberate, recorded act. */
export const TESTED_HOST_VERSIONS = ["1.18.29", "1.18.30"] as const

export type StartupPorts = {
  /** `<trusted-root>/.opencode/xcode-test.json` exists. */
  markerExists(): boolean
  /** Files a static import graph cannot protect: entrypoint and sidecars. */
  requiredFiles(): string[]
  /**
   * True only for a readable **regular file**. A directory or a dangling
   * symlink where a source file should be is a broken checkout wearing the
   * shape of a working one.
   */
  regularFileExists(path: string): boolean
  probeRuntime(): Promise<unknown>
  /** Bounded read of `/global/health`; failure degrades to `unknown`. */
  readHostVersion(): Promise<string>
  reconcileRoot(): Promise<void>
  runHousekeeping(): Promise<void>
  /** Monotonic. */
  now(): number
  sleep(ms: number): Promise<void>
  deadlineMs?: number
}

export type StartupOutcome =
  | { status: "disabled" }
  | { status: "structuralFailure"; missing: string[]; diagnostic: string }
  | {
      status: "ready"
      hostVersion: string
      hostVersionTested: boolean
      runtime: unknown
      /** True when the ceiling expired — a defect signal, not a normal state. */
      deadlineExpired: boolean
      /** Which bounded items did not finish in time. */
      incomplete: string[]
    }

export async function runStartup(ports: StartupPorts): Promise<StartupOutcome> {
  const deadline = ports.now() + (ports.deadlineMs ?? STARTUP_DEADLINE_MS)
  const incomplete: string[] = []

  const bounded = async <T>(
    name: string,
    budgetMs: number,
    work: Promise<T>,
  ): Promise<T | undefined> => {
    const remaining = Math.min(budgetMs, deadline - ports.now())
    if (remaining <= 0) {
      incomplete.push(name)
      return undefined
    }
    const expiry = ports.sleep(remaining).then(() => EXPIRED)
    const outcome = await Promise.race([work.catch(() => FAILED), expiry])
    if (outcome === EXPIRED || outcome === FAILED) {
      incomplete.push(name)
      return undefined
    }
    return outcome as T
  }

  // Gate one. "This is not an Xcode project" is a normal state, not a
  // diagnostic, so an unmarked root registers nothing and says nothing.
  const marked = ports.markerExists()

  // Gate two, evaluated only behind gate one. Missing shipped files mean a
  // partial checkout; registering tools that cannot work would surface as a
  // confusing failure at first run instead.
  const missing = marked ? ports.requiredFiles().filter((path) => !ports.regularFileExists(path)) : []

  // Both gates are sub-millisecond and run first, in order, because only they
  // can short-circuit what follows. Housekeeping starts after them but is
  // deliberately **not** gated on enablement: it exists for roots whose
  // repositories moved, disappeared, or were de-marked, and gating it on the
  // marker would mean exactly those roots are never reclaimed.
  const housekeeping = bounded("housekeeping", HOUSEKEEPING_BUDGET_MS, ports.runHousekeeping())

  if (!marked) {
    await housekeeping
    return { status: "disabled" }
  }

  if (missing.length > 0) {
    // Nothing is left running behind the return.
    await housekeeping
    return {
      status: "structuralFailure",
      missing,
      diagnostic:
        "the xcode-test plugin checkout is incomplete. Expected the supervisor entrypoint under src/runner/ and the tool description sidecars under src/adapter/descriptions/. Re-clone or update the checkout.",
    }
  }

  // Independent work: a subprocess probe, an HTTP read, and two lock-guarded
  // filesystem passes. Running them concurrently is what keeps the expected
  // cost near the longest one rather than the sum.
  const [runtime, hostVersion] = await Promise.all([
    bounded("runtimeProbe", RUNTIME_PROBE_BUDGET_MS, ports.probeRuntime()),
    bounded("hostVersion", HOST_VERSION_BUDGET_MS, ports.readHostVersion()),
    bounded("reconciliation", RECONCILIATION_BUDGET_MS, ports.reconcileRoot()),
    housekeeping,
  ])

  const version = hostVersion ?? "unknown"
  return {
    status: "ready",
    hostVersion: version,
    hostVersionTested: isTestedHostVersion(version),
    runtime,
    deadlineExpired: ports.now() >= deadline,
    incomplete: incomplete.sort(),
  }
}

const EXPIRED = Symbol("expired")
const FAILED = Symbol("failed")

export function isTestedHostVersion(version: string): boolean {
  return (TESTED_HOST_VERSIONS as readonly string[]).includes(version)
}

/**
 * Skew is surfaced, never blocking. A plugin that refuses to load on a patch
 * bump is worse than one that warns, and `engines.opencode` is enforced only
 * for npm-installed plugins, so warn-and-record is the only policy available.
 */
export function hostVersionDiagnostic(version: string): string | undefined {
  if (version === "unknown" || isTestedHostVersion(version)) return undefined
  return `xcode-test is tested against OpenCode ${TESTED_HOST_VERSIONS.join(" and ")}; this host reports ${version}. Loading normally.`
}
