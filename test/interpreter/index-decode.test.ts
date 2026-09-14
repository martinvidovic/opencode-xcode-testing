/**
 * Decoding a retained index (#8, issue #36).
 *
 * The index is a file on disk, and "on disk" is not "written by this version
 * of this tool". It may have been published by an older decoder, truncated by
 * a full volume, or edited. Everything in it reaches a model through a facet
 * page, so the decode is the boundary: what passes here is what a caller will
 * be told, and a wrapper that validated its own shape while trusting its
 * contents would be no boundary at all.
 */

import { describe, expect, test } from "bun:test"

import { INDEX_VERSION, isNormalizedIndex } from "../../src/interpreter/index-model.ts"

const TOOLCHAIN = {
  developerDirectory: "/Applications/Xcode.app/Contents/Developer",
  xcodeVersion: "26.4.1",
  xcodeBuild: "17E202",
  xcresulttoolPath: "/usr/bin/xcresulttool",
  xcresulttoolVersion: "24757",
  xcresulttoolDigest: "abc",
  schemaVersion: "0.1.0",
}

/** A well-formed index, which every test here then spoils in one way. */
function index(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    indexVersion: INDEX_VERSION,
    runId: "run-1",
    decoderVersion: 1,
    schemaVersion: "0.1.0",
    occurrences: [],
    testFailures: [],
    buildErrors: [],
    attestations: [],
    scopeVerdict: "matched",
    scopeDigest: "digest",
    requestedSelectionCount: 0,
    observedOutsideScope: 0,
    build: { completeness: "complete" },
    tests: { completeness: "complete" },
    diagnostics: { completeness: "complete" },
    fullMessages: {},
    toolchain: TOOLCHAIN,
    log: { availability: "available", retainedBytesExact: true },
    bundleDigestVerified: "yes",
    ...overrides,
  }
}

describe("a well-formed index", () => {
  test("decodes", () => {
    expect(isNormalizedIndex(index())).toBe(true)
  })
})

