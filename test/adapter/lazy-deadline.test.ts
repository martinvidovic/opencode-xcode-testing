/**
 * A lazy read's deadline covers the decode too (issue #52).
 *
 * The lazy path reopens a Result Bundle for focused detail, and #8 gives it
 * one fixed monotonic deadline across three steps: verifying the toolchain,
 * verifying the digest, and extracting. The deadline was checked between the
 * steps and never after the last one — so a read that spent its whole budget
 * getting a payload and then spent more turning that payload into detail came
 * back `available`.
 *
 * That is the failure worth naming, because it is invisible from the outside.
 * The caller gets an answer, the answer is correct, and the only thing wrong
 * with it is that it arrived after the point at which the caller had been
 * promised one. A budget that reports success whenever the work eventually
 * finishes is not a budget; it is a comment.
 *
 * The clock here is deliberate rather than fast: it returns the same instant
 * for every reading the path takes before the decode, and a late one for the
 * check afterwards. That pins the *new* check specifically, rather than any
 * of the earlier ones happening to fire first.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  createTestToolService,
  INDEX_ARTIFACT,
  LAZY_DEADLINE_MS,
  type ServiceEnvironment,
} from "../../src/adapter/service.ts"
import type { XcresultCommand } from "../../src/interpreter/anomalies.ts"
import type { XcresultTool } from "../../src/interpreter/ports.ts"
import { INDEX_VERSION, type NormalizedIndex } from "../../src/interpreter/index-model.ts"
import { createRunDirectory, runDirectory, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import { identityFor, loadFixture } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"
import { recordedDigest } from "./scenarios.ts"

const RUN = "run-lazy"

/**
 * A reader that answers, and a clock that only runs out once it has.
 *
 * The two are built together on purpose. Pinning the check by *counting*
 * clock readings works and is silently wrong the moment anything on the path
 * reads the clock once more or once less: every expiry returns the same
 * outcome, so a miscounted test goes on passing while it asserts a different
 * check. Tying the clock to the event instead — the payload has arrived, so
 * the budget is now spent — says what the test means and cannot drift.
 */
function readerThatExhaustsTheBudget(): { tool: XcresultTool; now: () => number } {
  const fixture = loadFixture("passed")
  let spent = false

  return {
    now: () => (spent ? LAZY_DEADLINE_MS + 3_600_000 : 0),
    tool: {
      identity: identityFor(fixture),
      async run(command: XcresultCommand) {
        if (command !== "get test-results test-details") {
          return { ok: true as const, payload: fixture.payloads[command] ?? {} }
        }
        // Answered in time; the decoding that follows is what overruns.
        spent = true
        return { ok: true as const, payload: { testRuns: [] } }
      },
    },
  }
}

/** A reader with a budget that never runs out. */
function readerWithTimeToSpare(): { tool: XcresultTool; now: () => number } {
  const fixture = loadFixture("passed")
  return {
    now: () => 0,
    tool: {
      identity: identityFor(fixture),
      async run(command: XcresultCommand) {
        return command === "get test-results test-details"
          ? { ok: true as const, payload: { testRuns: [] } }
          : { ok: true as const, payload: fixture.payloads[command] ?? {} }
      },
    },
  }
}

function environmentFor(
  box: Sandbox,
  reader: { tool: XcresultTool; now: () => number },
): ServiceEnvironment {
  return {
    storage: box.storage,
    trustedRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: "/opt/bun" },
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    now: reader.now,
    timestamp: () => "2026-09-13T12:00:00.000Z",
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 7),
    xcresultToolFor: () => reader.tool,
  }
}

const OCCURRENCE = {
  id: "occ-1",
  identity: {
    bundle: "AppTests",
    suite: "LoginTests",
    test: "testSignsIn()",
    canonical: "AppTests/LoginTests/testSignsIn()",
  },
  identityComplete: true,
  status: "failed" as const,
  position: "0",
  attempts: [],
  failures: [],
}

function index(): NormalizedIndex {
  return {
    indexVersion: INDEX_VERSION,
    runId: RUN,
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [OCCURRENCE] as NormalizedIndex["occurrences"],
    testFailures: [],
    buildErrors: [],
    attestations: [],
    scopeVerdict: "unverifiable",
    scopeDigest: "digest",
    requestedSelectionCount: 0,
    observedOutsideScope: 0,
    build: { completeness: "complete" },
    tests: { completeness: "complete" },
    diagnostics: { completeness: "complete" },
    fullMessages: {},
    toolchain: identityFor(loadFixture("passed")),
    log: { availability: "unavailable", retainedBytesExact: false },
    bundleDigestVerified: "unknown",
  }
}

/** A retained run whose bundle is present and whose digest will verify. */
async function retained<T>(work: (box: Sandbox) => Promise<T>): Promise<T> {
  return withSandbox(async (box) => {
    createRunDirectory(box.storage, RUN)

    const bundle = join(runDirectory(box.storage, RUN), RUN_ARTIFACTS.resultBundle)
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, "Data"), "bytes")

    seedRun(box.storage, {
      runId: RUN,
      state: "completed",
      completedAt: "2026-09-13T12:00:00.000Z",
      ...recordedDigest(bundle),
    })
    writeFileSync(join(runDirectory(box.storage, RUN), INDEX_ARTIFACT), JSON.stringify(index()), {
      mode: 0o600,
    })

    return work(box)
  })
}

describe("a lazy read whose budget runs out while it is decoding", () => {
  test("is incomplete and says it timed out, not available", async () => {
    // The budget is spent at the moment the payload arrives, so every step
    // before the decode sees a clock with time left and only the check after
    // it can fire.
    const response = await retained(async (box) => {
      const service = createTestToolService(environmentFor(box, readerThatExhaustsTheBudget()))
      return service.inspect({ runId: RUN, facet: "tests", testId: "occ-1" })
    })

    expect(response.status).toBe("incomplete")
    if (response.status !== "incomplete") return
    expect(response.annotation).toContain("deadline")
  })

  test("answers normally when the budget covers the decode", async () => {
    // The other direction, so the test above cannot pass by refusing
    // everything: a clock that never moves produces a Focused Detail.
    const response = await retained(async (box) => {
      const service = createTestToolService(environmentFor(box, readerWithTimeToSpare()))
      return service.inspect({ runId: RUN, facet: "tests", testId: "occ-1" })
    })

    expect(response.status).toBe("available")
  })
})
