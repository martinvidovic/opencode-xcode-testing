/**
 * The fixed `xcodebuild test` invocation (#6).
 *
 * The safety property is not that the arguments are correct — it is that there
 * is no argument a caller could supply that becomes a command. These tests pin
 * the complete generated list so that adding a pass-through would be visible.
 */

import { describe, expect, test } from "bun:test"

import type { ResolvedTestRun } from "../../src/domain/request.ts"
import {
  buildArguments,
  buildEnvironment,
  formatDestination,
  onlyTestingArguments,
  XCODEBUILD,
} from "../../src/runner/xcodebuild.ts"

const PATHS = {
  containerAbsolutePath: "/private/storage/checkout/Example.xcodeproj",
  resultBundlePath: "/private/storage/run/result.xcresult",
  derivedDataPath: "/private/storage/run/DerivedData",
}

function resolved(overrides: Partial<ResolvedTestRun> = {}): ResolvedTestRun {
  return {
    xcodeContainer: { value: { kind: "project", path: "Example.xcodeproj" }, provenance: "discovery" },
    scheme: { value: "App", provenance: "configuration" },
    destination: {
      value: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
      provenance: "request",
    },
    derivedData: { value: { mode: "shared" }, provenance: "default" },
    timeoutSeconds: { value: 900, provenance: "default" },
    ...overrides,
  }
}

describe("the invocation", () => {
  test("always spawns the fixed binary with the fixed action", () => {
    expect(XCODEBUILD).toBe("/usr/bin/xcodebuild")
    expect(buildArguments(resolved(), { kind: "all" }, PATHS)[0]).toBe("test")
  })

  test("is exactly this argument list, and nothing else", () => {
    expect(buildArguments(resolved(), { kind: "all" }, PATHS)).toEqual([
      "test",
      "-project",
      PATHS.containerAbsolutePath,
      "-scheme",
      "App",
      "-destination",
      "platform=iOS Simulator,name=iPhone 17",
      "-resultBundlePath",
      PATHS.resultBundlePath,
      "-derivedDataPath",
      PATHS.derivedDataPath,
    ])
  })

  test("uses -workspace for a workspace container", () => {
    const args = buildArguments(
      resolved({
        xcodeContainer: {
          value: { kind: "workspace", path: "Example.xcworkspace" },
          provenance: "request",
        },
      }),
      { kind: "all" },
      PATHS,
    )
    expect(args).toContain("-workspace")
    expect(args).not.toContain("-project")
  })

  test("exposes no test-plan, configuration, SDK or provisioning controls", () => {
    const args = buildArguments(resolved(), { kind: "all" }, PATHS).join(" ")
    for (const forbidden of [
      "-testPlan",
      "-configuration",
      "-sdk",
      "-arch",
      "-allowProvisioningUpdates",
      "-disableAutomaticPackageResolution",
      "-parallel-testing-enabled",
    ]) {
      expect(args).not.toContain(forbidden)
    }
  })
})

describe("scope arguments", () => {
  test("are absent for an `all` scope", () => {
    expect(onlyTestingArguments({ kind: "all" })).toEqual([])
  })

  test("map each selection to one exact -only-testing argument", () => {
    expect(
      onlyTestingArguments({
        kind: "selected",
        tests: [
          { bundle: "AppTests", suite: "LoginTests", test: "testSignsIn()" },
          { bundle: "AppTests", suite: "LogoutTests" },
          { bundle: "UITests" },
        ],
      }),
    ).toEqual([
      "-only-testing:AppTests/LoginTests/testSignsIn()",
      "-only-testing:AppTests/LogoutTests",
      "-only-testing:UITests",
    ])
  })

  test("deduplicate and order deterministically, so the same scope is the same command", () => {
    const scope = {
      kind: "selected" as const,
      tests: [
        { bundle: "AppTests", suite: "B" },
        { bundle: "AppTests", suite: "A" },
        { bundle: "AppTests", suite: "B" },
      ],
    }
    expect(onlyTestingArguments(scope)).toEqual([
      "-only-testing:AppTests/A",
      "-only-testing:AppTests/B",
    ])
  })
})

describe("the destination string", () => {
  test("uses id= for an identified destination", () => {
    expect(formatDestination({ kind: "id", id: "ABC-123" })).toBe("id=ABC-123")
  })

  test("omits OS when it was omitted", () => {
    expect(formatDestination({ kind: "named", platform: "iOS Simulator", name: "iPhone 17" })).toBe(
      "platform=iOS Simulator,name=iPhone 17",
    )
  })

  test("includes OS when it was given", () => {
    expect(
      formatDestination({ kind: "named", platform: "iOS Simulator", name: "iPhone 17", os: "26.0" }),
    ).toBe("platform=iOS Simulator,name=iPhone 17,OS=26.0")
  })
})

describe("the child environment", () => {
  test("freezes the developer directory, so the bundle is read back by its writer", () => {
    const environment = buildEnvironment({ PATH: "/usr/bin" }, "/opt/toolchain/Contents/Developer")
    expect(environment["DEVELOPER_DIR"]).toBe("/opt/toolchain/Contents/Developer")
  })

  test("overrides an inherited DEVELOPER_DIR rather than deferring to it", () => {
    const environment = buildEnvironment(
      { DEVELOPER_DIR: "/somewhere/else" },
      "/opt/toolchain/Contents/Developer",
    )
    expect(environment["DEVELOPER_DIR"]).toBe("/opt/toolchain/Contents/Developer")
  })

  test("drops undefined entries rather than passing them through as empty", () => {
    expect(buildEnvironment({ EMPTY: undefined }, "/dev")).toEqual({ DEVELOPER_DIR: "/dev" })
  })
})
