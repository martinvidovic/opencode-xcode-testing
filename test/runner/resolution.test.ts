/**
 * Request validation and settings resolution (#6).
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ProjectConfiguration, TestRunRequest } from "../../src/domain/request.ts"
import { resolveTestRun, type ResolutionEnvironment } from "../../src/runner/resolution.ts"

function repository(build: (root: string) => void = () => {}): { root: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "xcode-test-resolution-"))
  mkdirSync(join(root, "Example.xcodeproj", "xcshareddata", "xcschemes"), { recursive: true })
  writeFileSync(join(root, "Example.xcodeproj", "xcshareddata", "xcschemes", "App.xcscheme"), "<Scheme/>\n")
  build(root)
  return {
    root,
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function resolve(
  request: Partial<TestRunRequest> = {},
  options: { configuration?: ProjectConfiguration; build?: (root: string) => void } = {},
) {
  const repo = repository(options.build)
  try {
    const environment: ResolutionEnvironment = {
      trustedRoot: repo.root,
      ...(options.configuration === undefined
        ? {}
        : { configuration: { status: "loaded" as const, configuration: options.configuration } }),
    }
    return {
      outcome: resolveTestRun(
        {
          requestedScope: { kind: "all" },
          destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
          ...request,
        },
        environment,
      ),
      root: repo.root,
    }
  } finally {
    repo.dispose()
  }
}

function errorsOf(request: Partial<TestRunRequest>, options = {}): Array<{ field: string; code: string }> {
  const { outcome } = resolve(request, options)
  if (outcome.status !== "rejected") return []
  return outcome.result.errors.map(({ field, code }) => ({ field, code }))
}

describe("a resolvable request", () => {
  test("resolves every setting with the provenance it came from", () => {
    const { outcome } = resolve({ scheme: "App", timeoutSeconds: 120 })
    expect(outcome.status).toBe("resolved")
    if (outcome.status !== "resolved") return

    expect(outcome.resolved.xcodeContainer).toMatchObject({ provenance: "discovery" })
    expect(outcome.resolved.scheme).toEqual({ value: "App", provenance: "request" })
    expect(outcome.resolved.destination.provenance).toBe("request")
    expect(outcome.resolved.timeoutSeconds).toEqual({ value: 120, provenance: "request" })
    expect(outcome.resolved.derivedData).toEqual({ value: { mode: "shared" }, provenance: "default" })
  })

  test("prefers the request over configuration, and configuration over discovery", () => {
    const configuration: ProjectConfiguration = {
      schemaVersion: 1,
      scheme: "FromConfiguration",
      timeoutSeconds: 300,
      derivedData: { mode: "isolated" },
    }
    const { outcome } = resolve({ scheme: "FromRequest" }, { configuration })
    if (outcome.status !== "resolved") throw new Error("expected a resolved run")

    expect(outcome.resolved.scheme).toEqual({ value: "FromRequest", provenance: "request" })
    expect(outcome.resolved.timeoutSeconds).toEqual({ value: 300, provenance: "configuration" })
    expect(outcome.resolved.derivedData).toEqual({
      value: { mode: "isolated" },
      provenance: "configuration",
    })
  })

  test("defaults the timeout to 900 seconds and DerivedData to shared", () => {
    const { outcome } = resolve()
    if (outcome.status !== "resolved") throw new Error("expected a resolved run")
    expect(outcome.resolved.timeoutSeconds).toEqual({ value: 900, provenance: "default" })
    expect(outcome.resolved.derivedData.value.mode).toBe("shared")
  })

  test("hands the runner a canonical absolute path nobody named", () => {
    const { outcome, root } = resolve()
    if (outcome.status !== "resolved") throw new Error("expected a resolved run")
    expect(outcome.containerAbsolutePath).toBe(join(root, "Example.xcodeproj"))
    expect(outcome.resolved.xcodeContainer.value.path).toBe("Example.xcodeproj")
  })
})

describe("the destination", () => {
  test("is required, because guessing one runs the tests somewhere else", () => {
    const outcome = resolveTestRun(
      { requestedScope: { kind: "all" } },
      { trustedRoot: "/nonexistent" },
    )
    expect(outcome.status).toBe("rejected")
    if (outcome.status !== "rejected") return
    expect(outcome.result.errors.some((error) => error.field === "destination")).toBe(true)
  })

  test("rejects the separators `-destination` itself uses", () => {
    expect(
      errorsOf({ destination: { kind: "named", platform: "iOS,Simulator", name: "iPhone 17" } }),
    ).toContainEqual({ field: "destination.platform", code: "illegalCharacter" })
    expect(
      errorsOf({ destination: { kind: "named", platform: "iOS Simulator", name: "a=b" } }),
    ).toContainEqual({ field: "destination.name", code: "illegalCharacter" })
  })

  test("leaves an omitted OS omitted", () => {
    const { outcome } = resolve({
      destination: { kind: "named", platform: "iOS Simulator", name: "iPhone 17" },
    })
    if (outcome.status !== "resolved") throw new Error("expected a resolved run")
    expect(outcome.resolved.destination.value).toEqual({
      kind: "named",
      platform: "iOS Simulator",
      name: "iPhone 17",
    })
  })
})

describe("the Requested Scope", () => {
  test("requires at least one selection when it is not `all`", () => {
    expect(errorsOf({ requestedScope: { kind: "selected", tests: [] } })).toContainEqual({
      field: "requestedScope.tests",
      code: "empty",
    })
  })

  test("requires a suite before a test", () => {
    expect(
      errorsOf({
        requestedScope: { kind: "selected", tests: [{ bundle: "AppTests", test: "testA()" }] },
      }),
    ).toContainEqual({ field: "requestedScope.tests[0].test", code: "suiteRequired" })
  })

  test("rejects a component containing the identity separator", () => {
    expect(
      errorsOf({
        requestedScope: { kind: "selected", tests: [{ bundle: "App/Tests" }] },
      }),
    ).toContainEqual({ field: "requestedScope.tests[0].bundle", code: "illegalCharacter" })
  })

  test("rejects an empty component", () => {
    expect(
      errorsOf({ requestedScope: { kind: "selected", tests: [{ bundle: "  " }] } }),
    ).toContainEqual({ field: "requestedScope.tests[0].bundle", code: "empty" })
  })

  test("rejects control characters, which would corrupt an argument invisibly", () => {
    expect(
      errorsOf({
        requestedScope: { kind: "selected", tests: [{ bundle: "App\u0000Tests" }] },
      }),
    ).toContainEqual({ field: "requestedScope.tests[0].bundle", code: "controlCharacter" })
  })
})

describe("the timeout", () => {
  test("accepts the inclusive bounds and rejects anything outside them", () => {
    expect(errorsOf({ timeoutSeconds: 1 })).toEqual([])
    expect(errorsOf({ timeoutSeconds: 7_200 })).toEqual([])
    expect(errorsOf({ timeoutSeconds: 0 })).toContainEqual({
      field: "timeoutSeconds",
      code: "outOfRange",
    })
    expect(errorsOf({ timeoutSeconds: 7_201 })).toContainEqual({
      field: "timeoutSeconds",
      code: "outOfRange",
    })
    expect(errorsOf({ timeoutSeconds: 1.5 })).toContainEqual({
      field: "timeoutSeconds",
      code: "outOfRange",
    })
  })
})

describe("the container path", () => {
  test("must be repository-relative", () => {
    expect(
      errorsOf({ xcodeContainer: { kind: "project", path: "/etc/Example.xcodeproj" } }),
    ).toContainEqual({ field: "xcodeContainer.path", code: "notRelative" })
  })

  test("may not traverse out of the repository", () => {
    expect(
      errorsOf({ xcodeContainer: { kind: "project", path: "../Example.xcodeproj" } }),
    ).toContainEqual({ field: "xcodeContainer.path", code: "traversal" })
  })

  test("must match the extension its kind declares", () => {
    expect(
      errorsOf({ xcodeContainer: { kind: "workspace", path: "Example.xcodeproj" } }),
    ).toContainEqual({ field: "xcodeContainer.path", code: "extensionMismatch" })
  })

  test("must exist", () => {
    expect(
      errorsOf({ xcodeContainer: { kind: "project", path: "Missing.xcodeproj" } }),
    ).toContainEqual({ field: "xcodeContainer.path", code: "notFound" })
  })

  test("may not resolve outside the repository through a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "xcode-test-outside-"))
    mkdirSync(join(outside, "Elsewhere.xcodeproj"), { recursive: true })
    try {
      const errors = errorsOf(
        { xcodeContainer: { kind: "project", path: "Linked.xcodeproj" } },
        {
          build: (root: string) => {
            symlinkSync(join(outside, "Elsewhere.xcodeproj"), join(root, "Linked.xcodeproj"))
          },
        },
      )
      expect(errors).toContainEqual({ field: "xcodeContainer.path", code: "symlinkEscape" })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("discovery ambiguity", () => {
  test("is reported with the candidates that caused it", () => {
    const { outcome } = resolve(
      {},
      {
        build: (root: string) => {
          mkdirSync(join(root, "Sample.xcodeproj"), { recursive: true })
        },
      },
    )
    expect(outcome.status).toBe("rejected")
    if (outcome.status !== "rejected") return

    const error = outcome.result.errors.find((entry) => entry.field === "xcodeContainer")
    expect(error?.code).toBe("ambiguous")
    expect(error?.candidates).toEqual(["Example.xcodeproj", "Sample.xcodeproj"])
  })
})

describe("a rejection", () => {
  test("reports every independently detectable error at once", () => {
    const errors = errorsOf({
      timeoutSeconds: 0,
      destination: { kind: "named", platform: "iOS,Simulator", name: "a=b" },
      requestedScope: { kind: "selected", tests: [] },
    })
    expect(errors.map((error) => error.field).sort()).toEqual([
      "destination.name",
      "destination.platform",
      "requestedScope.tests",
      "timeoutSeconds",
    ])
  })

  test("orders errors by field path, then code, and reports what it holds", () => {
    const { outcome } = resolve({
      timeoutSeconds: 0,
      requestedScope: { kind: "selected", tests: [] },
    })
    if (outcome.status !== "rejected") throw new Error("expected a rejection")

    const fields = outcome.result.errors.map((error) => error.field)
    expect(fields).toEqual([...fields].sort())
    expect(outcome.result.outcome).toBe("invalid")
    expect(outcome.result.errorSection).toEqual({ total: 2, shown: 2, truncated: false })
  })
})
