/**
 * Mapping tool arguments onto the domain request.
 *
 * The two vocabularies are deliberately different. A model-facing argument is
 * named for what a caller is choosing — `scope`, `container` — while the domain
 * names the same things for what they mean in a contract — `requestedScope`,
 * `xcodeContainer`. Keeping the boundary explicit is what lets either side be
 * renamed without the other noticing, and it is the one place where a value
 * that came from a model becomes a value the runner will act on.
 *
 * Nothing here validates. Validation belongs to the runner's resolution, which
 * reports every independently detectable error at once; a second, weaker check
 * here would only produce a different error for the same input.
 */

import type { Destination, TestRunRequest, XcodeContainer } from "../domain/request.ts"
import type { InspectionFacet, InspectRunRequest } from "../domain/inspection.ts"
import type { RequestedScope } from "../domain/scope.ts"

/** The shape `xcode_test` declares. Optionality mirrors the Zod schema exactly. */
export type TestArguments = {
  scope: RequestedScope
  container?: XcodeContainer
  scheme?: string
  destination?: Destination
  timeoutSeconds?: number
}

export function toTestRunRequest(args: TestArguments): TestRunRequest {
  return {
    requestedScope: args.scope,
    ...(args.container === undefined ? {} : { xcodeContainer: args.container }),
    ...(args.scheme === undefined ? {} : { scheme: args.scheme }),
    ...(args.destination === undefined ? {} : { destination: args.destination }),
    ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
  }
}

/** The shape `xcode_test_inspect` declares. */
export type InspectArguments = {
  runId: string
  facet: InspectionFacet
  limit?: number
  cursor?: string
  diagnosticId?: string
  testId?: string
  maxBytes?: number
}

export function toInspectRunRequest(args: InspectArguments): InspectRunRequest {
  return {
    runId: args.runId,
    facet: args.facet,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.diagnosticId === undefined ? {} : { diagnosticId: args.diagnosticId }),
    ...(args.testId === undefined ? {} : { testId: args.testId }),
    ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
  }
}
