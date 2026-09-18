/**
 * Booting a headless OpenCode and asking what it registered (ADR 0002 (b1)).
 *
 * Two scenarios need this — the one that drives the host through the SDK, and
 * the one that executes the README's installation instructions — and they need
 * the same three things: a host that comes up with this plugin loaded, a
 * bounded wait for it, and the tool ids it ended up with. Written once, so the
 * boot timeout and the port cannot drift apart between them.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { safeFailure } from "../../src/adapter/sanitize.ts"
import { defaultConfigDirectory } from "./host-tree.ts"
import { gatePort, reportedPort } from "./ports.ts"
import { readProvenance } from "./provenance.ts"

/**
 * How long the host may take to come up with this plugin loaded.
 *
 * The SDK's own default is five seconds, which is a reasonable figure for a
 * bare server and not for this one: the host boots the plugin as part of
 * starting, and the plugin's startup probes a runtime by executing a
 * TypeScript file in a subprocess. The plugin bounds that work itself; this
 * number only says the gate is willing to wait for it rather than calling a
 * cold machine a registration failure.
 */
export const SERVER_BOOT_MS = 90_000

/**
 * How long any single host call may take before the gate gives up on it.
 *
 * A standing gate that can hang is not a gate — it is a job somebody
 * eventually notices and kills, and it reports nothing either way. So every
 * interaction with the host is bounded, and a call that overruns becomes a
 * scenario failure with a diagnostic rather than a wait with no end.
 */
export const HOST_CALL_MS = 30_000

/** Bound one host call, naming what was being asked when it overran. */
export async function bounded<T>(what: string, call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the host did not answer \`${what}\` within ${HOST_CALL_MS}ms`)),
          HOST_CALL_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type BootedHost = { port: number; stop(): Promise<void> }

/**
 * Start `opencode serve` against a config directory of our own choosing.
 *
 * Never the reader's own config: a gate that installed itself into somebody's
 * real OpenCode would be changing the machine it is supposed to be measuring.
 */
export async function bootHost(input: {
  configDirectory: string
  cwd: string
  /** Explicit only when a gate test must reproduce an occupied-port startup failure. */
  port?: number
}): Promise<BootedHost> {
  const requested = input.port ?? gatePort()
  const child = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", `--port=${requested}`],
    {
      cwd: input.cwd,
      env: { ...process.env, OPENCODE_CONFIG_DIR: input.configDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  // What it says it bound, not what it was asked for. `opencode serve` ignores
  // `--port=0` and falls back to its own default, so the request and the
  // answer are not the same fact — and every later call has to use the answer.
  let port: number
  try {
    port = await listening(child)
  } catch (error) {
    // A host that never finished starting is still a process, and on a port
    // (issue #125). Left alive it holds that port for the rest of the day and
    // makes the next invocation's failure a different one.
    await exited(child)
    throw error
  }
  return {
    port,
    // Awaited, not fired and forgotten (issue #104). Signalling a host and
    // returning says only that the signal was sent: the child is still there,
    // and the plugin inside it is still preparing storage for the trusted root
    // it resolved. That storage landed *after* the gate had swept, which is
    // how this suite left one directory behind per run — for a root the gate
    // had registered and cleaned a moment too early.
    stop: () => exited(child),
  }
}

/** The tool ids this host registered for that project directory. */
export async function toolIds(host: BootedHost, directory: string): Promise<string[]> {
  const response = await fetch(
    `http://127.0.0.1:${host.port}/experimental/tool/ids?directory=${encodeURIComponent(directory)}`,
    { signal: AbortSignal.timeout(HOST_CALL_MS) },
  )
  return (await response.json()) as string[]
}

/** Resolves with the port the host reported it is listening on. */
function listening(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(
      () => reject(new Error(`the host did not start within ${SERVER_BOOT_MS}ms`)),
      SERVER_BOOT_MS,
    )

    const settle = (error?: Error, port?: number) => {
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else if (port === undefined) {
        // It said it was listening and did not say where. Nothing later can
        // address it, and guessing the number it was asked for is how a gate
        // ends up talking to whatever else is there.
        reject(new Error("the host said it was listening without saying on which port"))
      } else resolve(port)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.includes("server listening")) settle(undefined, reportedPort(output))
    })
    // Kept only so a failure can quote it; the host writes diagnostics here.
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    child.on("error", (error) => settle(error))
    child.on("exit", (code) => settle(new Error(`the host exited with ${code ?? "no code"}`)))
  })
}


/**
 * The host version the gate actually ran against. Recorded rather than
 * asserted: ADR 0002's policy is to surface skew, never to block on it.
 */
export function observedHostVersion(): string {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  const version = (result.stdout ?? "").trim()
  return result.status === 0 && version.length > 0 ? version : "unknown"
}

// --- the host-managed SDK ---------------------------------------------------

/**
 * The part of the OpenCode SDK these gates use.
 *
 * Declared rather than assumed. The module is imported from the host's own
 * installation at run time, so nothing checks it for us — and `as Sdk` against
 * an identifier that was never defined checked exactly as much (issue #80).
 * Bun strips types rather than checking them, so that read as working code.
 */
export type Sdk = {
  createOpencode(options: {
    port: number
    timeout?: number
    config: Record<string, unknown>
  }): Promise<{ client: OpencodeClient; server: { close(): void } }>
}

