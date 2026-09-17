/**
 * The final `xcode_test` boundary (issue #97).
 *
 * Inspection and recovery have contained unexpected exceptions for a while and
 * execution did not — which left the one call that spends minutes of someone's
 * time as the one that could end as a raw host error. A thrown error becomes
 * an `output-error` part in which the model sees only the message: title,
 * metadata and attachments are discarded, and `tool.execute.after` never
 * fires. So a decoder meeting a shape it did not expect took with it the run
 * id, every typed fact, and any way of asking about evidence that was sitting
 * on disk the whole time.
 *
 * Two properties, and the second is the one worth the file. Nothing escapes;
 * and what comes back instead keeps the run id and says `adapterFailure`,
 * which is the honest name. Told `runnerFailure`, a caller goes and looks at
 * their toolchain for a defect in this code.
 */

import { describe, expect, test } from "bun:test"

import { MAX_PAYLOAD_DEPTH } from "../../src/domain/limits.ts"
import { decodeTestResults } from "../../src/interpreter/decode.ts"
import { ADMISSION_SETTLE_MS, executeTest, type AdmittedRun, type TestToolService, type ToolContext, type ToolDeps } from "../../src/adapter/tools.ts"
import { RESOLVED } from "../interpreter/harness.ts"
import type { TestArguments } from "../../src/adapter/args.ts"

const ARGS: TestArguments = { scope: { kind: "all" } }

const ADMITTED: AdmittedRun = {
  runId: "0f8a2c",
  resolved: RESOLVED,
  admittedAt: "2026-09-13T10:00:00.000Z",
  queueDurationMs: 12,
}

const CONTEXT: ToolContext = {}

function deps(service: Partial<TestToolService>, overrides: Partial<ToolDeps> = {}): ToolDeps {
  let clock = 0
  return {
    service: {
      start: () => ({ admitted: Promise.resolve(ADMITTED), result: new Promise(() => {}) }),
      inspect: async () => ({ status: "notFound", subject: "run" }),
      recover: async () => ({ status: "alreadyHealthy" }),
      ...service,
    },
    now: () => (clock += 10),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timestamp: () => "2026-09-13T10:00:00.000Z",
    ...overrides,
  }
}

/** A service that admits a run and then fails in the reading of it. */
function failsAfterAdmission(error: unknown): Partial<TestToolService> {
  return {
    start: () => ({
      admitted: Promise.resolve(ADMITTED),
      result: Promise.reject(error),
    }),
  }
}

describe("a failure after a run has been admitted", () => {
  test("keeps the run id, which is the whole of what makes the evidence reachable", async () => {
    // The run happened. Its Result Bundle is on disk under this identifier,
    // and `xcode_test_inspect` can still be asked about it — but only if the
    // identifier survives the failure, and it used to leave inside an
    // exception nobody caught.
    const text = await executeTest(ARGS, CONTEXT, deps(failsAfterAdmission(new Error("decoder exploded"))))

    expect(text).toContain(ADMITTED.runId)
    expect(text).toContain("Test Run infrastructureFailed")
  })

  test("says the Test Tool failed, not that the runner did", async () => {
    // `runnerFailure` says the machinery that runs `xcodebuild` went wrong.
    // Reported for a defect in this code, it sends a caller to inspect a
    // toolchain that is working perfectly.
    const text = await executeTest(ARGS, CONTEXT, deps(failsAfterAdmission(new Error("boom"))))

    expect(text).toContain("adapterFailure")
    expect(text).not.toContain("runnerFailure")
  })

  test("reports nothing as a plausible zero", async () => {
    // Nothing here observed anything: the failure is in the reading, not in
    // the run. "0 tests, 0 failed" would be a claim about the run.
    const text = await executeTest(ARGS, CONTEXT, deps(failsAfterAdmission(new Error("boom"))))

    expect(text).toContain("unavailable")
    expect(text).not.toContain("0 failed")
  })

  test("says nothing about where on this machine anything lives", async () => {
    // An exception's message routinely carries the absolute path of whatever
    // it was reading, and a model can do nothing with one (ADR 0002).
    const text = await executeTest(
      ARGS,
      CONTEXT,
      deps(failsAfterAdmission(new Error("ENOENT: open '/Users/someone/Library/Caches/thing.xcresult'"))),
    )

    expect(text).not.toContain("/Users")
    expect(text).not.toContain("Caches")
    // And still says enough to act on.
    expect(text).toContain("the Test Tool failed while handling this run")
  })
})

describe("a failure before anything was admitted", () => {
  test("is contained too, and says so without inventing a run", async () => {
    const text = await executeTest(
      ARGS,
      CONTEXT,
      deps({
        start: () => {
          throw new Error("the service could not be started")
        },
      }),
    )

    expect(text).toContain("Test Run infrastructureFailed")
    expect(text).not.toContain(ADMITTED.runId)
  })

  test("never becomes a thrown host error", async () => {
    // The property the whole file is about, stated once as itself.
    const thrown = { toString: () => { throw new Error("even stringifying this fails") } }
    await expect(
      executeTest(ARGS, CONTEXT, deps({ start: () => { throw thrown } })),
    ).resolves.toContain("infrastructureFailed")
  })
})

