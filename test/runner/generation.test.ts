/**
 * The generation script and the freshness check (ADR 0001, Layers 3 and 4's
 * scaffolding).
 *
 * These assert what the ticket's gate actually asks for: both container shapes,
 * the `buildFailed` variant, and reproducibility from committed artifacts
 * alone. Whether `xcodebuild` can build the result belongs to the acceptance
 * gate, which runs on a machine with Xcode; a unit suite must not require one.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { discoverContainer, discoverScheme, scan } from "../../src/runner/discovery.ts"
import {
  DELIBERATE_COMPILE_ERROR,
  FIXTURE,
  generate,
  parseArguments,
} from "../../scripts/generate-fixture-project.ts"
import { compare, readFixtureProvenance, observeToolchain, render } from "../../scripts/freshness-check.ts"

function withOutput<T>(work: (out: string) => T): T {
  const out = join(mkdtempSync(join(tmpdir(), "xcode-test-generate-")), "fixture")
  try {
    return work(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

describe("the generated tree", () => {
  test("emits both container shapes from one template set", () => {
    withOutput((out) => {
      const tree = generate({ out })
      expect(existsSync(join(tree.projectPath, "project.pbxproj"))).toBe(true)
      expect(existsSync(join(tree.workspacePath, "contents.xcworkspacedata"))).toBe(true)
    })
  })

  test("embeds a shared scheme, which is the only kind discovery can find", () => {
    withOutput((out) => {
      const tree = generate({ out })
      expect(tree.schemePath).toContain("xcshareddata/xcschemes")
      expect(readFileSync(tree.schemePath, "utf8")).toContain("<TestAction")
    })
  })

  test("is discoverable by the runner's own discovery, workspace first", () => {
    withOutput((out) => {
      const tree = generate({ out })
      const container = discoverContainer(tree.root)
      expect(container).toEqual({
        status: "found",
        value: { kind: "workspace", path: `${FIXTURE.workspaceName}.xcworkspace` },
      })

      if (container.status !== "found") return
      expect(discoverScheme(tree.root, container.value)).toEqual({
        status: "found",
        value: FIXTURE.scheme,
      })
    })
  })

  test("carries a passing suite and a deliberately failing one, separately selectable", () => {
    withOutput((out) => {
      const tree = generate({ out })
      const tests = readFileSync(join(tree.root, `Tests/${FIXTURE.testTarget}/CalculatorTests.swift`), "utf8")
      const failing = readFileSync(join(tree.root, `Tests/${FIXTURE.testTarget}/FailingTests.swift`), "utf8")

      expect(tests).toContain(`class ${FIXTURE.passingSuite}`)
      expect(failing).toContain(`class ${FIXTURE.failingSuite}`)
    })
  })

  test("wires the test target's blueprint to the identifier the project declares", () => {
    withOutput((out) => {
      const tree = generate({ out })
      const scheme = readFileSync(tree.schemePath, "utf8")
      const project = readFileSync(join(tree.projectPath, "project.pbxproj"), "utf8")

      const blueprint = /BlueprintIdentifier = "([0-9A-F]{24})"\s*\n\s*BuildableName = "AppTests\.xctest"/.exec(scheme)
      expect(blueprint?.[1]).toBeDefined()
      expect(project).toContain(`${blueprint?.[1]} /* ${FIXTURE.testTarget} */`)
    })
  })
})

describe("the buildFailed variant", () => {
  test("carries a deterministic compile error", () => {
    withOutput((out) => {
      const tree = generate({ out, variant: "buildFailed" })
      const source = join(tree.root, `Sources/${FIXTURE.frameworkTarget}/BuildError.swift`)
      expect(readFileSync(source, "utf8")).toBe(DELIBERATE_COMPILE_ERROR)
      expect(DELIBERATE_COMPILE_ERROR).toContain("not an integer")
    })
  })

  test("compiles that file into the framework target, so the build genuinely fails", () => {
    withOutput((out) => {
      const tree = generate({ out, variant: "buildFailed" })
      expect(readFileSync(join(tree.projectPath, "project.pbxproj"), "utf8")).toContain(
        "BuildError.swift in Sources",
      )
    })
  })

  test("is absent from the passing variant", () => {
    withOutput((out) => {
      const tree = generate({ out })
      expect(existsSync(join(tree.root, `Sources/${FIXTURE.frameworkTarget}/BuildError.swift`))).toBe(false)
    })
  })
})

describe("reproducibility", () => {
  test("produces byte-identical output across runs", () => {
    withOutput((first) => {
      withOutput((second) => {
        const a = generate({ out: first })
        const b = generate({ out: second })
        expect(a.files).toEqual(b.files)

        for (const file of a.files) {
          expect(readFileSync(join(a.root, file), "utf8")).toBe(readFileSync(join(b.root, file), "utf8"))
        }
      })
    })
  })

  test("regenerates cleanly over an existing tree", () => {
    withOutput((out) => {
      generate({ out, variant: "buildFailed" })
      const tree = generate({ out, variant: "passing" })
      // The previous variant's deliberate error must not survive.
      expect(existsSync(join(tree.root, `Sources/${FIXTURE.frameworkTarget}/BuildError.swift`))).toBe(false)
    })
  })

  test("emits exactly the files the gate depends on", () => {
    withOutput((out) => {
      expect(generate({ out }).files).toEqual([
        `${FIXTURE.projectName}.xcodeproj/project.pbxproj`,
        `${FIXTURE.projectName}.xcodeproj/xcshareddata/xcschemes/${FIXTURE.scheme}.xcscheme`,
        `${FIXTURE.workspaceName}.xcworkspace/contents.xcworkspacedata`,
        `Sources/${FIXTURE.frameworkTarget}/Calculator.swift`,
        `Tests/${FIXTURE.testTarget}/CalculatorTests.swift`,
        `Tests/${FIXTURE.testTarget}/FailingTests.swift`,
      ])
    })
  })
})

describe("the --project override", () => {
  test("is parsed, and is never what the standing gate runs against", () => {
    expect(parseArguments(["--project", "/somewhere/local"])).toMatchObject({
      project: "/somewhere/local",
    })
    expect(parseArguments(["--out", "x"]).project).toBeUndefined()
  })

  test("defaults the variant to passing", () => {
    expect(parseArguments(["--out", "x"]).variant).toBe("passing")
    expect(parseArguments(["--out", "x", "--variant=buildFailed"]).variant).toBe("buildFailed")
  })
})

describe("the freshness check", () => {
  test("reads the structured provenance every Layer 1 fixture carries", () => {
    const provenance = readFixtureProvenance(join(import.meta.dir, "..", "fixtures", "xcresult"))
    expect(Object.keys(provenance).length).toBeGreaterThan(0)
    expect(provenance["passed"]).toMatchObject({ schemaVersion: "0.1.0", xcodeVersion: "26.4.1" })
  })

  test("reports fresh when the observed toolchain matches", () => {
    const report = compare(
      { xcodeVersion: "26.1", xcodeBuild: "17E202", xcresulttoolVersion: "24757", schemaVersion: "0.1.0" },
      { passed: { xcodeVersion: "26.4.1", xcodeBuild: "17E202", xcresulttoolVersion: "24757", schemaVersion: "0.1.0" } },
    )
    // A point release is not drift: the decoders claim a major, not a point.
    expect(report.status).toBe("fresh")
  })

  test("maps drift onto exactly the fixtures it affects", () => {
    const report = compare(
      { xcresulttoolVersion: "30000", schemaVersion: "0.2.0" },
      {
        passed: { xcresulttoolVersion: "24757", schemaVersion: "0.1.0" },
        "test-failed": { xcresulttoolVersion: "24757", schemaVersion: "0.1.0" },
      },
    )

    expect(report.status).toBe("drifted")
    expect(report.drift).toEqual([
      {
        fact: "schemaVersion",
        expected: "0.1.0",
        observed: "0.2.0",
        affectedFixtures: ["passed", "test-failed"],
      },
      {
        fact: "xcresulttoolVersion",
        expected: "24757",
        observed: "30000",
        affectedFixtures: ["passed", "test-failed"],
      },
    ])
  })

  test("reports a major-version change as drift", () => {
    const report = compare({ xcodeVersion: "27.0" }, { passed: { xcodeVersion: "26.4.1" } })
    expect(report.drift.map((entry) => entry.fact)).toEqual(["xcodeVersion"])
  })

  test("says so plainly when no toolchain can be observed", () => {
    const report = compare({ unavailable: "xcodebuild is not available on this machine" }, {})
    expect(report.status).toBe("unavailable")
    expect(render(report)).toContain("unavailable")
  })

  test("never fails the suite over drift — it only reports", () => {
    // Running it for real is deliberately not an assertion about this machine:
    // whether Xcode is installed is not this suite's business.
    const observed = observeToolchain(() => ({ status: 1, stdout: "" }))
    expect(observed.unavailable).toBeDefined()
    expect(render(compare(observed, {}))).toContain("freshness:")
  })
})
