#!/usr/bin/env bun
/**
 * The fixture-project generator (ADR 0001).
 *
 * The map forbids committing a sample Xcode project, and ADR 0001 answers that
 * by generating one instead: both container shapes from one template set, with
 * an embedded shared scheme, so the acceptance gate is reproducible from
 * committed artifacts alone and the repository stays generic.
 *
 * Everything here is deterministic — identifiers are derived from a counter
 * rather than randomly — so two runs produce byte-identical output and a diff
 * in a generated tree means something actually changed.
 *
 * Usage:
 *   bun scripts/generate-fixture-project.ts --out <directory> [--variant passing|buildFailed]
 *   bun scripts/generate-fixture-project.ts --project <path>   # locally owned, never committed
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export type Variant = "passing" | "buildFailed"

/** The names the generated tree uses. All generic, all hygiene-lint clean. */
export const FIXTURE = {
  projectName: "App",
  workspaceName: "Example",
  frameworkTarget: "App",
  testTarget: "AppTests",
  scheme: "App",
  passingSuite: "CalculatorTests",
  failingSuite: "DeliberateFailureTests",
  bundleIdentifier: "com.example.app",
  testBundleIdentifier: "com.example.tests",
} as const

export type GeneratedTree = {
  root: string
  projectPath: string
  workspacePath: string
  schemePath: string
  files: string[]
}

// --- deterministic object identifiers -------------------------------------

/**
 * A pbxproj identifier is 24 hex characters. Deriving them from a counter,
 * rather than randomly, is what makes the output reproducible.
 */
function identifiers(): (name: string) => string {
  const assigned = new Map<string, string>()
  return (name: string) => {
    const existing = assigned.get(name)
    if (existing !== undefined) return existing
    const id = (assigned.size + 1).toString(16).toUpperCase().padStart(24, "0")
    assigned.set(name, id)
    return id
  }
}

// --- sources ---------------------------------------------------------------

const CALCULATOR_SWIFT = `public struct Calculator {
    public init() {}

    public func add(_ lhs: Int, _ rhs: Int) -> Int {
        lhs + rhs
    }
}
`

const CALCULATOR_TESTS_SWIFT = `import XCTest
@testable import ${FIXTURE.frameworkTarget}

final class ${FIXTURE.passingSuite}: XCTestCase {
    func testAdds() {
        XCTAssertEqual(Calculator().add(2, 2), 4)
    }

    func testAddsZero() {
        XCTAssertEqual(Calculator().add(7, 0), 7)
    }
}
`

const FAILING_TESTS_SWIFT = `import XCTest
@testable import ${FIXTURE.frameworkTarget}

/// A deliberate failure, so the acceptance gate can exercise \`testFailed\`
/// without depending on a real defect existing somewhere.
final class ${FIXTURE.failingSuite}: XCTestCase {
    func testFailsDeliberately() {
        XCTAssertEqual(Calculator().add(2, 2), 5, "deliberate fixture failure")
    }
}
`

/** The `buildFailed` variant's deterministic compile error. */
export const DELIBERATE_COMPILE_ERROR = `// A deliberate compile error, so the acceptance gate can exercise
// \`buildFailed\` and \`notReached\` scope attestation end to end.
public let deliberatelyBroken: Int = "this is not an integer"
`

// --- generation ------------------------------------------------------------

