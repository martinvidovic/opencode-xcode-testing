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
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      identityComplete: true,
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
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      identityComplete: true,
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
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      identityComplete: true,
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
      identity: { bundle: "AppTests", canonical: "AppTests/T/test()", suite: 7 },
      identityComplete: true,
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
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      identityComplete: true,
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
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      identityComplete: true,
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

describe("fields that decide what other evidence means", () => {
  test("an occurrence with no completeness flag is not an occurrence", () => {
    // `identityComplete` is read to decide whether identities can be matched
    // at all, so its absence does not degrade a display — it silently changes
    // what the scope verdicts say a run covered.
    const occurrence = {
      id: "occ-1",
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      status: "passed",
      position: "0",
      failures: [],
      attempts: [],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)
    expect(
      isNormalizedIndex(index({ occurrences: [{ ...occurrence, identityComplete: true }] })),
    ).toBe(true)
  })
})

describe("identifiers that address nothing", () => {
  test("an empty identifier is refused wherever one is required", () => {
    // `""` is a string, so a shape check passes it, and it then reaches a
    // caller as a handle for something — indistinguishable at the point of use
    // from one that was never there.
    expect(isNormalizedIndex(index({ runId: "" }))).toBe(false)
    expect(isNormalizedIndex(index({ scopeDigest: "" }))).toBe(false)

    const occurrence = {
      id: "",
      identity: { bundle: "AppTests", suite: "T", test: "test()", canonical: "AppTests/T/test()" },
      identityComplete: true,
      status: "passed",
      position: "0",
      failures: [],
      attempts: [],
    }
    expect(isNormalizedIndex(index({ occurrences: [occurrence] }))).toBe(false)

    const nameless = { ...occurrence, id: "occ-1", identity: { canonical: "" } }
    expect(isNormalizedIndex(index({ occurrences: [nameless] }))).toBe(false)
  })
})

describe("a retained test identity", () => {
  function withIdentity(identity: unknown, identityComplete = true): Record<string, unknown> {
    return index({
      occurrences: [
        { id: "occ-1", identity, identityComplete, status: "passed", position: "0", failures: [], attempts: [] },
      ],
    })
  }

  const WHOLE = {
    bundle: "AppTests",
    suite: "LoginTests",
    test: "testSignsIn()",
    canonical: "AppTests/LoginTests/testSignsIn()",
  }

  test("decodes when every part of it names something", () => {
    expect(isNormalizedIndex(withIdentity(WHOLE))).toBe(true)
  })

  test("claims completeness only with a bundle to be complete about", () => {
    // A complete identity is matched against what a caller asked to run. One
    // naming no bundle is compared against every selection and agrees with
    // none, which reports a mismatch for a test that ran.
    const { bundle: _dropped, ...bundleless } = WHOLE
    expect(isNormalizedIndex(withIdentity(bundleless))).toBe(false)
    expect(isNormalizedIndex(withIdentity({ ...WHOLE, bundle: "" }))).toBe(false)
  })

  test("still decodes without a bundle when it admits it is incomplete", () => {
    // This is what the interpreter writes when Xcode's ancestry gave it
    // nothing to work with, and attestation already refuses to match on it.
    // Refusing it here would reject an index this tool itself published.
    expect(isNormalizedIndex(withIdentity({ ...WHOLE, bundle: "" }, false))).toBe(true)
  })

  test("refuses a part that is present and blank", () => {
    // `""` is a name that matches nothing and looks like it should. Absent
    // says "Xcode did not tell us"; blank says "it is called nothing".
    expect(isNormalizedIndex(withIdentity({ ...WHOLE, suite: "" }))).toBe(false)
    expect(isNormalizedIndex(withIdentity({ ...WHOLE, test: "" }))).toBe(false)
    expect(isNormalizedIndex(withIdentity({ ...WHOLE, sourceIdentifier: "" }))).toBe(false)
  })

  test("refuses a source identifier that is not text", () => {
    // Retained so a reader can find the test in Xcode's own output, which
    // makes it an identifier and not a display string.
    expect(isNormalizedIndex(withIdentity({ ...WHOLE, sourceIdentifier: 7 }))).toBe(false)
    expect(
      isNormalizedIndex(withIdentity({ ...WHOLE, sourceIdentifier: "AppTests/LoginTests/testSignsIn" })),
    ).toBe(true)
  })

  test("refuses an occurrence whose position names nothing", () => {
    // The position is how a focused view addresses one occurrence among
    // several with the same name.
    expect(
      isNormalizedIndex(
        index({
          occurrences: [
            { id: "occ-1", identity: WHOLE, identityComplete: true, status: "passed", position: "", failures: [], attempts: [] },
          ],
        }),
      ),
    ).toBe(false)
  })
})
