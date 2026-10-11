/**
 * Whether the Test Tool could start, and the one way back when it could not
 * for a reason that may not last (issue #162).
 *
 * Setup decides once whether this Location gets a working service. It used to
 * decide for good: a runtime probe that missed its startup deadline left every
 * later call refused with "could not be probed" for the rest of the plugin
 * instance's life, though a timeout says nothing about the runtime — only
 * about one moment on a machine that may have been busy.
 *
 * So a failure is classified when it happens:
 *
 * - **Transient** — a probe or discovery that did not answer in time. It is
 *   probed again, once, when `xcode_test_recover` is called, and the tool
 *   becomes available if the answer is now good. Never on its own and never
 *   in a loop: a refusal that triggered probing would turn every test call on
 *   a broken machine into another round of subprocesses.
 * - **Permanent** — an explicitly configured runtime that cannot run
 *   TypeScript, no runtime anywhere, an unusable Xcode. Probing again gives
 *   the same answer, and probing until *something* answers would be exactly
 *   the silent fallback an explicit setting exists to refuse. Recovery says so
 *   rather than pretending to try.
 *
 * Either way the tools are still registered and answer with the diagnostic.
 * Registering nothing would read exactly like a project that never opted in,
 * and "no Xcode tools in this session" is a puzzle where a refusal naming what
 * is missing is an instruction.
 */

import { SCHEMA_VERSION, type TestToolResult } from "../domain/result.ts"
import type { TestToolService } from "./tools.ts"

type RecoverResult = Awaited<ReturnType<TestToolService["recover"]>>

export type Availability =
  | { status: "available"; service: TestToolService }
  | {
      status: "unavailable"
      /** Whether probing again could change the answer. */
      transient: boolean
      /** What failed, in words a caller can act on. No private paths. */
      message: string
    }

type Unavailable = Extract<Availability, { status: "unavailable" }>

/**
 * A service that is the working one when setup produced it, and otherwise
 * refuses — revalidating, on an explicit recovery, a failure that may pass.
 *
 * Concurrent recoveries share one revalidation: two callers asking at once
 * are asking the same question, and two rounds of probes would answer it
 * twice while competing with each other for the machine whose load may be
 * the reason for the first timeout.
 */
export function revalidatingService(
  initial: Availability,
  revalidate: () => Promise<Availability>,
): TestToolService {
  if (initial.status === "available") return initial.service

  let state: Availability = initial
  let inFlight: Promise<Availability> | undefined

  const revalidateOnce = (): Promise<Availability> => {
    inFlight ??= revalidate()
      .catch((): Availability => (state.status === "unavailable" ? state : TIMED_OUT_AGAIN))
      .then((next) => {
        state = next
        return next
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  return {
    start(request, hooks, cancellation) {
      if (state.status === "available") return state.service.start(request, hooks, cancellation)
      return {
        // Admission never happens, and the result carries the whole answer.
        admitted: new Promise<never>(() => {}),
        result: Promise.resolve(refusal(state)),
      }
    },

    inspect(request) {
      if (state.status === "available") return state.service.inspect(request)
      return Promise.resolve({ status: "invalid", message: refusalMessage(state) })
    },

    async recover(): Promise<RecoverResult> {
      if (state.status === "available") return state.service.recover()
      if (!state.transient) return permanent(state)

      const next = await revalidateOnce()
      if (next.status === "unavailable") {
        return next.transient
          ? { status: "failed", message: `${next.message} It still did not answer. ${RETRY_HINT}` }
          : permanent(next)
      }

      const recovered = await next.service.recover()
      return {
        ...recovered,
        message: [REVALIDATED, recovered.message].filter((part) => part !== undefined).join(" "),
      }
    },
  }
}

const RECOVER_HINT = "This looks transient: call xcode_test_recover to probe again."
const RETRY_HINT = "Nothing is retried automatically; call xcode_test_recover again once the machine is less busy."
const REVALIDATED = "The runtime and Xcode toolchain were probed again and the Test Tool is available."

/** What a revalidation that threw is taken to mean: still not answering. */
const TIMED_OUT_AGAIN: Unavailable = {
  status: "unavailable",
  transient: true,
  message: "the runtime and Xcode toolchain could not be probed again.",
}

function refusalMessage(state: Unavailable): string {
  return state.transient ? `${state.message} ${RECOVER_HINT}` : state.message
}

function refusal(state: Unavailable): TestToolResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    outcome: "infrastructureFailed",
    phase: "resolving",
    reason: "runnerFailure",
    message: refusalMessage(state),
  }
}

function permanent(state: Unavailable): RecoverResult {
  return {
    status: "failed",
    message: `${state.message} This is not a timeout, so probing again would give the same answer: fix the cause, then start OpenCode again.`,
  }
}