export function generate(options: { out: string; variant?: Variant }): GeneratedTree {
  const root = resolve(options.out)
  const variant: Variant = options.variant ?? "passing"

  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  const sources = [
    { path: `Sources/${FIXTURE.frameworkTarget}/Calculator.swift`, contents: CALCULATOR_SWIFT },
    ...(variant === "buildFailed"
      ? [
          {
            path: `Sources/${FIXTURE.frameworkTarget}/BuildError.swift`,
            contents: DELIBERATE_COMPILE_ERROR,
          },
        ]
      : []),
  ]

  const tests = [
    { path: `Tests/${FIXTURE.testTarget}/CalculatorTests.swift`, contents: CALCULATOR_TESTS_SWIFT },
    { path: `Tests/${FIXTURE.testTarget}/FailingTests.swift`, contents: FAILING_TESTS_SWIFT },
  ]

  const written: string[] = []
  const write = (path: string, contents: string) => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents)
    written.push(path)
  }

  for (const source of [...sources, ...tests]) write(source.path, source.contents)

  const projectPath = `${FIXTURE.projectName}.xcodeproj`
  write(
    `${projectPath}/project.pbxproj`,
    projectFile({ sources: sources.map((s) => s.path), tests: tests.map((t) => t.path) }),
  )

  // The scheme is shared — `xcshareddata`, not `xcuserdata` — because only a
  // checked-in shared scheme is discoverable (#6).
  const schemePath = `${projectPath}/xcshareddata/xcschemes/${FIXTURE.scheme}.xcscheme`
  write(schemePath, schemeFile())

  // One template set, two container shapes: the workspace simply wraps the
  // project, so discovery's "workspace outranks project" branch is reachable.
  const workspacePath = `${FIXTURE.workspaceName}.xcworkspace`
  write(`${workspacePath}/contents.xcworkspacedata`, workspaceFile(projectPath))

  return {
    root,
    projectPath: join(root, projectPath),
    workspacePath: join(root, workspacePath),
    schemePath: join(root, schemePath),
    files: written.sort(),
  }
}

function workspaceFile(projectPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version = "1.0">
   <FileRef location = "group:${projectPath}">
   </FileRef>
</Workspace>
`
}

function schemeFile(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "2600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${identifierFor(FIXTURE.frameworkTarget)}"
               BuildableName = "${FIXTURE.frameworkTarget}.framework"
               BlueprintName = "${FIXTURE.frameworkTarget}"
               ReferencedContainer = "container:${FIXTURE.projectName}.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${identifierFor(FIXTURE.testTarget)}"
               BuildableName = "${FIXTURE.testTarget}.xctest"
               BlueprintName = "${FIXTURE.testTarget}"
               ReferencedContainer = "container:${FIXTURE.projectName}.xcodeproj">
            </BuildableReference>
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug"></LaunchAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release"></ArchiveAction>
</Scheme>
`
}

/**
 * Identifiers are shared between the scheme and the project file, so the
 * scheme's blueprint references resolve. One assignment order, one result.
 */
const NAMES = [
  "project",
  "frameworkLink",
  "mainGroup",
  "productsGroup",
  "sourcesGroup",
  "testsGroup",
  FIXTURE.frameworkTarget,
  FIXTURE.testTarget,
  "frameworkProduct",
  "testProduct",
  "frameworkSources",
  "testSources",
  "frameworkFrameworks",
  "testFrameworks",
  "projectConfigurationList",
  "frameworkConfigurationList",
  "testConfigurationList",
  "projectDebug",
  "projectRelease",
  "frameworkDebug",
  "frameworkRelease",
  "testDebug",
  "testRelease",
  "testDependency",
  "testDependencyProxy",
]

const assign = identifiers()
for (const name of NAMES) assign(name)

export function identifierFor(name: string): string {
  return assign(name)
}

function projectFile(input: { sources: string[]; tests: string[] }): string {
  const fileReference = (path: string) => assign(`ref:${path}`)
  const buildFile = (path: string) => assign(`build:${path}`)

  const allFiles = [...input.sources, ...input.tests]
  for (const path of allFiles) {
    fileReference(path)
    buildFile(path)
  }

  const basename = (path: string) => path.split("/").pop() ?? path

  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
		${assign("frameworkLink")} /* ${FIXTURE.frameworkTarget}.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${assign("frameworkProduct")} /* ${FIXTURE.frameworkTarget}.framework */; };
