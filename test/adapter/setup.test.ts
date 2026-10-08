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