describe("closed sets are closed", () => {
  test("a scope verdict outside the contract is not a scope verdict", () => {
    // `"definitely fine"` reads as authoritative and means nothing this tool
    // ever produced. A facet page would hand it straight to a model.
    expect(isNormalizedIndex(index({ scopeVerdict: "definitely fine" }))).toBe(false)
  })

  test("a test status outside the contract is not a status", () => {
    const occurrence = {
      id: "occ-1",
      identity: { canonical: "AppTests/T/test()" },
      status: "probably-passed",
      position: "0",
      failures: [],
      attempts: [],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
  })

  test("an attestation verdict outside the contract is not a verdict", () => {
    const attestation = { selection: { bundle: "AppTests" }, verdict: "observed" }
    expect(isNormalizedIndex(index({ attestations: [attestation] }))).toBe(false)
  })

  test("a completeness outside the contract is not a completeness", () => {
    expect(isNormalizedIndex(index({ tests: { completeness: "mostly" } }))).toBe(false)
  })

  test("a digest verdict outside the contract is not a verdict", () => {
    expect(isNormalizedIndex(index({ bundleDigestVerified: "probably" }))).toBe(false)
  })
})

describe("the recorded toolchain", () => {
  test("must be a whole identity, because a lazy read compares against it", () => {
    // A partly-shaped identity compares unequal and quietly disables
    // bundle-backed detail forever; a forged one would let a different Xcode
    // read a bundle it did not write.
    const { xcresulttoolDigest: _dropped, ...partial } = TOOLCHAIN
    expect(isNormalizedIndex(index({ toolchain: partial }))).toBe(false)
  })

  test("must not be merely an object", () => {
    expect(isNormalizedIndex(index({ toolchain: {} }))).toBe(false)
    expect(isNormalizedIndex(index({ toolchain: "Xcode 26" }))).toBe(false)
  })
})

describe("a retained location", () => {
  function withLocation(path: unknown): Record<string, unknown> {
    return index({
      testFailures: [
        {
          id: "diag-1",
          kind: "testFailure",
          message: "it failed",
          inspectionAvailable: true,
          location: { path },
        },
      ],
    })
  }

  test("is repository-relative, as the interpreter wrote it", () => {
    expect(isNormalizedIndex(withLocation("Sources/App/Login.swift"))).toBe(true)
  })

  test("is refused when it names somewhere on this machine", () => {
    // The read side, not the write side: this file is one a crash or anything
    // else on the machine may have touched, and an absolute path handed to a
    // model says where this machine keeps things.
    expect(isNormalizedIndex(withLocation("/Users/someone/Secret/Login.swift"))).toBe(false)
  })

  test("is refused when it walks out of the repository", () => {
    expect(isNormalizedIndex(withLocation("../../etc/passwd"))).toBe(false)
    expect(isNormalizedIndex(withLocation("Sources/../../../etc/passwd"))).toBe(false)
  })

  test("allows a traversal that stays inside", () => {
    expect(isNormalizedIndex(withLocation("Sources/App/../Login.swift"))).toBe(true)
  })

  test("is refused when it is not a path at all", () => {
    expect(isNormalizedIndex(withLocation(42))).toBe(false)
    expect(isNormalizedIndex(withLocation(""))).toBe(false)
  })
})

describe("nested collections", () => {
  test("a failure inside an occurrence is checked like anything else", () => {
    const occurrence = {
      id: "occ-1",
      identity: { canonical: "AppTests/T/test()" },
      status: "failed",
      position: "0",
      // A failure whose location escapes is still a location that would be
      // rendered, whatever it is nested inside.
      failures: [{ message: "x", position: "0", location: { path: "/etc/passwd" } }],
      attempts: [],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
  })

  test("an attempt with no usable status is not an attempt", () => {
    const occurrence = {
      id: "occ-1",
      identity: { canonical: "AppTests/T/test()" },
      status: "passed",
      position: "0",
      failures: [],
      attempts: [{ ordinal: 1, status: "maybe" }],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
  })

  test("an identity whose parts are not text is not an identity", () => {
    const occurrence = {
      id: "occ-1",
      identity: { canonical: "AppTests/T/test()", suite: 7 },
      status: "passed",
      position: "0",
      failures: [],
      attempts: [],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
  })

  test("a retained message that is not text is not a message", () => {
    expect(isNormalizedIndex(index({ fullMessages: { "diag-1": 42 } }))).toBe(false)
  })
})

describe("numbers that are not numbers", () => {
  // `typeof value === "number"` is true of all of these, and every one of them
  // reaches a caller — as a count, a duration, or a place to go and look.

  test("a count that is not a whole non-negative number is not a count", () => {
    expect(isNormalizedIndex(index({ requestedSelectionCount: -1 }))).toBe(false)
    expect(isNormalizedIndex(index({ requestedSelectionCount: 1.5 }))).toBe(false)
    expect(isNormalizedIndex(index({ observedOutsideScope: Number.NaN }))).toBe(false)
    expect(isNormalizedIndex(index({ observedOutsideScope: Number.POSITIVE_INFINITY }))).toBe(false)
  })

  test("counts that do not add up are not this tool's counts", () => {
    // `counts.failed` decides whether the run is reported as having failed
    // tests, so a set that disagrees with itself does not render oddly — it
    // changes what the tool says happened.
    const inconsistent = {
      completeness: "complete",
      counts: { total: 2, passed: 1, failed: 1, skipped: 0, expectedFailure: 0, unknown: 0 },
    }
    expect(isNormalizedIndex(index({ tests: inconsistent }))).toBe(true)

    const wrong = { ...inconsistent, counts: { ...inconsistent.counts, total: 9 } }
    expect(isNormalizedIndex(index({ tests: wrong }))).toBe(false)
  })

  test("a NaN count is refused, though it passes every threshold by failing it", () => {
    const counts = {
      completeness: "complete",
      counts: {
        total: Number.NaN,
        passed: 0,
        failed: 0,
        skipped: 0,
        expectedFailure: 0,
        unknown: 0,
      },
    }
    expect(isNormalizedIndex(index({ tests: counts }))).toBe(false)
  })

  test("a line number below one is not a line number", () => {
    const failure = {
      id: "diag-1",
      kind: "testFailure",
      message: "it failed",
      inspectionAvailable: true,
      location: { path: "Sources/App/Login.swift", line: 0 },
    }
    expect(isNormalizedIndex(index({ testFailures: [failure] }))).toBe(false)

    const negative = { ...failure, location: { path: "Sources/App/Login.swift", column: -4 } }
    expect(isNormalizedIndex(index({ testFailures: [negative] }))).toBe(false)
  })

  test("a duration that ran backwards is not a duration", () => {
    const occurrence = {
      id: "occ-1",
      identity: { canonical: "AppTests/T/test()" },
      status: "passed",
      position: "0",
      failures: [],
      attempts: [],
      durationMs: -1,
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
  })

  test("an attempt numbered from zero is not an attempt", () => {
    const occurrence = {
      id: "occ-1",
      identity: { canonical: "AppTests/T/test()" },
      status: "passed",
      position: "0",
      failures: [],
      attempts: [{ ordinal: 0, status: "passed" }],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
  })
})

describe("the selection an attestation is about", () => {
  test("is checked, because it is what a caller compares against their request", () => {
    // The verdict beside it reads as authoritative either way. A selection
    // naming no bundle, or a bundle that is a number, is how a zero-match run
    // gets reported as a run of something.
    expect(isNormalizedIndex(index({ attestations: [{ verdict: "matched", selection: {} }] }))).toBe(
      false,
    )
    expect(
      isNormalizedIndex(index({ attestations: [{ verdict: "matched", selection: { bundle: 7 } }] })),
    ).toBe(false)
    expect(
      isNormalizedIndex(
        index({ attestations: [{ verdict: "matched", selection: { bundle: "AppTests" } }] }),
      ),
    ).toBe(true)
  })

  test("carries a matched count that is a count", () => {
    const attestation = {
      verdict: "matched",
      selection: { bundle: "AppTests" },
      matchedTestCount: -3,
    }
    expect(isNormalizedIndex(index({ attestations: [attestation] }))).toBe(false)
  })
})
