/**
 * Startup, configuration and provenance wiring (ADR 0002, issue #25).
 *
 * These are the paths where the adapter decides whether to exist at all, and
 * what it will tell a caller when it cannot work. Every one of them fails
 * quietly if it fails at all, which is why they are asserted here rather than
 * left to be noticed in a session that mysteriously has no Xcode tools in it.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveBudget } from "../../src/adapter/budget.ts"
import { cacheIsValid } from "../../src/adapter/runtime.ts"
import { unavailableService } from "../../src/adapter/service.ts"
import type { ResultProvenance } from "../../src/domain/result.ts"
import { readProjectConfiguration } from "../../src/adapter/trusted-root.ts"
import { resolveTestRun } from "../../src/runner/resolution.ts"
import { storageFor, storageForRootKey } from "../../src/runner/paths.ts"

function project(build: (root: string) => void = () => {}): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-startup-"))
  mkdirSync(join(root, ".opencode"), { recursive: true })
  build(root)
  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function withProject<T>(work: (root: string) => T, build?: (root: string) => void): T {
  const created = project(build)
  try {
    return work(created.root)
  } finally {
    created.dispose()
  }
}

describe("a present but invalid project configuration", () => {
  test("is a hard resolution outcome, never a fall-through to discovery", async () => {
    // Treating it as absent is the worst option available: the run proceeds
    // against defaults the project explicitly did not ask for.
    withProject(
      (root) => {
        const configuration = readProjectConfiguration(root)
        expect(configuration.status).toBe("invalid")

        const outcome = resolveTestRun(
          { requestedScope: { kind: "all" } },
          { trustedRoot: root, configuration },
        )

        expect(outcome.status).toBe("rejected")
        if (outcome.status !== "rejected") return
        expect(outcome.result.errors.map((error) => error.field)).toContain("configuration")
      },
      (root) => {
        writeFileSync(join(root, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1, "typo": 1 }')
      },
    )
  })

  test("names what was wrong with it", async () => {
    withProject(
      (root) => {
        const outcome = resolveTestRun(
          { requestedScope: { kind: "all" } },
          { trustedRoot: root, configuration: readProjectConfiguration(root) },
        )
        if (outcome.status !== "rejected") throw new Error("expected a rejection")
        expect(outcome.result.errors[0]?.message).toContain("unknown fields")
      },
      (root) => {
        writeFileSync(join(root, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1, "typo": 1 }')
      },
    )
  })

  test("does not reject a configuration that is merely absent", async () => {
    withProject((root) => {
      const configuration = readProjectConfiguration(root)
      expect(configuration.status).toBe("absent")

      const outcome = resolveTestRun(
        {
          requestedScope: { kind: "all" },
          destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
          xcodeContainer: { kind: "project", path: "Example.xcodeproj" },
          scheme: "App",
        },
        { trustedRoot: root, configuration },
      )
      expect(outcome.status).toBe("resolved")
    }, (root) => {
      mkdirSync(join(root, "Example.xcodeproj"), { recursive: true })
    })
  })
})

describe("the output budget", () => {
  test("is derived from the host's effective limits, not from the defaults", () => {
    // The host does not materialize `tool_output` defaults, and it may well be
    // configured lower than ours. Ignoring it is how host truncation happens.
    const budget = resolveBudget({ max_lines: 200, max_bytes: 8_192 })
    expect(budget.maxLines).toBeLessThan(200)
    expect(budget.maxBytes).toBeLessThan(8_192)
  })
})

describe("per-root storage", () => {
  test("can be built from a root key alone, for a root whose path is unknown", () => {
    // User-wide housekeeping visits roots by key; it has no path to hash.
    const home = "/home/somebody"
    const byPath = storageFor(home, "/workspace/example")
    const byKey = storageForRootKey(home, byPath.rootKey)

    expect(byKey.rootDir).toBe(byPath.rootDir)
    expect(byKey.runsDir).toBe(byPath.runsDir)
    expect(byKey.trashDir).toBe(byPath.trashDir)
    expect(byKey.tombstonesDir).toBe(byPath.tombstonesDir)
    expect(byKey.queueFile).toBe(byPath.queueFile)
    expect(byKey.rootLock).toBe(byPath.rootLock)
  })

  test("keeps the registry shared across roots", () => {
    const home = "/home/somebody"
    const a = storageForRootKey(home, "a".repeat(64))
    const b = storageForRootKey(home, "b".repeat(64))

    expect(a.registryFile).toBe(b.registryFile)
    expect(a.rootDir).not.toBe(b.rootDir)
  })
})

describe("an unavailable Test Tool family", () => {
  test("still answers, with the diagnostic naming what is missing", async () => {
    // Registering nothing would read exactly like a project that never opted
    // in, which is the one thing it must not look like.
    const service = unavailableService(
      "no usable Bun runtime was found. Install Bun so it is on PATH, or set `runtime`.",
    )
    const result = await service.start({ requestedScope: { kind: "all" } }, { onState: () => {} })
      .result

    expect(result.outcome).toBe("infrastructureFailed")
    expect((result as { message: string }).message).toContain("Bun")
  })

  test("answers inspection and recovery too, rather than throwing", async () => {
    const service = unavailableService("the toolchain could not be resolved")

    expect(await service.inspect({ runId: "any", facet: "tests" })).toMatchObject({
      status: "invalid",
    })
    expect(await service.recover()).toMatchObject({ status: "failed" })
  })
})

describe("the runtime probe cache", () => {
  test("is valid only while the binary is byte-for-byte the one probed", () => {
    const entry = { path: "/opt/bun", mtimeMs: 10, size: 20, version: "1.4.0" }
    expect(cacheIsValid(entry, { path: "/opt/bun", mtimeMs: 10, size: 20 })).toBe(true)
    expect(cacheIsValid(entry, { path: "/opt/bun", mtimeMs: 11, size: 20 })).toBe(false)
    expect(cacheIsValid(entry, { path: "/opt/bun", mtimeMs: 10, size: 21 })).toBe(false)
    expect(cacheIsValid(entry, undefined)).toBe(false)
  })
})

describe("runtime and host provenance", () => {
  test("surfaces versions and never a path", () => {
    // A model can act on "which Bun"; it cannot act on where that Bun lives,
    // and the path is machine-local.
    const provenance: ResultProvenance = {
      xcodeVersion: "26.4.1",
      xcodeBuild: "17E202",
      xcresulttoolVersion: "24757",
      requestedSchemaVersion: "0.1.0",
      interpreterDecoderVersion: 1,
      runtimeVersion: "1.4.0",
      hostVersion: "1.18.29",
    }

    expect(Object.values(provenance).some((value) => String(value).startsWith("/"))).toBe(false)
  })
})
