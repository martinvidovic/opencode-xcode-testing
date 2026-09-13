/**
 * The controllable stub process (ADR 0001, Layer 2).
 *
 * Real `xcodebuild` cannot be asked to hang, ignore `SIGINT`, or leave an
 * orphan behind on demand — but every one of those is a case #3's supervision
 * machinery has to get right. This stub can, deterministically, so the
 * machinery is proven without ever waiting on Xcode.
 *
 * Usage: `stub-process.ts [--children=N] [--trap=SIGINT,SIGTERM]
 *        [--linger-ms=N] [--exit=N] [--sleep-ms=N]`
 */

import { spawn } from "node:child_process"

type Options = {
  children: number
  trap: string[]
  lingerMs: number
  exitCode: number
  sleepMs: number
  isChild: boolean
}

export function parseOptions(argv: string[]): Options {
  const value = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1]

  return {
    children: Number.parseInt(value("children") ?? "0", 10),
    trap: (value("trap") ?? "").split(",").filter((part) => part.length > 0),
    lingerMs: Number.parseInt(value("linger-ms") ?? "0", 10),
    exitCode: Number.parseInt(value("exit") ?? "0", 10),
    sleepMs: Number.parseInt(value("sleep-ms") ?? "0", 10),
    isChild: argv.includes("--child"),
  }
}

function run(options: Options): void {
  // Both streams share one inherited descriptor, so this ordering is the
  // ordering the captured log must show.
  process.stdout.write(`stub ${process.pid} started\n`)

  for (const signal of options.trap) {
    // A trapped signal is observed and deliberately not obeyed, which is what
    // forces the supervisor to escalate rather than stop at SIGINT.
    process.on(signal as NodeJS.Signals, () => {
      process.stdout.write(`stub ${process.pid} trapped ${signal}\n`)
    })
  }

  for (let index = 0; index < options.children; index += 1) {
    // Children inherit the process group, so they are what makes
    // `descendantsConfirmedExited` something other than a formality.
    spawn(process.execPath, [import.meta.path, "--child", `--sleep-ms=${options.lingerMs}`], {
      stdio: ["ignore", 1, 2],
    }).unref()
  }

  const stayAlive = options.sleepMs > 0 ? options.sleepMs : 0
  setTimeout(() => {
    process.stdout.write(`stub ${process.pid} exiting ${options.exitCode}\n`)
    process.exit(options.exitCode)
  }, stayAlive)
}

run(parseOptions(process.argv.slice(2)))
