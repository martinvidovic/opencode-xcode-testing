/**
 * Locations shown to a model (#7, issue #24).
 *
 * A location is the one place a diagnostic names a file, so it is the one
 * place a path can reach a model at all. Two properties hold here and nowhere
 * else: a path inside the repository is shown relative to it, and every other
 * path — including one that merely starts like an inside path — is reduced to
 * a display name that says nothing about the machine the tests ran on.
 */

import { describe, expect, test } from "bun:test"

import { compareLocations, safeDisplayPath, safeLocationFromSourceURL } from "../../src/interpreter/locations.ts"

const ROOT = "/workspace/example"

describe("a displayed path", () => {
  test("is relative to the repository when it is inside it", () => {
    expect(safeDisplayPath(`${ROOT}/Sources/App/Login.swift`, ROOT)).toBe("Sources/App/Login.swift")
  })

  test("remains relative to containment when it is outside the configuration scope", () => {
    const configurationRoot = `${ROOT}/Modules/App`
    const source = `${ROOT}/Shared/Login.swift`

    expect(safeDisplayPath(source, ROOT)).toBe("Shared/Login.swift")
    expect(safeDisplayPath(source, configurationRoot)).toBe("Login.swift")
  })

  test("is a display name alone when it is outside the repository", () => {
    // An absolute path outside the repository tells a model nothing it can act
    // on, and leaks the shape of the machine.
    expect(safeDisplayPath("/Users/someone/Secret/Other.swift", ROOT)).toBe("Other.swift")
  })

  test("never walks out of the repository it claims to be inside", () => {
    // Starting with the root is not the same as being inside it. Stripping the
    // prefix off this would produce a "repository-relative" path that leaves
    // the repository on the first component.
    for (const path of [
      `${ROOT}/../../etc/passwd`,
      `${ROOT}/Sources/../../../etc/passwd`,
      `${ROOT}/..`,
    ]) {
      const displayed = safeDisplayPath(path, ROOT)
      // Not even as a "display name": a traversal marker shown as though it
      // were a filename is the same leak wearing a different hat.
      expect(displayed).not.toContain("..")
      expect(displayed).not.toContain("/")
    }
  })

  test("allows a traversal that stays within the repository", () => {
    // `Sources/App/../Login.swift` names a file inside the repository, and
    // refusing it would hide a real location for no gain.
    expect(safeDisplayPath(`${ROOT}/Sources/App/../Login.swift`, ROOT)).toBe(
      "Sources/App/../Login.swift",
    )
  })

  test("treats a root given with a trailing slash the same way", () => {
    expect(safeDisplayPath(`${ROOT}/Sources/App.swift`, `${ROOT}/`)).toBe("Sources/App.swift")
  })
})

describe("a source reference", () => {
  test("yields a safe location with its line and column", () => {
    const location = safeLocationFromSourceURL(
      `file://${ROOT}/Sources/App/Login.swift#StartingLineNumber=42&StartingColumnNumber=9`,
      ROOT,
    )
    expect(location).toEqual({ path: "Sources/App/Login.swift", line: 42, column: 9 })
  })

  test("is reduced to a display name when it points outside the repository", () => {
    const location = safeLocationFromSourceURL(
      "file:///Users/someone/Library/Frameworks/XCTest.swift#StartingLineNumber=7",
      ROOT,
    )
    expect(location).toEqual({ path: "XCTest.swift", line: 7 })
  })

  test("carries no line when the fragment does not give a usable one", () => {
    const location = safeLocationFromSourceURL(
      `file://${ROOT}/App.swift#StartingLineNumber=0`,
      ROOT,
    )
    // Xcode lines are 1-based, so zero is not a line — reporting it as one
    // would send a reader to a place that does not exist.
    expect(location).toEqual({ path: "App.swift" })
  })

  test("is nothing at all when there is nothing trustworthy to report", () => {
    expect(safeLocationFromSourceURL(undefined, ROOT)).toBeUndefined()
    expect(safeLocationFromSourceURL("file://", ROOT)).toBeUndefined()
  })
})

describe("location ordering", () => {
  test("is total and deterministic across path, line and column", () => {
    // Wrapped, because `Array.prototype.sort` moves `undefined` to the end
    // without consulting the comparator at all — sorting bare values would
    // test the engine rather than the ordering.
    const unsorted = [
      { at: { path: "b.swift", line: 1 } },
      { at: { path: "a.swift", line: 2, column: 1 } },
      { at: undefined },
      { at: { path: "a.swift", line: 2 } },
      { at: { path: "a.swift", line: 1 } },
    ]
    const order = (entries: typeof unsorted) =>
      [...entries].sort((a, b) => compareLocations(a.at, b.at)).map((entry) => entry.at)

    expect(order(unsorted)).toEqual([
      undefined,
      { path: "a.swift", line: 1 },
      { path: "a.swift", line: 2 },
      { path: "a.swift", line: 2, column: 1 },
      { path: "b.swift", line: 1 },
    ])
    // A different arrangement of the same records must sort identically, or
    // paging order would depend on the order records happened to arrive.
    expect(order([...unsorted].reverse())).toEqual(order(unsorted))
  })
})
