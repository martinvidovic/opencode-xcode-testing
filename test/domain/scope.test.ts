import { describe, expect, test } from "bun:test"

import {
  canonicalScopeJson,
  canonicalTestIdentity,
  normalizeRequestedScope,
  requestedScopeDigest,
  type RequestedScope,
} from "../../src/domain/scope.ts"

describe("Requested Scope normalization", () => {
  test("deduplicates identical selections", () => {
    const scope: RequestedScope = {
      kind: "selected",
      tests: [
        { bundle: "AppTests", suite: "LoginTests" },
        { bundle: "AppTests", suite: "LoginTests" },
      ],
    }
    expect(normalizeRequestedScope(scope)).toEqual({
      kind: "selected",
      tests: [{ bundle: "AppTests", suite: "LoginTests" }],
    })
  })

  test("sorts by bundle, then suite, then test", () => {
    const scope: RequestedScope = {
      kind: "selected",
      tests: [
        { bundle: "UITests", suite: "A" },
        { bundle: "AppTests", suite: "B", test: "b" },
        { bundle: "AppTests", suite: "B", test: "a" },
        { bundle: "AppTests", suite: "A" },
      ],
    }
    expect(normalizeRequestedScope(scope)).toEqual({
      kind: "selected",
      tests: [
        { bundle: "AppTests", suite: "A" },
        { bundle: "AppTests", suite: "B", test: "a" },
        { bundle: "AppTests", suite: "B", test: "b" },
        { bundle: "UITests", suite: "A" },
      ],
    })
  })

  test("orders a bundle-only selection before a suite selection in the same bundle", () => {
    const scope: RequestedScope = {
      kind: "selected",
      tests: [{ bundle: "AppTests", suite: "A" }, { bundle: "AppTests" }],
    }
    expect(normalizeRequestedScope(scope).kind === "selected").toBe(true)
    expect((normalizeRequestedScope(scope) as { tests: unknown[] }).tests[0]).toEqual({
      bundle: "AppTests",
    })
  })

  test("leaves absent fields absent rather than filling them in", () => {
    expect(canonicalScopeJson({ kind: "selected", tests: [{ bundle: "AppTests" }] })).toBe(
      '{"kind":"selected","tests":[{"bundle":"AppTests"}]}',
    )
  })
})

describe("the Requested Scope digest", () => {
  test("is lowercase hexadecimal SHA-256", () => {
    expect(requestedScopeDigest({ kind: "all" })).toMatch(/^[0-9a-f]{64}$/)
  })

  test("exists for the `all` scope", () => {
    expect(requestedScopeDigest({ kind: "all" })).toBe(
      requestedScopeDigest({ kind: "all" }),
    )
  })

  test("covers `kind`, so `all` and an empty selection differ", () => {
    expect(requestedScopeDigest({ kind: "all" })).not.toBe(
      requestedScopeDigest({ kind: "selected", tests: [] }),
    )
  })

  test("is stable across selection order and duplication", () => {
    const a: RequestedScope = {
      kind: "selected",
      tests: [
        { bundle: "AppTests", suite: "B" },
        { bundle: "AppTests", suite: "A" },
      ],
    }
    const b: RequestedScope = {
      kind: "selected",
      tests: [
        { bundle: "AppTests", suite: "A" },
        { bundle: "AppTests", suite: "B" },
        { bundle: "AppTests", suite: "A" },
      ],
    }
    expect(requestedScopeDigest(a)).toBe(requestedScopeDigest(b))
  })

  test("distinguishes an absent component from an empty one", () => {
    expect(requestedScopeDigest({ kind: "selected", tests: [{ bundle: "AppTests" }] })).not.toBe(
      requestedScopeDigest({ kind: "selected", tests: [{ bundle: "AppTests", suite: "" }] }),
    )
  })
})

describe("canonical test identity", () => {
  test("serializes as Bundle/Suite/test", () => {
    expect(canonicalTestIdentity({ bundle: "AppTests", suite: "LoginTests", test: "testOk" })).toBe(
      "AppTests/LoginTests/testOk",
    )
  })

  test("omits components that are absent", () => {
    expect(canonicalTestIdentity({ bundle: "AppTests", suite: "LoginTests" })).toBe(
      "AppTests/LoginTests",
    )
    expect(canonicalTestIdentity({ bundle: "AppTests" })).toBe("AppTests")
  })
})
