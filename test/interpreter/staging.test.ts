/**
 * Staging a structured read, and what goes wrong when the machine is busy
 * (issue #84).
 *
 * `b2 zero-match` passed and failed in alternate runs of the same gate, only
 * ever inside the OpenCode host process, and produced three different verdicts
 * about the caller's Result Bundle — `resultBundleUnreadable`,
 * `resultBundleIncomplete`, `unsupportedResultSchema` — for a bundle that
 * re-reads perfectly today. Three verdicts about someone else's evidence, for
 * a fault in how this tool copies output into a file.
 *
 * What is settled: the failures were transient, and the evidence was not at
 * fault. The same bundle, read again, answers — 40 times out of 40 against
 * the very bundle that produced `unsupportedResultSchema`, under heavier
 * synthetic load than the gate applies. What is not settled is why a read
 * inside the host process occasionally does not, and that is what the kept
 * undecodable output below exists to answer the next time it happens.
 *
 * So the claims here are the two that can be made honestly: a read that did
 * not settle is attempted again rather than becoming a verdict on someone
 * else’s Result Bundle, and output that never parsed as JSON is this tool’s
 * own difficulty rather than a statement about their evidence’s schema.
 */

import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createXcresultTool } from "../../src/interpreter/xcresulttool.ts"
import { identityFor, loadFixture } from "./harness.ts"

/**
 * A stand-in `xcresulttool` that misbehaves for its first `failures` calls.
 *
 * Every captured `b2 zero-match` failure was of that shape: a bundle that
 * answers perfectly when read again, having produced one unusable read. A
 * stand-in that fails always would test a broken bundle, which is a different
 * thing and already has an answer.
 */
