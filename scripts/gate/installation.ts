/**
 * The documented installation paths, exercised (issues #27, #142, #143).
 *
 * The README's installation instructions are load-bearing, and they have been
 * wrong before in the quietest possible way: a plugin that never loads is
 * indistinguishable from a project that never opted in. So the instructions
 * are executed rather than reviewed — against an isolated V2 host whose config
 * directory belongs to this run, never the reader's own.
 *
 * Both documented forms, each against a **clean checkout**: a copy of this
 * repository's files with no `node_modules` at all. That is the claim the
 * README makes — the host supplies `@opencode/plugin` to the plugin at
 * runtime (issue #140), so loading needs nothing installed — and a copy
 * without the packages is the only way to show it rather than assume it.
 *
 * - The `plugins` entry naming the checkout directory, which resolves to its
 *   root `server.ts`.
 * - The plugin's entry file symlinked into the config directory's plural
 *   `plugins/`.
 *
 * Success is judged by what a model is offered, because V2 has no route that
 * lists tools.
 */

import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { safeFailure } from "../../src/adapter/sanitize.ts"
import type { DrivenRoots } from "./driven-roots.ts"
import { baseHostConfig, bootHost, hostConfigDirectory, loadClient, observedHostVersion, type HostClient } from "./host.ts"
import type { ScenarioSink } from "./observations.ts"
import { readProvenance } from "./provenance.ts"
import { startStubProvider, type StubProvider } from "./provider.ts"
import type { ScenarioResult } from "./report.ts"
import { SCENARIO } from "./scenarios.ts"
import { offeredNames, scriptedTurn } from "./turn.ts"

const REPO = join(import.meta.dir, "..", "..")

type Form = {
  name: string
  /** Prepare the host's config directory, and return its config file. */
  install(checkout: string, configDirectory: string, stubBaseURL: string): Record<string, unknown>
}

const FORMS: readonly Form[] = [
  {
    name: "a `plugins` entry naming the checkout",
    install: (checkout, _configDirectory, stubBaseURL) => ({ ...baseHostConfig(stubBaseURL), plugins: [checkout] }),
  },
  {
    name: "the entry file symlinked into `plugins/`",
    install: (checkout, configDirectory, stubBaseURL) => {
      const plugins = join(configDirectory, "plugins")
      mkdirSync(plugins, { recursive: true })
      symlinkSync(join(checkout, "src", "adapter", "plugin.ts"), join(plugins, "xcode-test.ts"))
      return baseHostConfig(stubBaseURL)
    },
  },
]

/** Records its one scenario as it finishes; see `ScenarioSink`. */
export async function runInstallationGate(record: ScenarioSink, roots: DrivenRoots): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "xcode-test-install-"))
  const started = Date.now()
  let stub: StubProvider | undefined

  try {
    const loaded = await loadClient()
    if (loaded.status !== "loaded") {
      record(scenario(started, "failed", loaded.detail))
      return
    }

    const checkout = cleanCheckout(join(workspace, "checkout"))

    // Created before it is registered (issue #104): the host canonicalizes,
    // and a path that does not exist yet cannot be.
    const project = join(workspace, "project")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    roots.add(project)
    writeFileSync(join(project, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }\n')

    stub = startStubProvider()
    const failures: string[] = []
    for (const [index, form] of FORMS.entries()) {
      const hostWorkspace = join(workspace, `host-${index}`)
      mkdirSync(hostWorkspace)
      const config = form.install(checkout, hostConfigDirectory(hostWorkspace), stub.baseURL)
      const host = await bootHost({ workspace: hostWorkspace, config, cwd: project, connect: loaded.connect })
      try {
        const missing = await missingFrom(host.client, stub, project)
        if (missing.length > 0) failures.push(`${form.name} offered no ${missing.join(", ")}`)
      } finally {
        await host.stop()
      }
    }

    record(
      failures.length === 0
        ? scenario(
            started,
            "passed",
            `${FORMS.map((form) => form.name).join(" and ")} each offer the family from a clean checkout with no node_modules (packages here: ${checkoutPackages()})`,
          )
        : scenario(started, "failed", `installing the documented way did not work: ${failures.join("; ")}`),
    )
  } catch (error) {
    record(scenario(started, "failed", `the documented installation could not be exercised: ${safeFailure(error)}`))
  } finally {
    stub?.stop()
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function missingFrom(client: HostClient, stub: StubProvider, directory: string): Promise<string[]> {
  const offered = offeredNames(await scriptedTurn(client, stub, { directory }))
  return TOOL_IDS.filter((id) => !offered.includes(id))
}

/**
 * This repository's files, without anything an install would add.
 *
 * Tracked files and new ones git would commit, and nothing it ignores — so
 * no `node_modules`. Copied rather than cloned, so the check covers the
 * working tree under test rather than whatever was last committed.
 */
function cleanCheckout(destination: string): string {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 30_000,
  })
  if (listed.status !== 0) throw new Error(`the checkout's files could not be listed: ${safeFailure(new Error(listed.stderr ?? ""))}`)

  for (const file of listed.stdout.split("\0").filter((entry) => entry.length > 0)) {
    const target = join(destination, file)
    mkdirSync(dirname(target), { recursive: true })
    try {
      copyFileSync(join(REPO, file), target)
    } catch {
      // A tracked file deleted in the working tree is not part of it.
    }
  }
  return destination
}

/** The package versions this check ran against (issue #81). */
function checkoutPackages(): string {
  const { packages } = readProvenance(observedHostVersion())
  return `plugin ${packages.plugin.version ?? "unknown"}, client ${packages.client.version ?? "unknown"}`
}

function scenario(started: number, status: "passed" | "failed", detail: string): ScenarioResult {
  return {
    name: SCENARIO["b1 documented installation path"],
    kind: "gating",
    status,
    detail,
    durationMs: Date.now() - started,
  }
}