${allFiles
  .map(
    (path) =>
      `		${buildFile(path)} /* ${basename(path)} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileReference(path)} /* ${basename(path)} */; };`,
  )
  .join("\n")}
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		${assign("frameworkProduct")} /* ${FIXTURE.frameworkTarget}.framework */ = {isa = PBXFileReference; explicitFileType = wrapper.framework; includeInIndex = 0; path = ${FIXTURE.frameworkTarget}.framework; sourceTree = BUILT_PRODUCTS_DIR; };
		${assign("testProduct")} /* ${FIXTURE.testTarget}.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = ${FIXTURE.testTarget}.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
${allFiles
  .map(
    (path) =>
      `		${fileReference(path)} /* ${basename(path)} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${basename(path)}; sourceTree = "<group>"; };`,
  )
  .join("\n")}
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		${assign("frameworkFrameworks")} = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		${assign("testFrameworks")} = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (${assign("frameworkLink")} /* ${FIXTURE.frameworkTarget}.framework in Frameworks */,); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		${assign("mainGroup")} = {
			isa = PBXGroup;
			children = (
				${assign("sourcesGroup")} /* Sources */,
				${assign("testsGroup")} /* Tests */,
				${assign("productsGroup")} /* Products */,
			);
			sourceTree = "<group>";
		};
		${assign("sourcesGroup")} /* Sources */ = {
			isa = PBXGroup;
			children = (
${input.sources.map((path) => `				${fileReference(path)} /* ${basename(path)} */,`).join("\n")}
			);
			path = Sources/${FIXTURE.frameworkTarget};
			sourceTree = "<group>";
		};
		${assign("testsGroup")} /* Tests */ = {
			isa = PBXGroup;
			children = (
${input.tests.map((path) => `				${fileReference(path)} /* ${basename(path)} */,`).join("\n")}
			);
			path = Tests/${FIXTURE.testTarget};
			sourceTree = "<group>";
		};
		${assign("productsGroup")} /* Products */ = {
			isa = PBXGroup;
			children = (
				${assign("frameworkProduct")} /* ${FIXTURE.frameworkTarget}.framework */,
				${assign("testProduct")} /* ${FIXTURE.testTarget}.xctest */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		${assign(FIXTURE.frameworkTarget)} /* ${FIXTURE.frameworkTarget} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${assign("frameworkConfigurationList")};
			buildPhases = (
				${assign("frameworkSources")},
				${assign("frameworkFrameworks")},
			);
			buildRules = ();
			dependencies = ();
			name = ${FIXTURE.frameworkTarget};
			productName = ${FIXTURE.frameworkTarget};
			productReference = ${assign("frameworkProduct")};
			productType = "com.apple.product-type.framework";
		};
		${assign(FIXTURE.testTarget)} /* ${FIXTURE.testTarget} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = ${assign("testConfigurationList")};
			buildPhases = (
				${assign("testSources")},
				${assign("testFrameworks")},
			);
			buildRules = ();
			dependencies = (
				${assign("testDependency")},
			);
			name = ${FIXTURE.testTarget};
			productName = ${FIXTURE.testTarget};
			productReference = ${assign("testProduct")};
			productType = "com.apple.product-type.bundle.unit-test";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		${assign("project")} /* Project object */ = {
			isa = PBXProject;
			attributes = {
				BuildIndependentTargetsInParallel = 1;
				LastUpgradeCheck = 2600;
			};
			buildConfigurationList = ${assign("projectConfigurationList")};
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (en, Base);
			mainGroup = ${assign("mainGroup")};
			productRefGroup = ${assign("productsGroup")};
			projectDirPath = "";
			projectRoot = "";
			targets = (
				${assign(FIXTURE.frameworkTarget)} /* ${FIXTURE.frameworkTarget} */,
				${assign(FIXTURE.testTarget)} /* ${FIXTURE.testTarget} */,
			);
		};
/* End PBXProject section */

/* Begin PBXSourcesBuildPhase section */
		${assign("frameworkSources")} = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
${input.sources.map((path) => `				${buildFile(path)} /* ${basename(path)} in Sources */,`).join("\n")}
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
		${assign("testSources")} = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
${input.tests.map((path) => `				${buildFile(path)} /* ${basename(path)} in Sources */,`).join("\n")}
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
		${assign("testDependency")} = {
			isa = PBXTargetDependency;
			target = ${assign(FIXTURE.frameworkTarget)} /* ${FIXTURE.frameworkTarget} */;
			targetProxy = ${assign("testDependencyProxy")};
		};
/* End PBXTargetDependency section */

/* Begin PBXContainerItemProxy section */
		${assign("testDependencyProxy")} = {
			isa = PBXContainerItemProxy;
			containerPortal = ${assign("project")} /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = ${assign(FIXTURE.frameworkTarget)};
			remoteInfo = ${FIXTURE.frameworkTarget};
		};
/* End PBXContainerItemProxy section */

/* Begin XCBuildConfiguration section */
		${assign("projectDebug")} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				ONLY_ACTIVE_ARCH = YES;
				SDKROOT = iphoneos;
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
				SWIFT_VERSION = 5.0;
			};
			name = Debug;
		};
		${assign("projectRelease")} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ALWAYS_SEARCH_USER_PATHS = NO;
				CLANG_ENABLE_MODULES = YES;
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				SDKROOT = iphoneos;
				SWIFT_VERSION = 5.0;
			};
			name = Release;
		};
		${assign("frameworkDebug")} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEFINES_MODULE = YES;
				ENABLE_TESTABILITY = YES;
				GENERATE_INFOPLIST_FILE = YES;
				PRODUCT_BUNDLE_IDENTIFIER = ${FIXTURE.bundleIdentifier};
				PRODUCT_NAME = "$(TARGET_NAME:c99extidentifier)";
				SKIP_INSTALL = YES;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		${assign("frameworkRelease")} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				DEFINES_MODULE = YES;
				ENABLE_TESTABILITY = YES;
				GENERATE_INFOPLIST_FILE = YES;
				PRODUCT_BUNDLE_IDENTIFIER = ${FIXTURE.bundleIdentifier};
				PRODUCT_NAME = "$(TARGET_NAME:c99extidentifier)";
				SKIP_INSTALL = YES;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
		${assign("testDebug")} /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ENABLE_TESTABILITY = YES;
				GENERATE_INFOPLIST_FILE = YES;
				LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks");
				PRODUCT_BUNDLE_IDENTIFIER = ${FIXTURE.testBundleIdentifier};
				PRODUCT_NAME = "$(TARGET_NAME)";
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		${assign("testRelease")} /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ENABLE_TESTABILITY = YES;
				GENERATE_INFOPLIST_FILE = YES;
				LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks", "@loader_path/Frameworks");
				PRODUCT_BUNDLE_IDENTIFIER = ${FIXTURE.testBundleIdentifier};
				PRODUCT_NAME = "$(TARGET_NAME)";
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		${assign("projectConfigurationList")} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${assign("projectDebug")} /* Debug */,
				${assign("projectRelease")} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Debug;
		};
		${assign("frameworkConfigurationList")} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${assign("frameworkDebug")} /* Debug */,
				${assign("frameworkRelease")} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Debug;
		};
		${assign("testConfigurationList")} = {
			isa = XCConfigurationList;
			buildConfigurations = (
				${assign("testDebug")} /* Debug */,
				${assign("testRelease")} /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Debug;
		};
/* End XCConfigurationList section */
	};
	rootObject = ${assign("project")} /* Project object */;
}
`
}

// --- command line ----------------------------------------------------------

export function parseArguments(argv: string[]): {
  out?: string
  variant: Variant
  project?: string
} {
  const value = (name: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
    if (inline !== undefined) return inline.split("=").slice(1).join("=")
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }

  const variant = value("variant")
  return {
    ...(value("out") === undefined ? {} : { out: value("out") as string }),
    variant: variant === "buildFailed" ? "buildFailed" : "passing",
    // A locally owned, uncommitted real project. Runs against it must pass if
    // invoked, but they never form the standing gate — the gate depends only on
    // artifacts this script can reproduce.
    ...(value("project") === undefined ? {} : { project: value("project") as string }),
  }
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2))

  if (options.project !== undefined) {
    process.stdout.write(`${resolve(options.project)}\n`)
  } else if (options.out === undefined) {
    process.stderr.write("usage: generate-fixture-project.ts --out <directory> [--variant …]\n")
    process.exitCode = 64
  } else {
    const tree = generate({ out: options.out, variant: options.variant })
    process.stdout.write(`${JSON.stringify({ ...tree, variant: options.variant }, null, 2)}\n`)
  }
}
