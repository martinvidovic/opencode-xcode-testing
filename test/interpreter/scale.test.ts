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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createXcresultTool } from "../../src/interpreter/xcresulttool.ts"
import { decodeTestResults } from "../../src/interpreter/decode.ts"
import { identityFor, loadFixture } from "./harness.ts"
import { withJumpingWallClock } from "../wall-clock.ts"

/** How many test cases to emit. Comfortably past a one-megabyte buffer. */
const CASE_COUNT = 12_000

function largePayloadTool(): {
  tool: ReturnType<typeof createXcresultTool>
  directory: string
  dispose(): void
} {
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
    directory,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

/** What the staging directory holds besides the fixture it was built with. */
function stagedFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith(".xcresult-read-"))
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

describe("staging a read", () => {
  test("leaves nothing behind once the payload has been decoded", async () => {
    const { tool, directory, dispose } = largePayloadTool()
    try {
      const response = await tool.run("get test-results tests", 30_000)
      expect(response.ok).toBe(true)

      // The staged file is scratch, not evidence. Leaving it would put a
      // second copy of every read beside the bundle it came from, in a
      // directory whose whole job is holding evidence that must not grow.
      expect(stagedFiles(directory)).toEqual([])
    } finally {
      dispose()
    }
  }, 60_000)

  test("leaves nothing behind when the read is stopped at its deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-staged-"))
    const bundle = join(directory, "result.xcresult")
    mkdirSync(bundle, { recursive: true })

    // Emits steadily and never finishes, so the read is killed with output
    // already staged — the case where a leak would actually cost something.
    const script = join(directory, "xcresulttool")
    writeFileSync(script, "#!/bin/sh\nwhile true; do echo '{\"a\":1}'; sleep 0.05; done\n")
    chmodSync(script, 0o700)

    try {
      const identity = { ...identityFor(loadFixture("passed")), xcresulttoolPath: script }
      const tool = createXcresultTool({ identity, bundlePath: bundle })

      const response = await tool.run("get test-results tests", 300)

      expect(response).toMatchObject({ ok: false, failure: "timedOut" })
      expect(stagedFiles(directory)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("leaves nothing behind when the read fails before it has begun", async () => {
    // The window an asynchronously-opened stream leaves: the read settles
    // immediately — here because the command cannot be started at all — and
    // cleanup runs before the file it is cleaning up has been created. The
    // file then appears a moment later and stays forever.
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-staged-"))
    const bundle = join(directory, "result.xcresult")
    mkdirSync(bundle, { recursive: true })

    try {
      const identity = {
        ...identityFor(loadFixture("passed")),
        xcresulttoolPath: join(directory, "does-not-exist"),
      }
      const tool = createXcresultTool({ identity, bundlePath: bundle })

      const response = await tool.run("get test-results tests", 30_000)

      expect(response).toMatchObject({ ok: false, failure: "commandFailed" })
      expect(stagedFiles(directory)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("a wall clock that jumps while a read is in flight", () => {
  test("does not report a read that finished in time as timed out", async () => {
    // The decode-side deadline is the one that can be wrong here: the read
    // itself is bounded by a timer, but whether the payload is then *decoded*
    // or discarded as late was a wall-clock question. An NTP step of an hour
    // turns a read that took a second into a timeout.
    const { tool, dispose } = largePayloadTool()
    try {
      const response = await withJumpingWallClock(() => tool.run("get test-results tests", 30_000))
      expect(response.ok).toBe(true)
    } finally {
      dispose()
    }
  }, 60_000)
})
