/**
 * Reading every failed test through the tool, within its output budget
 * (issue #163).
 *
 * The description tells a caller to read the tests facet with status failed
 * and the page maximum. The page was capped against the domain's response cap
 * while the adapter fits its own, smaller budget — so a page of long
 * identifiers could arrive as `available (complete)` with its records shed and
 * no cursor to find them. These read the page the way a caller does.
 */

import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { createTestToolService, INDEX_ARTIFACT, type ServiceEnvironment } from "../../src/adapter/service.ts"
import { executeInspect, type ToolDeps } from "../../src/adapter/tools.ts"
import { INSPECTION_PAGE_MAX } from "../../src/domain/limits.ts"
import { createRunDirectory, runDirectory } from "../../src/runner/paths.ts"
import { identityFor, interpretTestHierarchy, loadFixture } from "../interpreter/harness.ts"
import { seedRun, withSandbox, type Sandbox } from "../runner/harness.ts"

/** Long, as generated and parameterized test names are. */
const SUITE = "PaymentReconciliationAcrossRegionalLedgersIntegrationTests"
const FAILING: Array<[string, number]> = Array.from({ length: INSPECTION_PAGE_MAX }, (_, index) => [
  `testReconcilesPartiallySettledMultiCurrencyTransferBatchWithLateArrivingAdjustment${String(index).padStart(3, "0")}()`,
  1 + (index % 3),
])

function environmentFor(box: Sandbox): ServiceEnvironment {
  return {
    storage: box.storage,
    containmentRoot: "/workspace",
    homeDir: box.homeDir,
    toolchain: identityFor(loadFixture("passed")),
    runtime: { path: "/opt/bun" },
    supervisorEntrypoint: "/repo/src/runner/supervisor-entry.ts",
    now: () => 0,
    timestamp: () => "2026-10-11T12:00:00.000Z",
    sleep: () => Promise.resolve(),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    cursorSecret: Buffer.alloc(32, 13),
  }
}

/** The canonical identifiers on a rendered page, and its cursor if any. */
function readPage(text: string): { identifiers: string[]; cursor?: string } {
  const identifiers = [...text.matchAll(/"canonical":"([^"]+)"/g)].map((match) => match[1] as string)
  const cursor = /^cursor\s+(\S+)$/m.exec(text)?.[1]
  return { identifiers, ...(cursor === undefined ? {} : { cursor }) }
}

describe("every failed test, read through the tool", () => {
  test("arrives across pages that fit the budget, none of them shed", async () => {
    const run = await interpretTestHierarchy({ suite: SUITE, passing: 50, failing: FAILING, skipped: [] })

    await withSandbox(async (box) => {
      const runId = run.index.runId
      createRunDirectory(box.storage, runId)
      seedRun(box.storage, { runId, state: "completed" })
      writeFileSync(join(runDirectory(box.storage, runId), INDEX_ARTIFACT), JSON.stringify(run.index), { mode: 0o600 })

      const maxBytes = 5 * 1024
      const deps: ToolDeps = {
        service: createTestToolService(environmentFor(box)),
        budget: { maxLines: 400, maxBytes },
        now: () => 0,
        sleep: () => Promise.resolve(),
        timestamp: () => "2026-10-11T12:00:00.000Z",
      }

      const seen: string[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const text = await executeInspect(
          { runId, facet: "tests", status: "failed", limit: INSPECTION_PAGE_MAX, ...(cursor === undefined ? {} : { cursor }) },
          {},
          deps,
        )
        const page = readPage(text)
        pages += 1

        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxBytes)
        // A page with records shed would carry none; every page carries some.
        expect(page.identifiers.length).toBeGreaterThan(0)
        seen.push(...page.identifiers)
        cursor = page.cursor
      } while (cursor !== undefined && pages < 200)

      expect(seen).toEqual(FAILING.map(([name]) => `AppTests/${SUITE}/${name}`))
    })
  }, 60_000)
})
