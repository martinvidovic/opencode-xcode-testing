/**
 * Request validation and settings resolution (#6).
 *
 * Two properties matter here more than any individual rule.
 *
 * **Every independently detectable error is reported at once.** A caller — or a
 * model — fixing one field at a time across five round trips is a worse
 * experience than one rejection listing all five.
 *
 * **The trusted root is never influenced by an argument.** Container paths are
 * validated as repository-relative, traversal and symlink escape are rejected,
 * and the runner is handed a canonical absolute path it derived itself.
 */

import { realpathSync } from "node:fs"
import { isAbsolute, join, normalize, relative } from "node:path"

import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  REQUEST_ERROR_CAP,
} from "../domain/limits.ts"
import type {
  Destination,
  ProjectConfiguration,
  ResolvedTestRun,
  TestRunRequest,
  XcodeContainer,
} from "../domain/request.ts"
import type { CappedSection, RequestError, RequestRejected } from "../domain/result.ts"
import { SCHEMA_VERSION } from "../domain/result.ts"
import type { RequestedScope } from "../domain/scope.ts"
import { discoverContainer, discoverScheme, type DiscoveryOutcome } from "./discovery.ts"

export type ResolutionOutcome =
  | { status: "resolved"; resolved: ResolvedTestRun; containerAbsolutePath: string }
  | { status: "rejected"; result: RequestRejected }

export type ResolutionEnvironment = {
  /** Canonical, adapter-supplied, and never derived from an argument. */
  trustedRoot: string
  configuration?: ProjectConfiguration
  discover?: {
    container(trustedRoot: string): DiscoveryOutcome<XcodeContainer>
    scheme(trustedRoot: string, container: XcodeContainer): DiscoveryOutcome<string>
  }
}

export function resolveTestRun(
  request: TestRunRequest,
  environment: ResolutionEnvironment,
): ResolutionOutcome {
  const errors: RequestError[] = []
  const discover = environment.discover ?? {
    container: discoverContainer,
    scheme: discoverScheme,
  }

  validateScope(request.requestedScope, errors)

  const container = resolveContainer(request, environment, discover, errors)
  const scheme =
    container === undefined
      ? undefined
      : resolveScheme(request, environment, discover, container.value, errors)
  const destination = resolveDestination(request, environment, errors)
  const timeoutSeconds = resolveTimeout(request, environment, errors)

  if (errors.length > 0 || container === undefined || scheme === undefined || destination === undefined) {
    return { status: "rejected", result: reject(errors) }
  }

  const derivedDataMode = environment.configuration?.derivedData?.mode
  return {
    status: "resolved",
    containerAbsolutePath: join(environment.trustedRoot, container.value.path),
    resolved: {
      xcodeContainer: container,
      scheme,
      destination,
      derivedData:
        derivedDataMode === undefined
          ? { value: { mode: "shared" }, provenance: "default" }
          : { value: { mode: derivedDataMode }, provenance: "configuration" },
      timeoutSeconds,
    },
  }
}

// --- Requested Scope ------------------------------------------------------

function validateScope(scope: RequestedScope, errors: RequestError[]): void {
  if (scope.kind === "all") return

  if (scope.tests.length === 0) {
    push(errors, "requestedScope.tests", "empty", "a selected scope must name at least one test")
    return
  }

  scope.tests.forEach((selection, index) => {
    const at = `requestedScope.tests[${index}]`
    validateComponent(selection.bundle, `${at}.bundle`, errors)
    if (selection.suite !== undefined) validateComponent(selection.suite, `${at}.suite`, errors)
    if (selection.test !== undefined) {
      validateComponent(selection.test, `${at}.test`, errors)
      if (selection.suite === undefined) {
        push(errors, `${at}.test`, "suiteRequired", "a test selection requires its suite")
      }
    }
  })
}

/** Scope components reject `/`, which is the separator canonical identity uses. */
function validateComponent(value: string, field: string, errors: RequestError[]): void {
  if (!validateString(value, field, errors)) return
  if (value.includes("/")) {
    push(errors, field, "illegalCharacter", "a scope component may not contain '/'")
  }
}

// --- container ------------------------------------------------------------

function resolveContainer(
  request: TestRunRequest,
  environment: ResolutionEnvironment,
  discover: NonNullable<ResolutionEnvironment["discover"]>,
  errors: RequestError[],
): ResolvedTestRun["xcodeContainer"] | undefined {
  const requested = request.xcodeContainer ?? environment.configuration?.xcodeContainer
  const provenance = request.xcodeContainer !== undefined ? "request" : "configuration"

  if (requested !== undefined) {
    const validated = validateContainerPath(requested, environment.trustedRoot, errors)
    return validated === undefined ? undefined : { value: validated, provenance }
  }

  const found = discover.container(environment.trustedRoot)
  if (found.status === "found") return { value: found.value, provenance: "discovery" }
  if (found.status === "ambiguous") {
    push(
      errors,
      "xcodeContainer",
      "ambiguous",
      "more than one Xcode container was discovered; name one explicitly",
      found.candidates,
    )
    return undefined
  }
  push(errors, "xcodeContainer", "notFound", "no Xcode container was discovered")
  return undefined
}

/**
 * A container path must stay inside the trusted root both lexically and after
 * the filesystem resolves it — the second check is what catches a symlink that
 * points out of the repository.
 */
