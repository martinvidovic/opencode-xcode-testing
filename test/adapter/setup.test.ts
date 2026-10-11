/**
 * Plugin setup, with no host (issue #141).
 *
 * Everything `setup(ctx)` decides — whether this Location gets any tools at
 * all, and what it says when it cannot — happens in `prepareTools`, which
 * takes the three host handles it needs as plain data. Each case below is one
 * that fails *quietly* if it fails: a session that simply has no Xcode tools in
 * it, or one that has them and should not.
 *
 * And `setup` must never throw. A throw marks the plugin `failed` on the host
 * with its full stack, private paths included, readable by any client that
 * lists plugins (issue #140).
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOL_IDS } from "../../src/adapter/descriptions.ts"
import { prepareTools, type HostHandles } from "../../src/adapter/setup.ts"
import type { ToolchainProbe } from "../../src/runner/toolchain.ts"

type Sandbox = { root: string; home: string; lines: string[]; dispose(): void }

function sandbox(marked: boolean): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "xcode-test-setup-"))
  const root = join(base, "project")
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, ".opencode"), { recursive: true })
  if (marked) writeFileSync(join(root, ".opencode", "xcode-test.json"), '{ "schemaVersion": 1 }')
  return { root, home, lines: [], dispose: () => rmSync(base, { recursive: true, force: true }) }
}

function host(root: string, overrides: Partial<HostHandles> = {}): HostHandles {
  return {
    location: { directory: root, project: { directory: root, canonical: root } },
    version: "2.0.25",
    options: {},
    ...overrides,
  }
}

async function within<T>(marked: boolean, work: (box: Sandbox) => Promise<T>): Promise<T> {
  const box = sandbox(marked)
  try {
    return await work(box)
  } finally {
    box.dispose()
  }
}

describe("a Location with no enablement marker", () => {
  test("gets no tools and hears nothing", async () => {
    await within(false, async (box) => {
      const tools = await prepareTools(host(box.root), { homeDir: box.home, write: (line) => box.lines.push(line) })
      expect(tools).toEqual([])
      expect(box.lines).toEqual([])
    })
  })

  test("stays silent even when the Location does not exist", async () => {
    await within(false, async (box) => {
      const tools = await prepareTools(host(join(box.root, "gone")), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
      })
      expect(tools).toEqual([])
      expect(box.lines).toEqual([])
    })
  })
})

describe("an enabled Location", () => {
  test("gets exactly the three tools", async () => {
    await within(true, async (box) => {
      const tools = await prepareTools(host(box.root), { homeDir: box.home, write: (line) => box.lines.push(line) })
      expect(tools.map((tool) => tool.name)).toEqual([...TOOL_IDS])
    })
  })

  test("says nothing about a tested host", async () => {
    await within(true, async (box) => {
      await prepareTools(host(box.root), { homeDir: box.home, write: (line) => box.lines.push(line) })
      expect(box.lines.filter((line) => line.includes("tested against"))).toEqual([])
    })
  })

  test("warns once about an untested host and loads anyway", async () => {
    await within(true, async (box) => {
      const tools = await prepareTools(host(box.root, { version: "2.1.0" }), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
      })
      expect(tools).toHaveLength(3)
      expect(box.lines.filter((line) => line.includes("2.1.0"))).toHaveLength(1)
    })
  })

  test("announces declared output limits it cannot read, rather than guessing quietly", async () => {
    await within(true, async (box) => {
      const tools = await prepareTools(host(box.root, { options: { tool_output: "loud" } }), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
      })
      expect(tools).toHaveLength(3)
      expect(box.lines.some((line) => line.includes("tool_output"))).toBe(true)
    })
  })
})

describe("a startup failure", () => {
  test("registers nothing when the checkout is incomplete, and says so", async () => {
    await within(true, async (box) => {
      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        requiredFiles: () => [join(box.root, "missing-supervisor-entry.ts")],
        write: (line) => box.lines.push(line),
      })
      expect(tools).toEqual([])
      expect(box.lines).toHaveLength(1)
      expect(box.lines[0]).toStartWith("xcode-test: ")
    })
  })

  test("is contained rather than thrown, and names no private path", async () => {
    await within(true, async (box) => {
      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        requiredFiles: () => {
          throw new Error(`EACCES: permission denied, open '${box.home}/secret'`)
        },
        write: (line) => box.lines.push(line),
      })
      expect(tools).toEqual([])
      expect(box.lines).toHaveLength(1)
      expect(box.lines[0]).not.toContain(box.home)
    })
  })
})

describe("a toolchain probe that never answers (issue #153)", () => {
  test("does not hold setup past the startup deadline", async () => {
    await within(true, async (box) => {
      const deadlineMs = 400
      const started = performance.now()

      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        startupDeadlineMs: deadlineMs,
        // Hangs, and ignores being abandoned: the worst probe there is. What
        // bounds setup has to be startup's deadline, not the probe's manners.
        toolchainProbe: () => new Promise(() => {}),
      })

      // A small fixed margin over the deadline: the bounded items are raced
      // against it, then setup builds its definitions and returns.
      expect(performance.now() - started).toBeLessThan(deadlineMs + 1_000)
      // Still registered, so a caller is told what is wrong instead of finding
      // no Xcode tools at all.
      expect(tools.map((tool) => tool.name)).toEqual([...TOOL_IDS])
      expect(box.lines.join("\n")).toContain("toolchain discovery did not finish")
    })
  })
})

/**
 * A healthy Xcode 27, answered without one: a developer directory under the
 * sandbox whose `xcresulttool` exists so it can be digested, and probes that
 * answer the way the real tools do. Or a machine with no Xcode selected.
 */
