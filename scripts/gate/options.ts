/**
 * The acceptance gate's command line (ADR 0001 Layer 4).
 *
 * Parsed strictly, and for one reason: this gate's output is a claim about
 * whether map #1's destination has been reached. An unknown option that was
 * quietly ignored would let `--layer-4` or `--B1` select nothing, run nothing,
 * and report green — a gate that passes because it misread its own arguments
 * is worse than no gate at all.
 *
 * The same logic makes "selected nothing" an error rather than a trivial pass.
 */

import { isAbsolute, resolve } from "node:path"
import { lstatSync } from "node:fs"

/** The scenario groups a run may select. */
export const SUITES = ["layer4", "b1", "b2"] as const
export type Suite = (typeof SUITES)[number]

export type Options = {
  /** Which suites to run, in a stable order. Never empty. */
  suites: Suite[]
  /**
   * A real project to run against instead of the generated fixture project.
   *
   * Canonical, because every layer below is handed a trusted root and #26's
   * containment rules are stated against canonical paths.
   */
  project?: string
}

export type ParseResult =
  | { status: "parsed"; options: Options }
  | { status: "rejected"; message: string }

export function parseOptions(argv: string[]): ParseResult {
  const suites: Suite[] = []
  let project: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string

    if (!argument.startsWith("--")) {
      return rejected(`unexpected argument \`${argument}\``)
    }

    const name = argument.slice(2)
    if (isSuite(name)) {
      if (!suites.includes(name)) suites.push(name)
      continue
    }

    if (name === "project") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) {
        return rejected("`--project` needs a path")
      }
      index += 1

      const canonical = canonicalProject(value)
      if (canonical === undefined) {
        return rejected(`\`--project ${value}\` is not an existing directory`)
      }
      project = canonical
      continue
    }

    return rejected(`unknown option \`${argument}\``)
  }

  // No selection means everything, which is the standing gate. An *empty*
  // selection cannot happen: an unrecognized flag was rejected above.
  return {
    status: "parsed",
    options: {
      suites: suites.length === 0 ? [...SUITES] : SUITES.filter((suite) => suites.includes(suite)),
      ...(project === undefined ? {} : { project }),
    },
  }
}

function rejected(message: string): ParseResult {
  return { status: "rejected", message }
}

function isSuite(name: string): name is Suite {
  return (SUITES as readonly string[]).includes(name)
}

/**
 * Resolved and canonicalized before anything is handed it, so the layers
 * below decide containment against a real directory rather than a name that
 * might be a link. A relative path resolves against the working directory,
 * which is what someone typing one at a shell means.
 */
function canonicalProject(value: string): string | undefined {
  const absolute = isAbsolute(value) ? value : resolve(process.cwd(), value)
  try {
    return lstatSync(absolute).isDirectory() ? absolute : undefined
  } catch {
    return undefined
  }
}

export function usage(): string {
  return [
    "usage: bun scripts/acceptance-gate.ts [--layer4] [--b1] [--b2] [--project <path>]",
    "",
    "  With no suite flags, every suite runs. `--project` points the execution",
    "  suites at a real Xcode project instead of the generated fixture one; it",
    "  never becomes the standing gate, which must run from committed files.",
  ].join("\n")
}