export function validateContainerPath(
  container: XcodeContainer,
  trustedRoot: string,
  errors: RequestError[],
): XcodeContainer | undefined {
  const field = "xcodeContainer.path"
  if (!validateString(container.path, field, errors)) return undefined

  if (isAbsolute(container.path)) {
    push(errors, field, "notRelative", "a container path must be repository-relative")
    return undefined
  }

  const normalized = normalize(container.path)
  if (normalized.startsWith("..")) {
    push(errors, field, "traversal", "a container path may not leave the repository")
    return undefined
  }

  const extension = container.kind === "workspace" ? ".xcworkspace" : ".xcodeproj"
  if (!normalized.endsWith(extension)) {
    push(errors, field, "extensionMismatch", `a ${container.kind} path must end in ${extension}`)
    return undefined
  }

  let canonical: string
  try {
    canonical = realpathSync(join(trustedRoot, normalized))
  } catch {
    push(errors, field, "notFound", "the named Xcode container does not exist")
    return undefined
  }

  const escape = relative(realpathSync(trustedRoot), canonical)
  if (escape.startsWith("..") || isAbsolute(escape)) {
    push(errors, field, "symlinkEscape", "a container path may not resolve outside the repository")
    return undefined
  }

  return { kind: container.kind, path: normalized }
}

// --- scheme ---------------------------------------------------------------

function resolveScheme(
  request: TestRunRequest,
  environment: ResolutionEnvironment,
  discover: NonNullable<ResolutionEnvironment["discover"]>,
  container: XcodeContainer,
  errors: RequestError[],
): ResolvedTestRun["scheme"] | undefined {
  const requested = request.scheme ?? environment.configuration?.scheme
  if (requested !== undefined) {
    if (!validateString(requested, "scheme", errors)) return undefined
    return {
      value: requested.trim(),
      provenance: request.scheme !== undefined ? "request" : "configuration",
    }
  }

  const found = discover.scheme(environment.trustedRoot, container)
  if (found.status === "found") return { value: found.value, provenance: "discovery" }
  if (found.status === "ambiguous") {
    push(
      errors,
      "scheme",
      "ambiguous",
      "more than one shared scheme was discovered; name one explicitly",
      found.candidates,
    )
    return undefined
  }
  push(errors, "scheme", "notFound", "no shared scheme was discovered")
  return undefined
}

// --- destination ----------------------------------------------------------

function resolveDestination(
  request: TestRunRequest,
  environment: ResolutionEnvironment,
  errors: RequestError[],
): ResolvedTestRun["destination"] | undefined {
  const requested = request.destination ?? environment.configuration?.destination
  if (requested === undefined) {
    // There is no safe default: guessing a destination runs the tests somewhere
    // the caller did not ask for, which is worse than refusing.
    push(errors, "destination", "required", "a destination must be requested or configured")
    return undefined
  }

  const provenance = request.destination !== undefined ? "request" : "configuration"
  const before = errors.length

  if (requested.kind === "id") {
    validateDestinationComponent(requested.id, "destination.id", errors)
  } else {
    validateDestinationComponent(requested.platform, "destination.platform", errors)
    validateDestinationComponent(requested.name, "destination.name", errors)
    if (requested.os !== undefined) {
      validateDestinationComponent(requested.os, "destination.os", errors)
    }
  }

  if (errors.length !== before) return undefined
  return { value: trimDestination(requested), provenance }
}

/** `,` and `=` are the separators `-destination` itself uses. */
function validateDestinationComponent(
  value: string,
  field: string,
  errors: RequestError[],
): void {
  if (!validateString(value, field, errors)) return
  if (value.includes(",") || value.includes("=")) {
    push(errors, field, "illegalCharacter", "a destination component may not contain ',' or '='")
  }
}

function trimDestination(destination: Destination): Destination {
  if (destination.kind === "id") return { kind: "id", id: destination.id.trim() }
  return {
    kind: "named",
    platform: destination.platform.trim(),
    name: destination.name.trim(),
    ...(destination.os === undefined ? {} : { os: destination.os.trim() }),
  }
}

// --- timeout --------------------------------------------------------------

function resolveTimeout(
  request: TestRunRequest,
  environment: ResolutionEnvironment,
  errors: RequestError[],
): ResolvedTestRun["timeoutSeconds"] {
  const requested = request.timeoutSeconds ?? environment.configuration?.timeoutSeconds
  if (requested === undefined) {
    return { value: DEFAULT_TIMEOUT_SECONDS, provenance: "default" }
  }

  if (
    !Number.isInteger(requested) ||
    requested < MIN_TIMEOUT_SECONDS ||
    requested > MAX_TIMEOUT_SECONDS
  ) {
    push(
      errors,
      "timeoutSeconds",
      "outOfRange",
      `the timeout must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`,
    )
  }

  return {
    value: requested,
    provenance: request.timeoutSeconds !== undefined ? "request" : "configuration",
  }
}

// --- shared ---------------------------------------------------------------

/** Control characters would corrupt an argument list without being visible. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** Trimmed, non-empty, and free of control characters. */
export function validateString(value: string, field: string, errors: RequestError[]): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    push(errors, field, "empty", "this value may not be empty")
    return false
  }
  if (CONTROL_CHARACTERS.test(value)) {
    push(errors, field, "controlCharacter", "this value may not contain control characters")
    return false
  }
  return true
}

function push(
  errors: RequestError[],
  field: string,
  code: string,
  message: string,
  candidates?: string[],
): void {
  errors.push({
    field,
    code,
    message,
    ...(candidates === undefined
      ? {}
      : { candidates: candidates.slice(0, 20), candidatesTruncated: candidates.length > 20 }),
  })
}

/** Ordered by field path then code, capped, and reporting what it dropped. */
export function reject(errors: RequestError[]): RequestRejected {
  const ordered = [...errors].sort(
    (a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code),
  )
  const section: CappedSection = {
    total: ordered.length,
    shown: Math.min(ordered.length, REQUEST_ERROR_CAP),
    truncated: ordered.length > REQUEST_ERROR_CAP,
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    outcome: "invalid",
    errors: ordered.slice(0, REQUEST_ERROR_CAP),
    errorSection: section,
  }
}