function scriptedXcode(box: Sandbox, selected = true): ToolchainProbe {
  const developerDirectory = join(box.home, "Xcode.app", "Contents", "Developer")
  mkdirSync(join(developerDirectory, "usr", "bin"), { recursive: true })
  writeFileSync(join(developerDirectory, "usr", "bin", "xcresulttool"), "binary")
  return async (command) => {
    if (command.endsWith("xcode-select")) {
      return selected ? { status: 0, stdout: `${developerDirectory}\n` } : { status: 2, stdout: "" }
    }
    if (command.endsWith("xcodebuild")) return { status: 0, stdout: "Xcode 27.0\nBuild version 27A266a\n" }
    return { status: 0, stdout: "xcresulttool version 24000, format version 3.53 (current), schema version: 0.1.0\n" }
  }
}

function textOf(result: { content: ReadonlyArray<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n")
}

async function recoverWith(tools: Awaited<ReturnType<typeof prepareTools>>): Promise<string> {
  const recover = tools.find((tool) => tool.name === "xcode_test_recover")
  if (recover === undefined) throw new Error("no recovery tool")
  return textOf(await recover.execute({}, {}))
}

describe("a runtime probe that times out at startup (issue #162)", () => {
  /** Hangs the first time it is asked about any candidate, then answers. */
  function hangingOnce() {
    let calls = 0
    let startupDone = false
    return {
      settle: () => {
        startupDone = true
      },
      calls: () => calls,
      probe: async () => {
        calls += 1
        if (!startupDone) return new Promise<never>(() => {})
        return { usable: true, version: "1.4.2" }
      },
    }
  }

  test("is reported as transient, with the way back named", async () => {
    await within(true, async (box) => {
      const runtime = hangingOnce()
      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        startupDeadlineMs: 400,
        runtimeProbe: runtime.probe,
        environment: {},
        toolchainProbe: scriptedXcode(box),
      })

      expect(tools.map((tool) => tool.name)).toEqual([...TOOL_IDS])
      expect(box.lines.join("\n")).toContain("could not be probed within the startup deadline")
      expect(box.lines.join("\n")).toContain("xcode_test_recover")
    })
  })

  test("is probed again by xcode_test_recover, which makes the tool available", async () => {
    await within(true, async (box) => {
      const runtime = hangingOnce()
      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        startupDeadlineMs: 400,
        runtimeProbe: runtime.probe,
        environment: {},
        toolchainProbe: scriptedXcode(box),
      })
      runtime.settle()

      const first = await recoverWith(tools)
      const probesAfterFirst = runtime.calls()
      const second = await recoverWith(tools)

      expect(first).toContain("probed again")
      expect(first).not.toContain("Recovery: failed")
      // Available now, so the second call is ordinary recovery and probes
      // nothing: the runtime answer is kept, not re-earned on every call.
      expect(second).not.toContain("probed again")
      expect(runtime.calls()).toBe(probesAfterFirst)
    })
  })
})

describe("a startup failure that is not a timeout (issue #162)", () => {
  test("of an explicitly configured runtime is permanent, and recovery says so without probing", async () => {
    await within(true, async (box) => {
      writeFileSync(
        join(box.root, ".opencode", "xcode-test.json"),
        JSON.stringify({ schemaVersion: 1, runtime: "/nonexistent/bun" }),
      )
      const probed: string[] = []
      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        environment: {},
        toolchainProbe: scriptedXcode(box),
        runtimeProbe: async (candidate) => {
          probed.push(candidate)
          return { usable: false }
        },
      })

      const recovered = await recoverWith(tools)

      expect(box.lines.join("\n")).toContain("configured runtime could not execute a TypeScript file")
      expect(box.lines.join("\n")).not.toContain("xcode_test_recover")
      expect(recovered).toContain("Recovery: failed")
      expect(recovered).toContain("not a timeout")
      // Probed once at startup, never again — and never anything but the
      // configured path, which is what refusing a fallback means.
      expect(probed).toEqual(["/nonexistent/bun"])
    })
  })

  test("outranks a timeout beside it, since probing again cannot help", async () => {
    await within(true, async (box) => {
      let runtimeProbes = 0
      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        startupDeadlineMs: 400,
        environment: {},
        toolchainProbe: scriptedXcode(box, false),
        runtimeProbe: () => {
          runtimeProbes += 1
          return new Promise<never>(() => {})
        },
      })
      const probesAtStartup = runtimeProbes

      const recovered = await recoverWith(tools)

      expect(box.lines.join("\n")).toContain("no Xcode developer directory is selected")
      expect(recovered).toContain("not a timeout")
      expect(runtimeProbes).toBe(probesAtStartup)
    })
  })
})