describe("what the boundary must not relabel", () => {
  test("a domain outcome, which is returned rather than thrown", async () => {
    // A failed build, a cancelled run, a Result Bundle nobody could read: all
    // of those are answers. Relabeling one as an adapter defect would be the
    // same misdirection as the one this file exists to end, pointing the
    // other way.
    const text = await executeTest(
      ARGS,
      CONTEXT,
      deps({
        start: () => ({
          admitted: Promise.resolve(ADMITTED),
          result: Promise.resolve({
            schemaVersion: 1 as const,
            outcome: "infrastructureFailed" as const,
            phase: "resolving" as const,
            reason: "discoveryFailed" as const,
            message: "no Xcode container was found",
          }),
        }),
      }),
    )

    expect(text).toContain("discoveryFailed")
    expect(text).not.toContain("adapterFailure")
  })
})

describe("a payload that nests deeper than anyone wrote by hand", () => {
  /** A test hierarchy `depth` levels deep, as a payload the decoder is given. */
  function nested(depth: number): unknown {
    let node: Record<string, unknown> = { nodeType: "Test Case", name: "testDeep()", children: [] }
    for (let level = 0; level < depth; level += 1) {
      node = { nodeType: "Test Suite", name: `Level${level}`, children: [node] }
    }
    return {
      testPlanConfigurations: [{ configurationId: "C1", configurationName: "Configuration 1" }],
      devices: [{ deviceId: "D1", deviceName: "iPhone 17", platform: "iOS Simulator" }],
      testNodes: [node],
    }
  }

  test("is refused with a typed answer rather than exhausting the stack", () => {
    // A `RangeError` out of a decoder is a raw host error where an answer
    // about the evidence belonged — and it is reached before any of the typed
    // machinery that would have described it.
    const decoded = decodeTestResults(nested(MAX_PAYLOAD_DEPTH + 50))

    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.defect).toBe("unsupportedSchema")
    expect(decoded.message).toContain("nests deeper")
  })

  test("is refused before the recursion, not after it", () => {
    // A bound checked on the way out has already spent the stack it was
    // protecting. Ten times the limit is past what the runtime will carry.
    expect(() => decodeTestResults(nested(MAX_PAYLOAD_DEPTH * 10))).not.toThrow()
  })

  test("reads a hierarchy deeper than Xcode writes but inside the bound", () => {
    // The bound is a stack limit, not a schema opinion: a real suite that
    // nests more deeply than expected should be read, not rejected.
    const decoded = decodeTestResults(nested(MAX_PAYLOAD_DEPTH - 8))
    expect(decoded.ok).toBe(true)
  })
})

describe("admission that settles after the failure does", () => {
  /**
   * The ordering that defeats a callback.
   *
   * Nothing orders admission against the result: a service can reject its
   * result from an early throw and resolve admission a microtask later. A
   * boundary that read a variable the callback had not written yet would go on
   * losing the run id — by the code written to stop losing it.
   */
  function admitsLate(delayMs: number): Partial<TestToolService> {
    return {
      start: () => ({
        admitted: new Promise<AdmittedRun>((resolve) => setTimeout(() => resolve(ADMITTED), delayMs)),
        result: Promise.reject(new Error("the payload could not be read")),
      }),
    }
  }

  test("still carries the run id", async () => {
    const text = await executeTest(ARGS, CONTEXT, deps(admitsLate(20)))

    expect(text).toContain(ADMITTED.runId)
    expect(text).toContain("adapterFailure")
  })

  test("does not claim no run was admitted", async () => {
    // Worse than a lost id: an affirmative false statement. `resolving` says
    // the failure happened before a run existed, and a caller told that does
    // not go looking for evidence that is sitting on disk.
    const text = await executeTest(ARGS, CONTEXT, deps(admitsLate(20)))
    expect(text).not.toContain("resolving")
  })

  test("gives up waiting rather than hanging on admission that never comes", async () => {
    const started = Date.now()
    const text = await executeTest(
      ARGS,
      CONTEXT,
      deps({
        start: () => ({
          admitted: new Promise<AdmittedRun>(() => {}),
          result: Promise.reject(new Error("boom")),
        }),
      }),
    )

    expect(text).toContain("infrastructureFailed")
    expect(Date.now() - started).toBeLessThan(ADMISSION_SETTLE_MS * 4)
  })
})

describe("a failure in the rendering of the failure", () => {
  test("still answers, because a handler that can throw is not a handler", async () => {
    // The last resort, exercised rather than asserted. Its own comment calls
    // it unreachable, and an unreachable path nobody has run is a claim.
    const text = await executeTest(
      ARGS,
      CONTEXT,
      deps(failsAfterAdmission(new Error("boom")), {
        budget: () => {
          throw new Error("the budget could not be resolved either")
        },
      }),
    )

    expect(text).toContain("adapterFailure")
    expect(text).toContain(ADMITTED.runId)
  })
})
