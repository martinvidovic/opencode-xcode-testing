/**
 * Project configuration validation (#6, issue #36).
 *
 * This file decides what a project tests. Checking its field *names* and then
 * trusting the values is the same mistake as not checking at all, one level
 * down — `"timeoutSeconds": "soon"` has a perfectly good key and becomes an
 * effective setting. A configuration that is wrong in a way nobody is told
 * about is how a project ends up testing something other than what it says.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MAX_TIMEOUT_SECONDS } from "../../src/domain/limits.ts"
import {
  CONFIG_DIRECTORY,
  CONFIG_FILENAME,
  readProjectConfiguration,
} from "../../src/adapter/project-roots.ts"

/** Write this configuration into a throwaway project and read it back. */
function read(configuration: unknown) {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-config-"))
  try {
    mkdirSync(join(root, CONFIG_DIRECTORY), { recursive: true })
    writeFileSync(join(root, CONFIG_DIRECTORY, CONFIG_FILENAME), JSON.stringify(configuration))
    return readProjectConfiguration(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function invalidMessage(configuration: unknown): string {
  const result = read(configuration)
  if (result.status !== "invalid") throw new Error(`expected invalid, got ${result.status}`)
  return result.message
}

describe("a configuration this tool wrote", () => {
  test("loads", () => {
    expect(
      read({
        schemaVersion: 1,
        xcodeContainer: { kind: "project", path: "App.xcodeproj" },
        scheme: "App",
        destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
        derivedData: { mode: "isolated" },
        timeoutSeconds: 600,
        runtime: "/opt/homebrew/bin/bun",
      }).status,
    ).toBe("loaded")
  })

  test("loads when it says almost nothing", () => {
    // Every field but the version is optional: the tool discovers or defaults
    // the rest, and demanding them would make the marker file a chore.
    expect(read({ schemaVersion: 1 }).status).toBe("loaded")
  })
})

describe("a field with the right name and the wrong value", () => {
  test("is a hard outcome, not a silently ignored setting", () => {
    expect(invalidMessage({ schemaVersion: 1, scheme: 42 })).toContain("scheme")
  })

  test("is caught for a timeout that is not a number", () => {
    expect(invalidMessage({ schemaVersion: 1, timeoutSeconds: "soon" })).toContain("whole number")
  })

  test("is caught for a timeout outside the contract's bounds", () => {
    // In range is a contract, not a suggestion: a value past it would be
    // silently clamped later, or honoured and wrong.
    expect(invalidMessage({ schemaVersion: 1, timeoutSeconds: MAX_TIMEOUT_SECONDS + 1 })).toContain(
      "between",
    )
    expect(invalidMessage({ schemaVersion: 1, timeoutSeconds: 0 })).toContain("between")
  })

  test("is caught for a DerivedData mode that does not exist", () => {
    expect(invalidMessage({ schemaVersion: 1, derivedData: { mode: "wat" } })).toContain("mode")
  })

  test("is caught for a runtime that is not a path", () => {
    expect(invalidMessage({ schemaVersion: 1, runtime: 17 })).toContain("runtime")
  })
})

describe("a nested field with the wrong shape", () => {
  test("is caught in a container", () => {
    expect(invalidMessage({ schemaVersion: 1, xcodeContainer: "App.xcodeproj" })).toContain(
      "must be an object",
    )
    expect(
      invalidMessage({ schemaVersion: 1, xcodeContainer: { kind: "zip", path: "App.zip" } }),
    ).toContain("kind")
    expect(
      invalidMessage({ schemaVersion: 1, xcodeContainer: { kind: "project", path: 5 } }),
    ).toContain("path")
  })

  test("is caught in a destination", () => {
    expect(invalidMessage({ schemaVersion: 1, destination: "iPhone 17" })).toContain(
      "must be an object",
    )
    expect(invalidMessage({ schemaVersion: 1, destination: { kind: "vibes" } })).toContain("kind")
    expect(invalidMessage({ schemaVersion: 1, destination: { kind: "id", id: "" } })).toContain("id")
    expect(
      invalidMessage({ schemaVersion: 1, destination: { kind: "named", platform: "iOS Simulator" } }),
    ).toContain("name")
  })

  test("accepts the optional part of a named destination, and checks it when present", () => {
    expect(
      read({
        schemaVersion: 1,
        destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17", os: "26.0" },
      }).status,
    ).toBe("loaded")
    expect(
      invalidMessage({
        schemaVersion: 1,
        destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17", os: 26 },
      }),
    ).toContain("os")
  })
})

describe("several things wrong at once", () => {
  test("are all reported, so the file is fixed once", () => {
    const message = invalidMessage({
      schemaVersion: 1,
      scheme: 42,
      timeoutSeconds: "soon",
      derivedData: { mode: "wat" },
    })

    expect(message).toContain("scheme")
    expect(message).toContain("timeoutSeconds")
    expect(message).toContain("derivedData")
  })
})

describe("a nested object with an extra key", () => {
  test("is refused, because nesting does not make a typo harmless", () => {
    // The same reasoning as the top level: a key that silently does nothing is
    // how a project ends up testing something other than what it says.
    expect(
      invalidMessage({
        schemaVersion: 1,
        derivedData: { mode: "shared", stratergy: "fast" },
      }),
    ).toContain("stratergy")

    expect(
      invalidMessage({
        schemaVersion: 1,
        xcodeContainer: { kind: "project", path: "App.xcodeproj", branch: "main" },
      }),
    ).toContain("branch")

    expect(
      invalidMessage({
        schemaVersion: 1,
        destination: { kind: "id", id: "SIM", arch: "arm64" },
      }),
    ).toContain("arch")
  })
})
