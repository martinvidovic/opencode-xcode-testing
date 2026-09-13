/**
 * Composing the renderer and the budget into the text a tool actually returns.
 *
 * Kept separate from both so that the renderer stays a pure document producer
 * and the budget stays a pure serializer — each is testable on its own, and
 * neither has to know the other exists.
 */

import type { TestToolResult } from "../domain/result.ts"
import { DEFAULT_BUDGET, serialize, type Budget, type SerializeResult } from "./budget.ts"
import { renderResult } from "./render.ts"

export function renderTestToolResult(
  result: TestToolResult,
  budget: Budget = DEFAULT_BUDGET,
): SerializeResult {
  return serialize(renderResult(result), budget)
}

/** The text alone, for the common case where nothing about the fit is in doubt. */
export function renderText(result: TestToolResult, budget: Budget = DEFAULT_BUDGET): string {
  return renderTestToolResult(result, budget).text
}
