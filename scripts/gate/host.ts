/**
 * Booting an isolated OpenCode V2 host and driving it (issue #142).
 *
 * Every acceptance scenario that needs a real host needs the same things: a
 * host that comes up with this plugin configured, a bounded wait for it, proof
 * that the server answering is the one this gate started, and an
 * authenticated client. Written once, so none of that drifts between suites.
 *
 * **Never the user's own OpenCode.** V2 runs a shared background service that
 * the user's terminals attach to; a gate that attached to it, configured it
 * or stopped it would be changing the machine it is supposed to be measuring.
 * So the gate spawns `opencode serve` itself — never `--service`, never
 * `Service.ensure()` — with private `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
 * `XDG_STATE_HOME` and `XDG_CACHE_HOME`, and a password of its own. `HOME`
 * is deliberately the real one: Xcode and the simulators live there, and on
 * 2.0.25 the XDG directories alone keep the user's configuration and plugins
 * out (issue #140).
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { OpenCodeClient } from "@opencode/client"

import { safeFailure } from "../../src/adapter/sanitize.ts"
import { reportedPort } from "./ports.ts"
import { missingPackages, readProvenance } from "./provenance.ts"

/**
 * How long the host may take to come up.
 *
 * Generous on purpose: a cold first start bootstraps a database and may build
 * caches. The gate is willing to wait for that rather than calling a cold
 * machine a registration failure.
 */
export const SERVER_BOOT_MS = 90_000

/**
 * How long any single host call may take before the gate gives up on it.
 *
 * A standing gate that can hang is not a gate — it is a job somebody
 * eventually notices and kills, and it reports nothing either way.
 */
export const HOST_CALL_MS = 30_000

/** How long one scripted turn may take, end to end, including a real Test Run. */
export const TURN_MS = 15 * 60_000

/** Bound one host call, naming what was being asked when it overran. */
export async function bounded<T>(what: string, call: Promise<T>, ms = HOST_CALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the host did not answer \`${what}\` within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// --- the client the gates use ----------------------------------------------

/**
 * The part of `@opencode/client` these gates call.
 *
 * Narrow, so a test can stand in for it; and checked against the real client
 * below, so a call the client no longer offers is a type error here rather
 * than a surprise inside a booted host.
 */
export type HostClient = {
  server: { info(): Promise<{ version: string; pid: number }> }
  plugin: {
    list(input: { location: { directory: string } }): Promise<{
      data: ReadonlyArray<{ id?: string; state: { status: string } }>
    }>
  }
  agent: {
    get(input: { agentID: string; location: { directory: string } }): Promise<{
      data: { permissions: ReadonlyArray<{ action: string; resource: string; effect: string }> }
    }>
  }
  session: {
    create(input: {
      agent?: string
      model: { id: string; providerID: string }
      location: { directory: string }
    }): Promise<{ id: string }>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<ReadonlyArray<unknown>>
  }
}

// Compile-time only: the real client must be usable wherever a `HostClient`
// is expected.
type Satisfies<T extends HostClient> = T
export type VerifiedClient = Satisfies<OpenCodeClient>

export type ClientLoad =
  | { status: "loaded"; connect(baseUrl: string, password: string): HostClient }
  | { status: "unusable"; detail: string }

/**
 * Load `@opencode/client`, or say why not.
 *
 * It is this checkout's own pinned dependency now, not a module found under
 * somebody's config directory — but it is still imported dynamically, so a
 * checkout nobody has installed fails a gate with the command that fixes it
 * instead of failing the whole run at module load.
 */
export async function loadClient(): Promise<ClientLoad> {
  const missing = missingPackages()
  if (missing !== undefined) return { status: "unusable", detail: missing }

  try {
    const module = (await import("@opencode/client")) as typeof import("@opencode/client")
    return {
      status: "loaded",
      connect: (baseUrl, password) =>
        module.OpenCode.make({ baseUrl, headers: { authorization: basicAuth(password) } }) as unknown as HostClient,
    }
  } catch (error) {
    return { status: "unusable", detail: `@opencode/client could not be imported: ${safeFailure(error)}` }
  }
}

/** HTTP Basic for the isolated host's own password; the user is `opencode`. */
export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

// --- booting ----------------------------------------------------------------

export type HostLauncher = (input: { command: string; arguments: string[]; options: SpawnOptions }) => ChildProcess

export type BootedHost = {
  port: number
  baseUrl: string
  /** The server's own answer to `server.info`, checked against the child. */
  version: string
  client: HostClient
  /** Rewrite the host's global config. A watched file: the host reloads it. */
  configure(config: Record<string, unknown>): void
  /** Everything the host has written to stdout and stderr so far. */
  output(): string
  stop(): Promise<void>
}

/**
 * Start an isolated `opencode serve` and connect to it.
 *
 * Readiness is two facts, both required: the child **this gate spawned** says
 * where it is listening, and the server answering there reports **that
 * child's pid**. A stale listener from an earlier run cannot satisfy the
 * second — so it cannot be mistaken for the host, however it got its port.
 */
export async function bootHost(
  input: {
    /** A directory this run owns; the host's XDG directories go beneath it. */
    workspace: string
    config: Record<string, unknown>
    cwd: string
    connect: (baseUrl: string, password: string) => HostClient
  },
  launch: HostLauncher = ({ command, arguments: args, options }) => spawn(command, args, options),
): Promise<BootedHost> {
  const xdg = isolatedDirectories(input.workspace)
  const configPath = join(xdg.XDG_CONFIG_HOME, "opencode", "opencode.json")
  const configure = (config: Record<string, unknown>) => writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  configure(input.config)

  const password = randomBytes(24).toString("base64url")
  const child = launch({
    command: "opencode",
    // `--port 0` is honoured on V2 (issue #140): the kernel picks, so no two
    // runs can be handed the same number, and the answer is read back below.
    arguments: ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    options: {
      cwd: input.cwd,
      env: { ...hostEnvironment(), ...xdg, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    },
  })

  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")))

  try {
    const port = await listening(child, () => output)
    const baseUrl = `http://127.0.0.1:${port}`
    const client = input.connect(baseUrl, password)

    const info = await bounded("server.info", client.server.info())
    if (info.pid !== child.pid) {
      throw new Error(
        `the server answering on port ${port} reports pid ${info.pid}, not the host this gate started (${child.pid ?? "no pid"})`,
      )
    }

    return { port, baseUrl, version: info.version, client, configure, output: () => output, stop: () => exited(child) }
  } catch (error) {
    // A host that never finished starting is still a process (issue #125).
    // Left alive it holds its port and makes the next run's failure a
    // different one.
    await exited(child)
    throw error
  }
}

