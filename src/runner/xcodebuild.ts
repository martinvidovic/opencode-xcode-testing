/**
 * The fixed `xcodebuild test` invocation (#6).
 *
 * Every argument is generated here from the resolved contract. The Test Tool
 * exposes no executable, command, argument array, environment override, working
 * directory or shell fragment — the safety guarantee is not that the repository
 * is untrusted (project build phases do run), but that model-controlled input
 * cannot select arbitrary shell execution.
 */

import type { Destination, ResolvedTestRun } from "../domain/request.ts"
import { normalizeRequestedScope, type RequestedScope } from "../domain/scope.ts"

/** A stable shim; toolchain identity is established by `DEVELOPER_DIR` (#8). */
export const XCODEBUILD = "/usr/bin/xcodebuild"

export type InvocationPaths = {
  /** Absolute path to the container. The runner derived it; nobody named it. */
  containerAbsolutePath: string
  /** Must not exist before the invocation — Xcode owns bundle creation. */
  resultBundlePath: string
  derivedDataPath: string
}

/** The complete argument list, in a fixed order so it is trivially reviewable. */
export function buildArguments(
  resolved: ResolvedTestRun,
  scope: RequestedScope,
  paths: InvocationPaths,
): string[] {
  const containerFlag = resolved.xcodeContainer.value.kind === "workspace" ? "-workspace" : "-project"

  return [
    "test",
    containerFlag,
    paths.containerAbsolutePath,
    "-scheme",
    resolved.scheme.value,
    "-destination",
    formatDestination(resolved.destination.value),
    "-resultBundlePath",
    paths.resultBundlePath,
    "-derivedDataPath",
    paths.derivedDataPath,
    ...onlyTestingArguments(scope),
  ]
}

/** Selections are exact, deduplicated, and deterministically ordered. */
export function onlyTestingArguments(scope: RequestedScope): string[] {
  const normalized = normalizeRequestedScope(scope)
  if (normalized.kind === "all") return []
  return normalized.tests.map(
    (selection) =>
      `-only-testing:${[selection.bundle, selection.suite, selection.test]
        .filter((part) => part !== undefined)
        .join("/")}`,
  )
}

export function formatDestination(destination: Destination): string {
  if (destination.kind === "id") return `id=${destination.id}`
  return [
    `platform=${destination.platform}`,
    `name=${destination.name}`,
    ...(destination.os === undefined ? [] : [`OS=${destination.os}`]),
  ].join(",")
}

/**
 * The environment the child runs with. `DEVELOPER_DIR` is set explicitly so
 * that interpretation reads the bundle back with the same toolchain that wrote
 * it, rather than whatever `xcode-select` happens to point at later.
 */
export function buildEnvironment(
  base: Record<string, string | undefined>,
  developerDirectory: string,
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) environment[key] = value
  }
  environment["DEVELOPER_DIR"] = developerDirectory
  return environment
}
