/**
 * Hand-written decoders for the `xcresulttool` payloads the interpreter reads,
 * pinned to schema `0.1.0` (#8).
 *
 * Two rules govern every decoder here:
 *
 * - **Capability-based support.** Unknown additive fields are ignored; a
 *   classification-critical shape that does not validate is an unsupported
 *   schema, not a best guess.
 * - **Narrow, allowlisted defect tolerance.** Scalar-versus-array variation is
 *   accepted only at documented field paths where it has been observed and is
 *   semantically unambiguous. Null, mixed, or malformed values downgrade the
 *   facet instead.
 */

import { AnomalyLog } from "./anomalies.ts"

export type DecodeFailure = {
  /** `unsupportedSchema` when a critical shape is wrong; `incomplete` when it is absent. */
  defect: "unsupportedSchema" | "incomplete"
  fieldPath: string
  message: string
}

export type Decoded<T> = { ok: true; value: T } | { ok: false } & DecodeFailure

function fail(defect: DecodeFailure["defect"], fieldPath: string, message: string): Decoded<never> {
  return { ok: false, defect, fieldPath, message }
}

// --- content availability -------------------------------------------------

/**
 * The availability claim, and nothing more. It never classifies on its own.
 *
 * Observed at schema `0.1.0`, the payload is
 * `{ hasCoverage, hasDiagnostics, hasTestResults, logs: [...] }` — there is no
 * `hasBuildResults`, and log availability is an array of log names rather than
 * a boolean. Build results are therefore always attemptable, and `hasLogs` is
 * derived. Unknown additive fields are ignored, per the capability-based
 * support rule.
 */
export type ContentAvailability = {
  hasTestResults: boolean
  hasLogs: boolean
}

export function decodeContentAvailability(payload: unknown): Decoded<ContentAvailability> {
  if (!isRecord(payload)) {
    return fail("unsupportedSchema", "", "content availability is not an object")
  }

  const hasTestResults = payload["hasTestResults"]
  if (typeof hasTestResults !== "boolean") {
    return fail(
      "unsupportedSchema",
      "hasTestResults",
      `required availability field is ${describe(hasTestResults)}`,
    )
  }

  const logs = payload["logs"]
  const declaredHasLogs = payload["hasLogs"]
  const hasLogs =
    typeof declaredHasLogs === "boolean"
      ? declaredHasLogs
      : Array.isArray(logs)
        ? logs.length > 0
        : false

  return { ok: true, value: { hasTestResults, hasLogs } }
}

// --- build results --------------------------------------------------------

export type RawBuildIssue = {
  message: string
  targetName?: string
  /** A `file://` URL with Xcode's fragment-encoded position, when present. */
  sourceURL?: string
}

export type RawBuildResults = {
  status?: string
  /** The optionally reported count. When present it must equal `errors.length`. */
  declaredErrorCount?: number
  errors: RawBuildIssue[]
  /** Error records present but too malformed to use. Their presence is lossy. */
  malformedErrorCount: number
}

export function decodeBuildResults(
  payload: unknown,
  anomalies: AnomalyLog,
): Decoded<RawBuildResults> {
  if (!isRecord(payload)) {
    return fail("unsupportedSchema", "", "build results are not an object")
  }

  const rawErrors = payload["errors"]
  if (!Array.isArray(rawErrors)) {
    // `errors` is classification-critical: a missing collection is not zero.
    return fail("incomplete", "errors", `errors collection is ${describe(rawErrors)}`)
  }

  const errors: RawBuildIssue[] = []
  let malformedErrorCount = 0

  rawErrors.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry["message"] !== "string") {
      malformedErrorCount += 1
      anomalies.record({
        command: "get build-results",
        fieldPath: `errors[${index}]`,
        observedShape: describe(entry),
        normalizationApplied: "dropped",
        lossy: true,
      })
      return
    }
    errors.push({
      message: entry["message"],
      ...optionalString(entry["targetName"], "targetName"),
      ...optionalString(entry["sourceURL"], "sourceURL"),
    })
  })

  const declared = payload["errorCount"]
  if (declared !== undefined && typeof declared !== "number") {
    return fail("unsupportedSchema", "errorCount", `errorCount is ${describe(declared)}`)
  }

  return {
    ok: true,
    value: {
      ...optionalString(payload["status"], "status"),
      ...(typeof declared === "number" ? { declaredErrorCount: declared } : {}),
      errors,
      malformedErrorCount,
    },
  }
}

// --- test results: tests --------------------------------------------------

/** Statuses Xcode reports on a test node, before mapping into the domain. */
export const XCODE_TEST_RESULTS = [
  "Passed",
  "Failed",
  "Skipped",
  "Expected Failure",
  "unknown",
] as const

export type XcodeTestResult = (typeof XCODE_TEST_RESULTS)[number]

export type RawTestNode = {
  nodeType: string
  name: string
  nodeIdentifier?: string
  nodeIdentifierURL?: string
  result?: string
  /** Locale-formatted and display-only; `durationInSeconds` is the usable one. */
  duration?: string
  durationInSeconds?: number
  /** Present when a node names its own test-plan configuration or device. */
  configurationId?: string
  deviceId?: string
  children: RawTestNode[]
}

export type RawTestResults = {
  configurations: string[]
  devices: string[]
  nodes: RawTestNode[]
}