describe("the Xcode developer directory (issue #164)", () => {
  /** A full Xcode under the sandbox, answering as `version` does, only when asked for by DEVELOPER_DIR. */
  function xcodeAt(box: Sandbox, version = "27.0") {
    const developerDirectory = join(box.home, "Xcode-27.app", "Contents", "Developer")
    mkdirSync(join(developerDirectory, "usr", "bin"), { recursive: true })
    writeFileSync(join(developerDirectory, "usr", "bin", "xcresulttool"), "binary")
    const ran: string[] = []
    const probe: ToolchainProbe = async (command, _args, env) => {
      ran.push(command.split("/").pop() ?? command)
      if (command.endsWith("xcode-select")) return { status: 0, stdout: "/Library/Developer/CommandLineTools\n" }
      if (env?.DEVELOPER_DIR !== developerDirectory) return { status: 1, stdout: "requires Xcode" }
      if (command.endsWith("xcodebuild")) return { status: 0, stdout: `Xcode ${version}\nBuild version 27A266a\n` }
      return { status: 0, stdout: "xcresulttool version 25115, schema version: 0.4.0\n" }
    }
    return { developerDirectory, probe, ran }
  }

  function configure(box: Sandbox, configuration: Record<string, unknown>) {
    writeFileSync(join(box.root, ".opencode", "xcode-test.json"), JSON.stringify({ schemaVersion: 1, ...configuration }))
  }

  test("is the configured one, with the system selection never consulted", async () => {
    await within(true, async (box) => {
      const xcode = xcodeAt(box)
      configure(box, { developerDirectory: xcode.developerDirectory })

      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        environment: {},
        toolchainProbe: xcode.probe,
      })

      expect(await recoverWith(tools)).not.toContain("Recovery: failed")
      expect(box.lines.join("\n")).not.toContain("xcodebuild")
      expect(xcode.ran).not.toContain("xcode-select")
    })
  })

  test("defaults to Command Line Tools here, and says how to choose a full Xcode", async () => {
    await within(true, async (box) => {
      const xcode = xcodeAt(box)

      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        environment: {},
        toolchainProbe: xcode.probe,
      })

      const said = box.lines.join("\n")
      expect(said).toContain("system Xcode selection")
      expect(said).toContain("developerDirectory")
      expect(said).toContain("DEVELOPER_DIR")
      expect(await recoverWith(tools)).toContain("not a timeout")
    })
  })

  test("is refused at setup when its Xcode is one this tool does not support", async () => {
    await within(true, async (box) => {
      const xcode = xcodeAt(box, "15.4")
      configure(box, { developerDirectory: xcode.developerDirectory })

      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        environment: {},
        toolchainProbe: xcode.probe,
      })

      // Before a Test Run is spent finding out: an unsupported Xcode's results
      // could only ever be refused after the run.
      const said = box.lines.join("\n")
      expect(said).toContain("Xcode 15.4 is not supported")
      expect(said).toContain("the configured developerDirectory")
      expect(await recoverWith(tools)).toContain("not a timeout")
    })
  })

  test("is never discovered from elsewhere while the configuration is invalid", async () => {
    await within(true, async (box) => {
      const xcode = xcodeAt(box)
      configure(box, { developerDirectory: "Xcode-27.app/Contents/Developer" })

      await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        environment: { DEVELOPER_DIR: xcode.developerDirectory },
        toolchainProbe: xcode.probe,
      })

      // Discovering from DEVELOPER_DIR here would make a typo in the setting
      // meant to choose the Xcode invisible behind one that worked.
      expect(xcode.ran).toEqual([])
      expect(box.lines.join("\n")).toContain("xcode-test.json")
    })
  })

  test("is the configured one again when a transient failure is probed again", async () => {
    await within(true, async (box) => {
      const xcode = xcodeAt(box)
      configure(box, { developerDirectory: xcode.developerDirectory })
      let startupOver = false
      const hangingUntilRecovery: ToolchainProbe = (command, args, env) =>
        startupOver ? xcode.probe(command, args, env) : new Promise<never>(() => {})

      const tools = await prepareTools(host(box.root), {
        homeDir: box.home,
        write: (line) => box.lines.push(line),
        startupDeadlineMs: 400,
        environment: {},
        toolchainProbe: hangingUntilRecovery,
      })
      startupOver = true

      expect(await recoverWith(tools)).toContain("probed again")
      expect(xcode.ran).not.toContain("xcode-select")
    })
  })
})
