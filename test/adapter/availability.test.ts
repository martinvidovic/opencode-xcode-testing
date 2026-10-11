/**
 * A Test Tool that could not start, and whether it can be made to (issue #162).
 *
 * A runtime probe that missed its startup deadline used to leave the plugin
 * instance unavailable for the rest of its life: every later call answered
 * "the runtime could not be probed within the startup deadline", and nothing
 * short of restarting the host would ask again. A timeout is not a verdict on
 * the runtime, though — it is a statement about one moment. These tests are
 * about telling the two apart, and about the one bounded way back: an explicit
 * `xcode_test_recover`, which probes again once and never on its own.
 */

import { describe, expect, test } from "bun:test"

import { revalidatingService, type Availability } from "../../src/adapter/availability.ts"
import type { TestToolService } from "../../src/adapter/tools.ts"
import { isTestRunSummary } from "../../src/domain/result.ts"

/** A service that works, and records that it was asked. */
function workingService(calls: string[]): TestToolService {
  return {
    start() {
      calls.push("start")
      return {
        admitted: new Promise(() => {}),
        result: Promise.resolve({ schemaVersion: 1, outcome: "cancelled", phase: "queued", queuedAt: "t", queueDurationMs: 0 }),
      }
    },
    inspect: async () => {
      calls.push("inspect")
      return { status: "invalid", message: "not under test" }
    },
    recover: async () => {
      calls.push("recover")
      return { status: "alreadyHealthy" }
    },
  }
}

const TIMED_OUT: Availability = {
  status: "unavailable",
  transient: true,
  message: "the runtime could not be probed within the startup deadline.",
}

const MISCONFIGURED: Availability = {
  status: "unavailable",
  transient: false,
  message: "the configured runtime could not execute a TypeScript file.",
}

async function refusalOf(service: TestToolService): Promise<string> {
  const result = await service.start({ requestedScope: { kind: "all" } }, { onState: () => {} }).result
  if (isTestRunSummary(result) || result.outcome !== "infrastructureFailed") throw new Error("expected a refusal")
  return result.message
}

describe("a transient startup failure", () => {
  test("refuses test calls with a reason that says how to recover", async () => {
    const service = revalidatingService(TIMED_OUT, async () => TIMED_OUT)

    const message = await refusalOf(service)

    expect(message).toContain("could not be probed within the startup deadline")
    expect(message).toContain("xcode_test_recover")
  })

  test("is probed again by an explicit recovery, and the tool works afterwards", async () => {
    const calls: string[] = []
    let probes = 0
    const service = revalidatingService(TIMED_OUT, async () => {
      probes += 1
      return { status: "available", service: workingService(calls) }
    })

    const recovered = await service.recover()
    await service.start({ requestedScope: { kind: "all" } }, { onState: () => {} }).result

    expect(probes).toBe(1)
    // The working service's own recovery runs too, because the caller asked
    // to recover the project, not only to be told the runtime answered.
    expect(recovered.status).toBe("alreadyHealthy")
    expect(recovered.message).toContain("probed again")
    expect(calls).toEqual(["recover", "start"])
  })

  test("is never probed again on its own, only when recovery is asked for", async () => {
    let probes = 0
    const service = revalidatingService(TIMED_OUT, async () => {
      probes += 1
      return TIMED_OUT
    })

    await refusalOf(service)
    await refusalOf(service)
    await service.inspect({ runId: "run", facet: "scope" })

    expect(probes).toBe(0)
  })

  test("that fails again is reported each time it is asked, and probed once per ask", async () => {
    let probes = 0
    const service = revalidatingService(TIMED_OUT, async () => {
      probes += 1
      return TIMED_OUT
    })

    const first = await service.recover()
    const second = await service.recover()

    expect(probes).toBe(2)
    expect(first.status).toBe("failed")
    expect(second.status).toBe("failed")
    expect(second.message).toContain("could not be probed")
  })

  test("asked to recover by several callers at once is probed once for all of them", async () => {
    let probes = 0
    let answer: (availability: Availability) => void = () => {}
    const service = revalidatingService(TIMED_OUT, () => {
      probes += 1
      return new Promise((resolve) => {
        answer = resolve
      })
    })

    const both = Promise.all([service.recover(), service.recover()])
    answer({ status: "available", service: workingService([]) })
    const [first, second] = await both

    expect(probes).toBe(1)
    expect(first.status).toBe("alreadyHealthy")
    expect(second.status).toBe("alreadyHealthy")
  })

  test("whose second probe finds a real problem stops being treated as transient", async () => {
    let probes = 0
    const service = revalidatingService(TIMED_OUT, async () => {
      probes += 1
      return MISCONFIGURED
    })

    await service.recover()
    const again = await service.recover()

    expect(probes).toBe(1)
    expect(again.message).toContain("could not execute a TypeScript file")
  })
})

describe("a permanent startup failure", () => {
  test("is not probed again, and says recovery cannot change it", async () => {
    let probes = 0
    const service = revalidatingService(MISCONFIGURED, async () => {
      probes += 1
      return { status: "available", service: workingService([]) }
    })

    const outcome = await service.recover()

    // An invalid explicit runtime fails the same way however often it is
    // probed, and probing until something else answers would be the silent
    // fallback the configuration exists to refuse.
    expect(probes).toBe(0)
    expect(outcome.status).toBe("failed")
    expect(outcome.message).toContain("could not execute a TypeScript file")
    expect(outcome.message).toContain("not a timeout")
    expect(await refusalOf(service)).not.toContain("xcode_test_recover")
  })
})

describe("a service that started", () => {
  test("is used as it is, with nothing in front of it", async () => {
    const calls: string[] = []
    let probes = 0
    const service = revalidatingService({ status: "available", service: workingService(calls) }, async () => {
      probes += 1
      return TIMED_OUT
    })

    await service.recover()

    expect(probes).toBe(0)
    expect(calls).toEqual(["recover"])
  })
})
