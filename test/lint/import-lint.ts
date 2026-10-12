/**
 * The import lint (ADR 0002).
 *
 * Reads a source tree with `node:fs`, finds static `import` / `export … from`
 * specifiers, and asserts the dependency allowlist and the one-way direction
 * `domain ← interpreter ← adapter`, `domain ← runner ← adapter`. The root
 * entrypoint the host loads (`server.ts`) is held to the same allowlist and
 * may reach only the adapter.
 *
 * Specifiers are found by parsing, not by pattern (issue #157): a pattern that
 * stopped at a newline never saw the multiline form the formatter gives a long
 * import list, so a forbidden import written that way passed. The parse is
 * syntax-only — `ts.createSourceFile`, no program and no type checking — and a
 * file with a syntax error is itself a violation, since what the parser
 * recovers into may hide an import.
 *
 * Dynamic `import()` and `require()` are rejected outright rather than
 * analyzed. Bun executes CommonJS-style `require` in TypeScript files, so
 * ignoring either would leave the lint exactly as unsound as permitting it.
 *
 * This is a source-text lint, not a type-aware one, which is the point: it must
 * hold over a tree that does not yet compile, and it must not need a host.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import ts from "typescript"

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

/** Which layers a root entrypoint may reach: it is the adapter's face to the host. */
export const ENTRYPOINT_IMPORTS: readonly Layer[] = ["adapter"]

/** Where a linted file sits: a layer, a root entrypoint, or elsewhere under `src`. */
type Origin = Layer | "entrypoint" | undefined

/** A file to lint, where it sits, and how it is named in a violation. */
type LintedFile = { file: string; origin: Origin; display: string }

/** The only non-`node:` package shipped code may import, and the only layer that may. */
export const HOST_PACKAGE = "@opencode/plugin"
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
    | "unparseable"
  specifier: string
  message: string
}

/**
 * Lint every `.ts` file beneath `srcRoot`, and each root `entrypoints` file
 * beside it. Returns violations rather than throwing, so a test can assert on
 * the exact rule a planted violation trips.
 *
 * Files under `srcRoot` are reported relative to it; entrypoints relative to
 * its parent, the checkout.
 */
export function lintImports(srcRoot: string, options: { entrypoints?: readonly string[] } = {}): ImportViolation[] {
  const root = resolve(srcRoot)
  const violations: ImportViolation[] = []
  const files: LintedFile[] = [
    ...sourceFiles(root).map((file) => ({ file, origin: layerOf(root, file), display: relative(root, file) })),
    ...(options.entrypoints ?? []).map((entrypoint) => {
      const file = resolve(entrypoint)
      return { file, origin: "entrypoint" as const, display: relative(dirname(root), file) }
    }),
  ]

  for (const { file, origin, display } of files) {
    const text = readFileSync(file, "utf8")

    // A file that does not parse may hide imports from the parse, so it is a
    // violation in itself rather than a file with none (issue #157).
    const unparseable = firstSyntaxError(file, text)
    if (unparseable !== undefined) {
      violations.push({
        file: display,
        line: unparseable.line,
        rule: "unparseable",
        specifier: "",
        message: `the file could not be parsed, so its imports cannot be checked: ${unparseable.message}`,
      })
    }

    for (const found of findDynamicLoads(text)) {
      violations.push({
        file: display,
        line: found.line,
        rule: found.rule,
        specifier: found.text,
        message: `${found.rule === "require" ? "require()" : "dynamic import()"} is not permitted in shipped code`,
      })
    }

    for (const found of findStaticSpecifiers(file, text)) {
      violations.push(
        ...classifySpecifier({ display, origin, file, root, line: found.line, specifier: found.specifier }),
      )
    }
  }

  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  )
}

function classifySpecifier(input: {
  display: string
  origin: Origin
  file: string
  root: string
  line: number
  specifier: string
}): ImportViolation[] {
  const { display, origin, line, specifier } = input

  if (specifier.startsWith("node:")) return []

  if (!isRelative(specifier)) {
    if (specifier === HOST_PACKAGE) {
      if (origin === HOST_PACKAGE_LAYER) return []
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

  if (origin === undefined || targetLayer === origin) return []

  const { reach, name } = reachOf(origin)
  if (!reach.includes(targetLayer)) {
    return [
      {
        file: display,
        line,
        rule: "crossLayer",
        specifier,
        message: `${name} may not import src/${targetLayer}`,
      },
    ]
  }

  return []
}

/** The layers an origin may reach, and what a violation calls it. */
function reachOf(origin: Layer | "entrypoint"): { reach: readonly Layer[]; name: string } {
  return origin === "entrypoint"
    ? { reach: ENTRYPOINT_IMPORTS, name: "the root entrypoint" }
    : { reach: LAYER_IMPORTS[origin], name: `src/${origin}` }
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

/**
 * Every static module specifier: `import`, `import type`, a side-effect
 * `import`, `export … from` and `export * from`, however the statement is laid
 * out. Reported at the specifier's own line.
 *
 * Syntax only, so a type error changes nothing here. A syntax error can: the
 * parser recovers from it, but what it recovers into may swallow a later
 * import — which is why `firstSyntaxError` is checked alongside.
 */
function findStaticSpecifiers(file: string, text: string): Array<{ line: number; specifier: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Array<{ line: number; specifier: string }> = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.moduleSpecifier.getStart(source))
      found.push({ line: line + 1, specifier: node.moduleSpecifier.text })
    }
    // Declarations nest too — inside `declare module` blocks — so the whole
    // tree is walked rather than only its top-level statements.
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * The first syntax error in a file, if it has one. Reported by the public,
 * syntax-only transpiler — no program and no type checking.
 */
function firstSyntaxError(file: string, text: string): { line: number; message: string } | undefined {
  const { diagnostics } = ts.transpileModule(text, { fileName: file, reportDiagnostics: true })
  const first = diagnostics?.find((diagnostic) => diagnostic.file !== undefined)
  if (first?.file === undefined) return undefined
  const { line } = first.file.getLineAndCharacterOfPosition(first.start ?? 0)
  return { line: line + 1, message: ts.flattenDiagnosticMessageText(first.messageText, " ") }
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
