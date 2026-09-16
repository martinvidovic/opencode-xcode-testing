/**
 * What a failed B2 run leaves behind (issue #98).
 *
 * B2 is the only suite that drives the real OpenCode host, and it was the only
 * one that kept nothing. Its workspace was deleted unconditionally on the way
 * out, and the artifacts that would explain a failure do not even live there:
 * the host runs the tool for real, so the Run Record, raw log, normalized
 * index and Result Bundle land in the *user's own* storage root, under one
 * opaque key per project. What survived a failure was a line of text saying a
 * scenario did not pass — which is the whole reason #84 has been chased by
 * rerunning rather than by reading.
 *
 * Two things follow, and they pull in opposite directions:
 *
 * - a failed run has to keep that storage before the workspace goes, and keep
 *   it correlated to *which scenario* failed, or a reader has two anonymous
 *   root keys and eleven results;
 * - a passing run has to remove it, because these roots are temp projects that
 *   will never exist again. Left alone they accumulate one directory per gate
 *   run, for ever, and the registry stores a hash and a timestamp by design —
 *   so nothing downstream can ever ask whether a root still exists.
 *
 * `DerivedData` is excluded from what is kept. It is regenerable by
 * definition, it is the overwhelming majority of a root's bytes, and a set
 * that carried it would exceed the entire evidence budget on its own — so
 * keeping it would mean keeping nothing.
 */

import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, sep } from "node:path"

import { createPrivateDirectory, RUN_ARTIFACTS } from "../../src/runner/paths.ts"
import { DrivenRoots } from "./driven-roots.ts"
import { fieldValue } from "../../src/adapter/document.ts"
import type { EvidenceSource } from "./forensics.ts"
import type { ScenarioName } from "./scenarios.ts"
import type { ScenarioResult } from "./report.ts"

/**
 * One failed B2 scenario, and where to read about it.
 *
 * Opaque identifiers only. `rootKey` is the hash the tool already files a
 * trusted root under and `runId` is the one it already renders to the model —
 * neither says anything about where on this machine anything lives, which is
 * the property that lets this reach a durable report at all.
 */
export type B2Correlation = {
  scenario: ScenarioName
  /** The evidence subtree the failing project's storage was kept under. */
  root: string
  rootKey: string
  runId?: string
}

/**
 * One tool response, kept verbatim because a staging failure's own sentence —
 * `the file could not be written`, `xcresulttool exited with status 1` —
 * exists nowhere else once the host process is gone.
 */
type Exchange = { what: string; root: string; rootKey: string; runId?: string; text: string }

/**
 * Collects, during a B2 run, what a failure would need afterwards.
 *
 * The correlation is built by pairing each recorded scenario result with the
 * invocation most recently observed, which is true by construction of how the
 * suite is written: every scenario is recorded immediately after the response
 * it is about. That is a property of this file's caller, so it is stated here
 * rather than left for a reader to notice.
 */
export class B2Evidence {
  readonly #roots: DrivenRoots
  readonly #transcript: Exchange[] = []
  readonly #correlations: B2Correlation[] = []
  readonly #hostOutput: string[] = []
  #latest: Exchange | undefined

  constructor(homeDir: string = homedir(), roots?: DrivenRoots) {
    this.#roots = roots ?? new DrivenRoots(homeDir)
  }

  /** Whether anything failed, which is what decides between keep and clean. */
  failed = false

  /** Register a project root this run will drive; see `DrivenRoots.add`. */
  root(path: string): string {
    return this.#roots.add(path)
  }

  /**
   * Whatever the host itself wrote while this suite drove it.
   *
   * The host runs in this process — `createOpencode` does not fork one — so
   * "host subprocess diagnostics" is this process's own error stream for the
   * window the host was alive, tee'd rather than swallowed. It is where a
   * plugin that failed to load, or a route that threw behind a caught
   * promise, says so; none of that reaches a scenario result.
   */
  hostOutput(text: string): void {
    this.#hostOutput.push(text)
  }

  /** Note one tool response, and the run it named. */
  observe(what: string, trustedRoot: string, text: string): void {
    const runId = fieldValue(text, "run")
    const exchange: Exchange = {
      what,
      root: basename(trustedRoot),
      rootKey: this.#roots.keyOf(trustedRoot),
      ...(runId === undefined ? {} : { runId }),
      text,
    }
    this.#latest = exchange
    this.#transcript.push(exchange)
  }

  /** Note one scenario result, correlating it to the response it is about. */
  watch(result: ScenarioResult): void {
    if (result.status !== "failed") return
    this.failed = true
    const latest = this.#latest
    this.#correlations.push({
      scenario: result.name,
      root: latest?.root ?? "unknown",
      rootKey: latest?.rootKey ?? "unknown",
      ...(latest?.runId === undefined ? {} : { runId: latest.runId }),
    })
  }

  /** What the report should carry. Empty when nothing failed. */
  correlations(): B2Correlation[] {
    return [...this.#correlations]
  }

  /**
   * The trees worth keeping, staged and named.
   *
   * The transcript is written into the workspace rather than handed over as a
   * string, because the responses are where a staging failure says what it
   * was — `the file could not be written`, `xcresulttool exited with status 1`
   * — and those sentences exist nowhere else once the process is gone.
   */
  sources(workspace: string): EvidenceSource[] {
    const staged: EvidenceSource[] = []

    const diagnostics = join(workspace, "host-diagnostics")
    try {
      createPrivateDirectory(diagnostics)
      writeFileSync(
        join(diagnostics, "responses.json"),
        JSON.stringify({ correlations: this.#correlations, exchanges: this.#transcript }, null, 2),
        { mode: 0o600 },
      )
      if (this.#hostOutput.length > 0) {
        writeFileSync(join(diagnostics, "host.log"), this.#hostOutput.join(""), { mode: 0o600 })
      }
      staged.push({ name: "b2-host-diagnostics", path: diagnostics })
    } catch {
      // A transcript that cannot be staged is a worse evidence set, not a
      // worse outcome. The storage below is the larger half of the answer.
    }

    for (const { key, path } of this.#roots.directories()) {
      staged.push({ name: `b2-root-${key}`, path })
    }
    return staged
  }

  /**
   * Remove the per-root storage these temp projects accumulated.
   *
   * Run on every path, pass or fail, and on the failing path only after the
   * evidence has been copied. The roots are directories under the user's own
   * storage named after projects that will never exist again; nothing else in
   * the system can ever decide to collect them, because the registry
   * deliberately stores a hash and a timestamp and never a path.
   *
   * What it removed comes back so a caller can assert on it. Nothing in the
   * report carries it: a count of directories collected is housekeeping about
   * the gate rather than evidence about the tool.
   */
  clean(): string[] {
    return this.#roots.clean()
  }
}

/**
 * Whether a path inside a driven root is worth copying into the store.
 *
 * `DerivedData` is the exclusion, and it is not a size heuristic: it is
 * `xcodebuild`'s own cache, regenerable from the project by definition, and on
 * an ordinary machine it is two orders of magnitude larger than everything
 * beside it. A set that carried it would fail the whole-budget check and be
 * discarded, so keeping it is the same as keeping nothing.
 */
export function worthKeeping(path: string): boolean {
  return !path.split(sep).includes(RUN_ARTIFACTS.derivedData)
}
