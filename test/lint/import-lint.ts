/**
 * The import lint (ADR 0002).
 *
 * Reads a source tree with `node:fs`, matches static `import` / `export … from`
 * specifiers, and asserts the dependency allowlist and the one-way direction
 * `domain ← interpreter ← adapter`, `domain ← runner ← adapter`.
 *
 * Dynamic `import()` and `require()` are rejected outright rather than
 * analyzed. Bun executes CommonJS-style `require` in TypeScript files, so
 * ignoring either would leave the lint exactly as unsound as permitting it.
 *
 * This is a source-text lint, not a type-aware one, which is the point: it must
 * hold over a tree that does not yet compile, and it must not need a host.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

/** The four layers of shipped code. Order is not significance; `LAYER_IMPORTS` is. */
export const LAYERS = ["domain", "runner", "interpreter", "adapter"] as const

export type Layer = (typeof LAYERS)[number]

/** Which layers each layer may reach. The one-way direction, spelled out. */
export const LAYER_IMPORTS: Record<Layer, readonly Layer[]> = {
  domain: [],
  runner: ["domain"],
  interpreter: ["domain"],
  adapter: ["domain", "runner", "interpreter"],
}

/** The only non-`node:` package shipped code may import, and the only layer that may. */
export const HOST_PACKAGE = "@opencode-ai/plugin"
export const HOST_PACKAGE_LAYER: Layer = "adapter"

export type ImportViolation = {
  file: string
  line: number
  rule:
    | "dynamicImport"
    | "require"
    | "forbiddenPackage"
    | "hostPackageOutsideAdapter"
    | "crossLayer"
    | "outsideSourceTree"
  specifier: string
  message: string
}

/**
 * Lint every `.ts` file beneath `srcRoot`. Returns violations rather than
 * throwing, so a test can assert on the exact rule a planted violation trips.
 */
export function lintImports(srcRoot: string): ImportViolation[] {
  const root = resolve(srcRoot)
  const violations: ImportViolation[] = []

  for (const file of sourceFiles(root)) {
    const layer = layerOf(root, file)
    const text = readFileSync(file, "utf8")
    const display = relative(root, file)

    for (const found of findDynamicLoads(text)) {
      violations.push({
        file: display,
        line: found.line,
        rule: found.rule,
        specifier: found.text,
        message: `${found.rule === "require" ? "require()" : "dynamic import()"} is not permitted in shipped code`,
      })
    }

    for (const found of findStaticSpecifiers(text)) {
      violations.push(
        ...classifySpecifier({ display, layer, file, root, line: found.line, specifier: found.specifier }),
      )
    }
  }

  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  )
}

function classifySpecifier(input: {
  display: string
  layer: Layer | undefined
  file: string
  root: string
  line: number
  specifier: string
}): ImportViolation[] {
  const { display, layer, line, specifier } = input

  if (specifier.startsWith("node:")) return []

  if (!isRelative(specifier)) {
    if (specifier === HOST_PACKAGE) {
      if (layer === HOST_PACKAGE_LAYER) return []
      return [
        {
          file: display,
          line,
          rule: "hostPackageOutsideAdapter",
          specifier,
          message: `${HOST_PACKAGE} may only be imported from src/${HOST_PACKAGE_LAYER}`,
        },
      ]
    }
    return [
      {
        file: display,
        line,
        rule: "forbiddenPackage",
        specifier,
        message: `shipped code may import only node:* built-ins and ${HOST_PACKAGE}`,
      },
    ]
  }

  const target = resolve(input.file, "..", specifier)
  const targetLayer = layerOf(input.root, target)

  if (targetLayer === undefined) {
    return [
      {
        file: display,
        line,
        rule: "outsideSourceTree",
        specifier,
        message: "relative imports may not leave the source tree",
      },
    ]
  }

  if (layer === undefined || targetLayer === layer) return []

  if (!LAYER_IMPORTS[layer].includes(targetLayer)) {
    return [
      {
        file: display,
        line,
        rule: "crossLayer",
        specifier,
        message: `src/${layer} may not import src/${targetLayer}`,
      },
    ]
  }

  return []
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

/** The layer a path belongs to, or `undefined` when it sits outside all of them. */
export function layerOf(root: string, path: string): Layer | undefined {
  const rel = relative(root, path)
  if (rel.startsWith("..") || rel === "") return undefined
  const head = rel.split(sep)[0]
  if (head === undefined) return undefined
  return (LAYERS as readonly string[]).includes(head) ? (head as Layer) : undefined
}

const STATIC_SPECIFIER =
  /(?:^|[\n;])\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g

function findStaticSpecifiers(text: string): Array<{ line: number; specifier: string }> {
  const found: Array<{ line: number; specifier: string }> = []
  for (const match of text.matchAll(STATIC_SPECIFIER)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined) continue
    // The pattern absorbs the newline preceding the statement, so locate the
    // specifier within the match rather than reporting the match's own start.
    found.push({ line: lineOf(text, match.index + match[0].indexOf(specifier)), specifier })
  }
  return found
}

const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/g
const REQUIRE_CALL = /(?<![\w$.])require\s*\(/g

function findDynamicLoads(
  text: string,
): Array<{ line: number; rule: "dynamicImport" | "require"; text: string }> {
  const found: Array<{ line: number; rule: "dynamicImport" | "require"; text: string }> = []
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    found.push({ line: lineOf(text, match.index), rule: "dynamicImport", text: match[0].trim() })
  }
  for (const match of text.matchAll(REQUIRE_CALL)) {
    found.push({ line: lineOf(text, match.index), rule: "require", text: match[0].trim() })
  }
  return found
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1
  return line
}

/** Every `.ts` file beneath `dir`, sorted so violations report deterministically. */
export function sourceFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(".ts")) found.push(path)
    }
  }
  walk(dir)
  return found
}