function toolFailingFirst(
  failures: number,
  misbehaviour: "not-json" | "exit-1",
  payload: string,
): { tool: ReturnType<typeof createXcresultTool>; directory: string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "xcode-test-staging-"))
  const bundle = join(directory, "result.xcresult")
  mkdirSync(bundle, { recursive: true })

  const counter = join(directory, "calls")
  const script = join(directory, "xcresulttool")
  writeFileSync(join(directory, "payload.json"), payload)
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > "${counter}"`,
      `if [ "$n" -lt ${failures} ]; then`,
      misbehaviour === "exit-1" ? "  echo 'unable to open' >&2" : "  printf '{\"errorCoun'",
      misbehaviour === "exit-1" ? "  exit 1" : "  exit 0",
      "fi",
      `cat "${join(directory, "payload.json")}"`,
    ].join(String.fromCharCode(10)),
  )
  chmodSync(script, 0o700)

  const identity = { ...identityFor(loadFixture("passed")), xcresulttoolPath: script }
  return {
    tool: createXcresultTool({ identity, bundlePath: bundle }),
    directory,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

/**
 * A stand-in `xcresulttool` that emits `payload` and exits.
 *
 * Large on purpose: the payload has to exceed a pipe's capacity and the
 * sink's high-water mark, or every chunk is delivered before the process can
 * exit and there is nothing for the race to be about.
 */
function toolEmitting(payload: string): {
  tool: ReturnType<typeof createXcresultTool>
  directory: string
  dispose(): void
} {
  const directory = mkdtempSync(join(tmpdir(), "xcode-test-staging-"))
  const bundle = join(directory, "result.xcresult")
  mkdirSync(bundle, { recursive: true })

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

/** A build-results payload, sized so that staging it takes several chunks. */
function buildResults(errors: number): string {
  return JSON.stringify({
    actionTitle: "Testing workspace Example with scheme App",
    analyzerWarningCount: 0,
    analyzerWarnings: [],
    errorCount: errors,
    errors: Array.from({ length: errors }, (_, index) => ({
      className: "DVTTextDocumentLocation",
      issueType: "Swift Compiler Error",
      message: `error ${index}: ${"detail ".repeat(40)}`,
      targetName: "App",
    })),
    status: "succeeded",
    warningCount: 0,
    warnings: [],
  })
}

/**
 * Occupy the event loop the way a live host does.
 *
 * Not decoration. The whole difference between this passing everywhere and
 * failing only inside the OpenCode host process is how much else is competing
 * for turns while a read finishes — so a regression test that runs on an idle
 * loop is a test of the case that never failed.
 */
function underLoad<T>(work: () => Promise<T>): Promise<T> {
  const timers = Array.from({ length: 24 }, () =>
    setInterval(() => {
      // Synchronous work, because that is what delays the delivery of a
      // pending `data` event: an idle timer would not.
      let sum = 0
      for (let i = 0; i < 40_000; i += 1) sum += i
      if (sum < 0) throw new Error("unreachable")
    }, 1),
  )
  return work().finally(() => {
    for (const timer of timers) clearInterval(timer)
  })
}

describe("a payload staged while the machine is busy", () => {
  test("reaches the decoder whole, every time", async () => {
    // Repeated and loaded because a single green read proves nothing about an
    // intermittent one — which is how this survived a gate that passed. It
    // does not reproduce the host-only failure, and saying so is the point:
    // the staging path holds under every load this repository can apply, so
    // whatever differs inside the host is not visible from here yet.
    const payload = buildResults(400)
    const expected = JSON.parse(payload) as { errorCount: number; errors: unknown[] }

    await underLoad(async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const { tool, dispose } = toolEmitting(payload)
        try {
          const response = await tool.run("get build-results", 30_000)

          expect(response.ok).toBe(true)
          if (!response.ok) return

          const decoded = response.payload as { errorCount: number; errors: unknown[] }
          expect(decoded.errorCount).toBe(expected.errorCount)
          expect(decoded.errors).toHaveLength(expected.errors.length)
        } finally {
          dispose()
        }
      }
    })
  }, 120_000)
})

describe("output that is not a payload at all", () => {
  test("is the tool's own difficulty, never a verdict on the caller's bundle", async () => {
    // `unsupported` says the caller's Result Bundle holds a schema this tool
    // does not understand — an answer reached by reading a payload. Text that
    // is not JSON was never a payload, and reporting it as a schema problem
    // sends a caller to inspect evidence that is perfectly sound.
    const { tool, dispose } = toolEmitting("<html>proxy error</html>")
    try {
      const response = await tool.run("get build-results", 30_000)

      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.failure).toBe("commandFailed")
      expect(response.failure).not.toBe("unsupported")
    } finally {
      dispose()
    }
  }, 30_000)

  test("says how much it staged, which is what tells the two causes apart", async () => {
    // Nothing staged at all reads very differently afterwards from a payload
    // cut off part-way through, and the report is all anyone has later.
    const { tool, dispose } = toolEmitting("")
    try {
      const response = await tool.run("get build-results", 30_000)
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.message).toContain("0 bytes")
    } finally {
      dispose()
    }
  }, 30_000)
})

describe("a read that did not settle the first time", () => {
  test("is attempted again rather than becoming a verdict on the bundle", async () => {
    // The whole of `b2 zero-match`. Output that would not parse, once, and the
    // caller was told their Result Bundle had an unsupported schema — for a
    // bundle that answers perfectly on the next read.
    const { tool, dispose } = toolFailingFirst(1, "not-json", buildResults(3))
    try {
      const response = await tool.run("get build-results", 30_000)

      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect((response.payload as { errorCount: number }).errorCount).toBe(3)
    } finally {
      dispose()
    }
  }, 30_000)

  test("is attempted again when the toolchain itself exits non-zero", async () => {
    // The other captured cause: `xcresulttool metadata get` exiting 1 against
    // a bundle it had just written.
    const { tool, dispose } = toolFailingFirst(1, "exit-1", JSON.stringify({ id: "x" }))
    try {
      expect((await tool.run("metadata get", 30_000)).ok).toBe(true)
    } finally {
      dispose()
    }
  }, 30_000)

  test("gives up rather than sitting on a bundle that is genuinely broken", async () => {
    // A mitigation for a read that did not settle, not a way to wait out
    // evidence that will never answer. Each attempt spends the caller's own
    // budget, which is the budget the answer has to arrive within.
    const { tool, dispose } = toolFailingFirst(99, "exit-1", "{}")
    try {
      const response = await tool.run("metadata get", 30_000)
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.failure).toBe("bundleUnreadable")
    } finally {
      dispose()
    }
  }, 30_000)

  test("does not repeat an answer it already has about the payload", async () => {
    // `unsupported` is reached by reading a payload and not recognizing it.
    // Reading it again produces the same answer more slowly.
    const { tool, dispose } = toolEmitting(JSON.stringify({ deep: "x".repeat(16) }))
    try {
      const response = await tool.run("get build-results", 30_000)
      expect(response.ok).toBe(true)
    } finally {
      dispose()
    }
  }, 30_000)
})

describe("output that would not decode", () => {
  test("is kept beside the run's artifacts, where the gate already looks", async () => {
    // It was deleted a line after it was read, so the one artifact that
    // identifies why a read failed never survived the read that failed —
    // and each occurrence was chased by rerunning a gate until it happened
    // again.
    const { tool, directory, dispose } = toolFailingFirst(99, "not-json", "{}")
    try {
      expect((await tool.run("get build-results", 30_000)).ok).toBe(false)

      // One per attempt, numbered. A fixed name would have the retry destroy
      // the first capture, which is the most informative of them and the whole
      // reason any of this is kept.
      const kept = readdirSync(directory)
        .filter((name) => name.startsWith("undecodable-"))
        .sort()
      expect(kept).toEqual([
        "undecodable-get-build-results-0.json",
        "undecodable-get-build-results-1.json",
        "undecodable-get-build-results-2.json",
      ])
      for (const name of kept) {
        expect(readFileSync(join(directory, name), "utf8")).toBe('{"errorCoun')
      }
    } finally {
      dispose()
    }
  }, 30_000)

  test("costs nothing on the path that works", async () => {
    const { tool, directory, dispose } = toolEmitting(buildResults(2))
    try {
      expect((await tool.run("get build-results", 30_000)).ok).toBe(true)
      expect(readdirSync(directory).filter((name) => name.startsWith("undecodable-"))).toEqual([])
      // And the scratch file itself never outlives the read that made it.
      expect(readdirSync(directory).filter((name) => name.startsWith(".xcresult-read-"))).toEqual([])
    } finally {
      dispose()
    }
  }, 30_000)
})

describe("a failure that will not become true by waiting", () => {
  test("is reported at once rather than retried on the caller's budget", async () => {
    // `commandFailed` covers both "the bundle was not settled yet" and "there
    // is no toolchain here". Only one of them clears itself, and spending the
    // caller's answer budget on the other makes a clear failure slower without
    // making it likelier to succeed.
    const directory = mkdtempSync(join(tmpdir(), "xcode-test-staging-"))
    const bundle = join(directory, "result.xcresult")
    mkdirSync(bundle, { recursive: true })
    const identity = {
      ...identityFor(loadFixture("passed")),
      xcresulttoolPath: join(directory, "no-such-tool"),
    }
    const tool = createXcresultTool({ identity, bundlePath: bundle })

    try {
      const started = Date.now()
      const response = await tool.run("get build-results", 30_000)
      const elapsed = Date.now() - started

      expect(response.ok).toBe(false)
      // Two retries and their backoffs would put this well past 300ms.
      expect(elapsed).toBeLessThan(250)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
