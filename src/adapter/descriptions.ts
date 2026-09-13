/**
 * Tool descriptions, loaded from sidecar `.txt` files (ADR 0002).
 *
 * They live beside the code rather than inside it so a description can be
 * edited and reviewed as prose, and so the consistency check has a file to
 * compare against the outcome vocabulary the renderer actually emits. They are
 * also exactly the kind of file a static import graph cannot protect, which is
 * why startup stats them before registering anything.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const TOOL_IDS = ["xcode_test", "xcode_test_inspect", "xcode_test_recover"] as const

export type ToolId = (typeof TOOL_IDS)[number]

const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "descriptions")

export function descriptionPath(id: ToolId): string {
  return join(DIRECTORY, `${id}.txt`)
}

/** The files startup verifies before it registers anything. */
export const DESCRIPTION_FILES: string[] = TOOL_IDS.map(descriptionPath)

const cache = new Map<ToolId, string>()

export function descriptionFor(id: ToolId): string {
  const cached = cache.get(id)
  if (cached !== undefined) return cached

  const text = readFileSync(descriptionPath(id), "utf8").trimEnd()
  cache.set(id, text)
  return text
}