export function decodeTestResults(payload: unknown): Decoded<RawTestResults> {
  if (!isRecord(payload)) {
    return fail("unsupportedSchema", "", "test results are not an object")
  }

  const rawNodes = payload["testNodes"]
  if (!Array.isArray(rawNodes)) {
    return fail("incomplete", "testNodes", `testNodes is ${describe(rawNodes)}`)
  }

  const nodes: RawTestNode[] = []
  for (const [index, raw] of rawNodes.entries()) {
    const node = decodeNode(raw, `testNodes[${index}]`)
    if (!node.ok) return node
    nodes.push(node.value)
  }

  return {
    ok: true,
    value: {
      configurations: idList(payload["testPlanConfigurations"], "configurationId"),
      devices: idList(payload["devices"], "deviceId"),
      nodes,
    },
  }
}

function decodeNode(raw: unknown, path: string): Decoded<RawTestNode> {
  if (!isRecord(raw)) return fail("unsupportedSchema", path, `node is ${describe(raw)}`)

  const nodeType = raw["nodeType"]
  const name = raw["name"]
  if (typeof nodeType !== "string") {
    return fail("unsupportedSchema", `${path}.nodeType`, `nodeType is ${describe(nodeType)}`)
  }
  if (typeof name !== "string") {
    return fail("unsupportedSchema", `${path}.name`, `name is ${describe(name)}`)
  }

  const result = raw["result"]
  if (result !== undefined && typeof result !== "string") {
    // A wrong status *type* is an incompatible critical shape, not a gap.
    return fail("unsupportedSchema", `${path}.result`, `result is ${describe(result)}`)
  }

  const children: RawTestNode[] = []
  const rawChildren = raw["children"]
  if (rawChildren !== undefined) {
    if (!Array.isArray(rawChildren)) {
      return fail("unsupportedSchema", `${path}.children`, `children is ${describe(rawChildren)}`)
    }
    for (const [index, child] of rawChildren.entries()) {
      const decoded = decodeNode(child, `${path}.children[${index}]`)
      if (!decoded.ok) return decoded
      children.push(decoded.value)
    }
  }

  return {
    ok: true,
    value: {
      nodeType,
      name,
      ...optionalString(raw["nodeIdentifier"], "nodeIdentifier"),
      ...optionalString(raw["nodeIdentifierURL"], "nodeIdentifierURL"),
      ...(result === undefined ? {} : { result }),
      ...optionalString(raw["duration"], "duration"),
      ...(typeof raw["durationInSeconds"] === "number"
        ? { durationInSeconds: raw["durationInSeconds"] }
        : {}),
      ...optionalString(raw["configurationId"], "configurationId"),
      ...optionalString(raw["deviceId"], "deviceId"),
      children,
    },
  }
}

// --- test results: summary ------------------------------------------------

export type RawTestFailure = {
  testName?: string
  targetName?: string
  failureText?: string
}

export type RawTestSummary = {
  result?: string
  totalTestCount?: number
  passedTests?: number
  failedTests?: number
  skippedTests?: number
  expectedFailures?: number
  testFailures: RawTestFailure[]
  /** True when `testFailures` could not be read losslessly. */
  testFailuresDegraded: boolean
}

/**
 * The one documented arity defect: schema `0.1.0` declares `testFailures` as a
 * single object rather than an array, so the decoder accepts either shape at
 * exactly this path. Null, mixed, or malformed entries degrade instead.
 */
export function decodeTestSummary(payload: unknown, anomalies: AnomalyLog): Decoded<RawTestSummary> {
  if (!isRecord(payload)) {
    return fail("unsupportedSchema", "", "test summary is not an object")
  }

  const counts: Partial<RawTestSummary> = {}
  for (const field of [
    "totalTestCount",
    "passedTests",
    "failedTests",
    "skippedTests",
    "expectedFailures",
  ] as const) {
    const raw = payload[field]
    if (raw === undefined) continue
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return fail("unsupportedSchema", field, `${field} is ${describe(raw)}`)
    }
    counts[field] = raw
  }

  const raw = payload["testFailures"]
  let entries: unknown[]
  let degraded = false

  if (raw === undefined) {
    entries = []
  } else if (Array.isArray(raw)) {
    entries = raw
  } else if (isRecord(raw)) {
    // Allowlisted: `get test-results summary` @ 0.1.0 emits a bare object here.
    anomalies.record({
      command: "get test-results summary",
      fieldPath: "testFailures",
      observedShape: "object",
      normalizationApplied: "wrapped in a single-element array",
    })
    entries = [raw]
  } else {
    anomalies.record({
      command: "get test-results summary",
      fieldPath: "testFailures",
      observedShape: describe(raw),
      normalizationApplied: "dropped",
      lossy: true,
    })
    entries = []
    degraded = true
  }

  const testFailures: RawTestFailure[] = []
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      anomalies.record({
        command: "get test-results summary",
        fieldPath: `testFailures[${index}]`,
        observedShape: describe(entry),
        normalizationApplied: "dropped",
        lossy: true,
      })
      degraded = true
      return
    }
    testFailures.push({
      ...optionalString(entry["testName"], "testName"),
      ...optionalString(entry["targetName"], "targetName"),
      ...optionalString(entry["failureText"], "failureText"),
    })
  })

  return {
    ok: true,
    value: {
      ...optionalString(payload["result"], "result"),
      ...counts,
      testFailures,
      testFailuresDegraded: degraded,
    },
  }
}

// --- shared helpers -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString<K extends string>(
  value: unknown,
  key: K,
): { [P in K]?: string } | Record<string, never> {
  return typeof value === "string" ? ({ [key]: value } as { [P in K]?: string }) : {}
}

function idList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (isRecord(entry) && typeof entry[key] === "string") ids.push(entry[key])
  }
  return [...new Set(ids)].sort()
}

/** A shape description safe to put in a private anomaly or a decode failure. */
function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