/**
 * The part of the host's client these gates call, derived from the calls.
 *
 * Narrow on purpose, and narrow with a cost: it is this repository's reading
 * of somebody else's type, so it can be *wrong* in a way nothing here would
 * notice. What it buys is that a call this gate makes and the SDK no longer
 * offers is a mistake where it is written. What it does not buy is any
 * assurance that the shapes are right — `loadSdk` checks one function exists,
 * and the acceptance gate booting a real host is what checks the rest.
 */
export type OpencodeClient = {
  session: {
    create(input: unknown): Promise<{ data?: { id: string } }>
    prompt(input: unknown): Promise<unknown>
    messages(input: unknown): Promise<{ data?: Array<{ parts?: MessagePart[] }> }>
  }
  tool: {
    ids(input: { query: { directory: string } }): Promise<{ data?: string[] }>
    list(input: unknown): Promise<{
      data?: Array<{ id: string; description?: string; parameters?: unknown }>
    }>
  }
  app: {
    agents(input: { query: { directory: string } }): Promise<{
      data?: Array<Record<string, unknown>>
    }>
  }
}

/**
 * One part of a host message, as the execution gate reads them.
 *
 * `type` and `tool` are how a tool call is picked out of a turn; `state` is
 * where the tool's own answer ends up. Nothing else here is read, so nothing
 * else is declared.
 */
export type MessagePart = {
  type: string
  tool?: string
  state?: { status?: string; output?: string; error?: string }
}

/**
 * What became of the attempt to load the SDK.
 *
 * Three answers, not two. "It is not installed" is a machine nobody has set
 * up; "it is there and would not load" is a machine whose host packages are
 * broken; "it loaded and does not fit" is a third. All three fail their gate,
 * and a reader fixing one does something different from a reader fixing
 * another — which is the whole reason to tell them apart.
 */
export type SdkLoad = { status: "loaded"; sdk: Sdk } | { status: "unusable"; detail: string }

/**
 * Load the host-managed SDK, or say why not.
 *
 * The SDK is host-managed test infrastructure rather than a repository
 * dependency, so it is resolved from the host's own config directory.
 *
 * Nothing here escapes (issue #80). A dynamic import runs another package's
 * top-level code, which may throw for any reason it likes — and a throw from
 * this line used to leave the gate that called it, and then the suite,
 * cancelling peers that have nothing to do with the SDK.
 */
export async function loadSdk(): Promise<SdkLoad> {
  const candidate = join(
    defaultConfigDirectory(),
    "node_modules",
    "@opencode-ai",
    "sdk",
    "dist",
    "index.js",
  )

  if (!existsSync(candidate)) {
    return {
      status: "unusable",
      detail:
        "@opencode-ai/sdk was not found under the OpenCode config directory; the gate looked there because the SDK is host-managed test infrastructure rather than a repository dependency.",
    }
  }

  let module: unknown
  try {
    module = await import(candidate)
  } catch (error) {
    // Sanitized: an import error quotes the module's own absolute path, and
    // that path is under the user's home by construction.
    return {
      status: "unusable",
      detail: `@opencode-ai/sdk was found under the OpenCode config directory but could not be imported: ${safeFailure(error)}.`,
    }
  }

  // A module that loaded is not a module that fits. Called through a cast this
  // failed later, inside the host boot, and was reported as a host that would
  // not start — which is a different machine to go and look at.
  if (!isSdk(module)) {
    return {
      status: "unusable",
      detail:
        "@opencode-ai/sdk was found under the OpenCode config directory but does not export `createOpencode`.",
    }
  }

  return { status: "loaded", sdk: module }
}

function isSdk(value: unknown): value is Sdk {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Sdk).createOpencode === "function"
  )
}

/**
 * The one wording for a checkout whose host package is not linked.
 *
 * Both gates hit it and both said the same thing in their own words, which is
 * one edit away from saying two different things about one condition.
 */
export const PLUGIN_NOT_LINKED =
  "@opencode-ai/plugin is not resolvable from this checkout, so the plugin would fail to load silently. Run `bun scripts/link-host-package.ts`."

/**
 * Why this package tree cannot be drawn conclusions from, if it cannot (#81).
 *
 * Checked before a gate boots anything, because a tree that disagrees with
 * itself makes the run unattributable: whatever it proves, it proves about a
 * package set nobody could name afterwards, and the next install in that
 * directory changes it.
 *
 * Only the answers that make the run meaningless. A supported-but-stale tree
 * is the ordinary state of a host-managed install and is surfaced in the
 * report as a caveat instead — failing on it would make the gate unrunnable
 * on a machine whose only problem is an install nobody has re-run in a
 * directory this repository does not own.
 */
export function provenanceProblem(hostVersion: string): string | undefined {
  const { problems } = readProvenance(hostVersion)
  if (problems.length === 0) return undefined
  return `the OpenCode packages this gate would run against cannot be relied on. ${problems.join(" ")}`
}

/**
 * Kill a host and wait for it to be gone.
 *
 * Bounded, because a child that will not die must not hold the gate open for
 * ever — and a host that outlives its bound is a host whose storage may still
 * appear afterwards, which the report will show as a directory nobody claimed
 * rather than as a silence.
 */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, HOST_EXIT_MS)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill("SIGKILL")
  })
}

/** How long a killed host has to actually go. */
const HOST_EXIT_MS = 5_000
