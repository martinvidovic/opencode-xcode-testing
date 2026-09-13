/**
 * Runtime resolution (ADR 0002).
 *
 * The plugin ships as source with no build step, so the supervisor entrypoint
 * is spawned as TypeScript and needs a runtime that can actually execute it.
 * Every candidate is **probed and verified** rather than assumed, because the
 * one that looks most obviously correct is the one that fails: the shipped
 * `opencode` is a Bun-compiled single-file executable, so it reports a Bun
 * version and cannot run a `.ts` file.
 *
 * There is no silent fallback anywhere in this file. An explicitly configured
 * runtime that does not work is a hard error — a setting that quietly degrades
 * is worse than one that fails, because it fails somewhere else, later.
 */

import { lstatSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { readRegistry, writeRegistry } from "../runner/housekeeping.ts"
import type { Storage } from "../runner/paths.ts"

export type RuntimeSource = "configuration" | "host" | "path"

/**
 * A probe must prove the candidate executes a trivial script, not merely exist.
 *
 * It is asynchronous because startup runs it under a shared deadline: a
 * synchronous probe blocks the loop, so the deadline it is supposed to be
 * bounded by cannot fire until after it has already finished.
 */
export type RuntimeProbe = (candidate: string) => Promise<{ usable: boolean; version?: string }>

export type RuntimeResolution =
  | { status: "resolved"; path: string; source: RuntimeSource; version?: string }
  | {
      status: "failed"
      reason: "runnerFailure"
      message: string
      /** What was tried, in order, so the diagnostic names the actual attempts. */
      probed: string[]
    }

export type RuntimeInput = {
  trustedRoot: string
  /** The optional `runtime` field. Machine-local; relative resolves against the root. */
  configured?: string
  /** `process.execPath` — expected to fall through, for the reason above. */
  hostExecutable: string
  /** How `bun` is found on `PATH`, or `undefined` when it is not there. */
  pathCandidate?: string
  probe: RuntimeProbe
}

export async function resolveRuntime(input: RuntimeInput): Promise<RuntimeResolution> {
  const probed: string[] = []

  if (input.configured !== undefined) {
    const path = isAbsolute(input.configured)
      ? input.configured
      : resolve(input.trustedRoot, input.configured)
    probed.push(path)

    const result = await input.probe(path)
    if (result.usable) {
      return {
        status: "resolved",
        path,
        source: "configuration",
        ...(result.version === undefined ? {} : { version: result.version }),
      }
    }
    // Set but unusable is a hard error, never a fallback.
    return {
      status: "failed",
      reason: "runnerFailure",
      message:
        "the configured runtime could not execute a TypeScript file. Set `runtime` in .opencode/xcode-test.json to a working Bun, or remove it to fall back to discovery.",
      probed,
    }
  }

  for (const candidate of [input.hostExecutable, input.pathCandidate]) {
    if (candidate === undefined) continue
    probed.push(candidate)
    const result = await input.probe(candidate)
    if (!result.usable) continue
    return {
      status: "resolved",
      path: candidate,
      source: candidate === input.hostExecutable ? "host" : "path",
      ...(result.version === undefined ? {} : { version: result.version }),
    }
  }

  return {
    status: "failed",
    reason: "runnerFailure",
    message:
      "no usable Bun runtime was found. Install Bun (https://bun.sh) so it is on PATH, or set `runtime` in .opencode/xcode-test.json to its absolute path. A Homebrew-installed opencode is a compiled binary and cannot run TypeScript.",
    probed,
  }
}

/**
 * A cached probe result, revalidated by `stat` rather than re-spawned.
 *
 * This is #8's identity-recheck philosophy applied to the runtime: first start
 * pays the full probe, later starts pay a stat. Re-probing on every session
 * would spend a subprocess proving something that has not changed.
 */
export type RuntimeCacheEntry = {
  path: string
  mtimeMs: number
  size: number
  /** Where the candidate came from. Re-deriving it from the path would guess. */
  source: RuntimeSource
  version?: string
}

/**
 * A previously probed runtime, if the binary is still the one that was probed.
 *
 * Re-spawning a subprocess every session to prove something that has not
 * changed is a cost with no answer attached; a `stat` that disagrees is what
 * sends the caller back to the real probe.
 *
 * Note what this deliberately cannot do: answer for a *configured* runtime.
 * Callers consult it only where discovery would have run anyway, because a
 * cache standing in for an explicit setting would turn this file's hard error
 * into the silent fallback it exists to refuse.
 */
export function cachedRuntime(storage: Storage): RuntimeResolution | undefined {
  const entry = readRegistry(storage).runtime
  if (entry === undefined) return undefined
  if (!cacheIsValid(entry, statOf(entry.path))) return undefined

  return {
    status: "resolved",
    path: entry.path,
    source: entry.source,
    ...(entry.version === undefined ? {} : { version: entry.version }),
  }
}

export function rememberRuntime(
  storage: Storage,
  runtime: Extract<RuntimeResolution, { status: "resolved" }>,
): void {
  const observed = statOf(runtime.path)
  if (observed === undefined) return

  writeRegistry(storage, {
    ...readRegistry(storage),
    runtime: {
      ...observed,
      source: runtime.source,
      ...(runtime.version === undefined ? {} : { version: runtime.version }),
    },
  })
}

function statOf(path: string): { path: string; mtimeMs: number; size: number } | undefined {
  try {
    const stats = lstatSync(path)
    return { path, mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

export function cacheIsValid(
  entry: RuntimeCacheEntry | undefined,
  observed: { path: string; mtimeMs: number; size: number } | undefined,
): boolean {
  if (entry === undefined || observed === undefined) return false
  return (
    entry.path === observed.path &&
    entry.mtimeMs === observed.mtimeMs &&
    entry.size === observed.size
  )
}