/**
 * This process's environment, without anything that would point a host at
 * the user's own configuration or service.
 */
function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  return env
}

function isolatedDirectories(workspace: string): Record<"XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME", string> {
  const root = join(workspace, "host")
  const directories = {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  }
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true })
  mkdirSync(join(directories.XDG_CONFIG_HOME, "opencode"), { recursive: true })
  return directories
}

/** The config directory an isolated host under `workspace` reads. */
export function hostConfigDirectory(workspace: string): string {
  return join(workspace, "host", "config", "opencode")
}

/** Resolves with the port the child reported it is listening on. */
function listening(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the host did not start within ${SERVER_BOOT_MS}ms`)), SERVER_BOOT_MS)

    const settle = (error?: Error, port?: number) => {
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else if (port === undefined) {
        // It said it was listening and did not say where. Guessing is how a
        // gate ends up talking to whatever else is there.
        reject(new Error("the host said it was listening without saying on which port"))
      } else resolve(port)
    }

    child.stdout?.on("data", () => {
      if (output().includes("server listening")) settle(undefined, reportedPort(output()))
    })
    child.on("error", (error) => settle(error))
    child.on("close", (code) =>
      settle(new Error(`the host exited with ${code ?? "no code"}: ${safeFailure(new Error(output()))}`)),
    )
  })
}

/**
 * The host version on `PATH`, before anything boots.
 *
 * `opencode --version` answers `opencode v2.0.25`; the number is what is
 * recorded. Recorded rather than asserted: the policy is to surface skew,
 * never to block on it.
 */
export function observedHostVersion(): string {
  const result = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  const match = /(\d+\.\d+\.\d+\S*)/.exec(result.stdout ?? "")
  return result.status === 0 && match?.[1] !== undefined ? match[1] : "unknown"
}

/**
 * Why this checkout's packages cannot be drawn conclusions from, if they
 * cannot (#81). Checked before a gate boots anything.
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
 * ever.
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
