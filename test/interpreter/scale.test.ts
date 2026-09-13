/**
 * Reading a large Result Bundle (#8, issue #23).
 *
 * A synchronous read carries a fixed output-buffer ceiling — around a megabyte
 * by default — and a large valid suite's test hierarchy runs well past it.
 * Truncating there would turn a perfectly good Result Bundle into an
 * unsupported schema, which is the most misleading failure available: the
 * bundle is fine, the suite is fine, and the tool says the schema is wrong.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createXcresultTool } from "../../src/interpreter/xcresulttool.ts"
import { decodeTestResults } from "../../src/interpreter/decode.ts"
import { identityFor, loadFixture } from "./harness.ts"

/** How many test cases to emit. Comfortably past a one-megabyte buffer. */
const CASE_COUNT = 12_000

function largePayloadTool(): { tool: ReturnType<typeof createXcresultTool>; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "xcode-test-scale-"))
  const bundle = join(directory, "result.xcresult")
  mkdirSync(bundle, { recursive: true })

  const cases = Array.from({ length: CASE_COUNT }, (_, index) => ({
    nodeType: "Test Case",
    name: `testCase${index}()`,
    nodeIdentifier: `LargeTests/testCase${index}()`,
    result: "Passed",
    durationInSeconds: 0.001,
  }))

  const payload = JSON.stringify({
    testPlanConfigurations: [{ configurationId: "C1", configurationName: "Configuration 1" }],
    devices: [{ deviceId: "D1", deviceName: "iPhone 17", platform: "iOS Simulator" }],
    testNodes: [
      {
        nodeType: "Test Plan",
        name: "App",
        children: [
          {
            nodeType: "Unit test bundle",
            name: "AppTests",
            children: [{ nodeType: "Test Suite", name: "LargeTests", children: cases }],
          },
        ],
      },
    ],
  })

  // A stand-in for the real tool: it emits exactly what a large suite would.
  const script = join(directory, "xcresulttool")
  writeFileSync(join(directory, "payload.json"), payload)
  writeFileSync(script, `#!/bin/sh\ncat "${join(directory, "payload.json")}"\n`)
  chmodSync(script, 0o700)

  const identity = { ...identityFor(loadFixture("passed")), xcresulttoolPath: script }
  return {
    tool: createXcresultTool({ identity, bundlePath: bundle }),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

describe("a large test hierarchy", () => {
  test("is read in full rather than truncated at a buffer ceiling", async () => {
    const { tool, dispose } = largePayloadTool()
    try {
      const response = await tool.run("get test-results tests", 30_000)

      expect(response.ok).toBe(true)
      if (!response.ok) return

      const decoded = decodeTestResults(response.payload)
      expect(decoded.ok).toBe(true)
      if (!decoded.ok) return

      const suite = decoded.value.nodes[0]?.children[0]?.children[0]
      expect(suite?.children).toHaveLength(CASE_COUNT)
    } finally {
      dispose()
    }
  }, 60_000)

  test("produces a payload well past a one-megabyte synchronous ceiling", async () => {
    const { tool, dispose } = largePayloadTool()
    try {
      const response = await tool.run("get test-results tests", 30_000)
      if (!response.ok) throw new Error("expected a payload")
      expect(JSON.stringify(response.payload).length).toBeGreaterThan(1024 * 1024)
    } finally {
      dispose()
    }
  }, 60_000)
})

describe("a read that outlives its budget", () => {
  test("is stopped rather than left to finish into a passed deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-slow-"))
    const bundle = join(directory, "result.xcresult")
    mkdirSync(bundle, { recursive: true })

    const script = join(directory, "xcresulttool")
    writeFileSync(script, "#!/bin/sh\nsleep 30\n")
    chmodSync(script, 0o700)

    try {
      const identity = { ...identityFor(loadFixture("passed")), xcresulttoolPath: script }
      const tool = createXcresultTool({ identity, bundlePath: bundle })

      const started = Date.now()
      const response = await tool.run("get test-results tests", 300)

      expect(response).toMatchObject({ ok: false, failure: "timedOut" })
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
