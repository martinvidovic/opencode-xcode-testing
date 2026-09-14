/**
 * Booting a headless OpenCode and asking what it registered (ADR 0002 (b1)).
 *
 * Two scenarios need this — the one that drives the host through the SDK, and
 * the one that executes the README's installation instructions — and they need
 * the same three things: a host that comes up with this plugin loaded, a
 * bounded wait for it, and the tool ids it ended up with. Written once, so the
 * boot timeout and the port cannot drift apart between them.
 */

import { spawn } from "node:child_process"

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

export type BootedHost = { port: number; stop(): void }

/**
 * Start `opencode serve` against a config directory of our own choosing.
 *
 * Never the reader's own config: a gate that installed itself into somebody's
 * real OpenCode would be changing the machine it is supposed to be measuring.
 */
export async function bootHost(input: {
  port: number
  configDirectory: string
  cwd: string
}): Promise<BootedHost> {
  const child = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", `--port=${input.port}`],
    {
      cwd: input.cwd,
      env: { ...process.env, OPENCODE_CONFIG_DIR: input.configDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  await listening(child)
  return { port: input.port, stop: () => child.kill("SIGKILL") }
}

/** The tool ids this host registered for that project directory. */
export async function toolIds(host: BootedHost, directory: string): Promise<string[]> {
  const response = await fetch(
    `http://127.0.0.1:${host.port}/experimental/tool/ids?directory=${encodeURIComponent(directory)}`,
    { signal: AbortSignal.timeout(HOST_CALL_MS) },
  )
  return (await response.json()) as string[]
}

function listening(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ""
    const timer = setTimeout(
      () => reject(new Error(`the host did not start within ${SERVER_BOOT_MS}ms`)),
      SERVER_BOOT_MS,
    )

    const settle = (error?: Error) => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.includes("server listening")) settle()
    })
    // Kept only so a failure can quote it; the host writes diagnostics here.
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    child.on("error", (error) => settle(error))
    child.on("exit", (code) => settle(new Error(`the host exited with ${code ?? "no code"}`)))
  })
}
