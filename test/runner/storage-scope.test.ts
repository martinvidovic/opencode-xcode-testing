/** Composite storage scope isolation for module configurations (issue #137). */

import { describe, expect, test } from "bun:test"

import { noteRootSeen, readRegistry } from "../../src/runner/housekeeping.ts"
import { acquireReadLease, reconcileLeases } from "../../src/runner/leases.ts"
import { createRunDirectory, prepareStorage, storageFor } from "../../src/runner/paths.ts"
import { readQueue, writeQueue } from "../../src/runner/queue.ts"
import { collectRuns } from "../../src/runner/retention.ts"
import { readRunRecord } from "../../src/runner/state.ts"
import { seedRun, withSandbox } from "./harness.ts"

describe("module storage scopes", () => {
  test("isolate coordination, leases, recovery records, retention, and housekeeping", async () => {
    await withSandbox(({ homeDir, storage: first }) => {
      const second = storageFor(homeDir, "/workspace/example", "/workspace/example/module-b")
      prepareStorage(second)

      createRunDirectory(first, "run-same")
      seedRun(first, { runId: "run-same", state: "completed" })
      writeQueue(first, { schemaVersion: 1, nextSequence: 2, tickets: [], activeRunId: "run-same" })
      acquireReadLease(first, "run-same", 0)
      noteRootSeen(first, 1)
      noteRootSeen(second, 1)

      expect(readQueue(second).activeRunId).toBeUndefined()
      expect(reconcileLeases(second, 1).runs).toEqual(new Set())
      expect(readRunRecord(second, "run-same")).toBeUndefined()
      expect(collectRuns({ storage: second, now: () => 1 })).toEqual([])
      expect(Object.keys(readRegistry(first).roots).sort()).toEqual([first.rootKey, second.rootKey].sort())
    }, "/workspace/example", "/workspace/example/module-a")
  })
})
