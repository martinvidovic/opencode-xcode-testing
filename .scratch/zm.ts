import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestToolService } from "../src/adapter/service.ts"
import { isTestRunSummary } from "../src/domain/result.ts"
import { prepareStorage, storageFor } from "../src/runner/paths.ts"
import { loadCursorSecret } from "../src/runner/secrets.ts"
import { resolveToolchain } from "../src/runner/toolchain.ts"
import { discoverDestination } from "../scripts/gate/destination.ts"
import { FIXTURE, generate } from "../scripts/generate-fixture-project.ts"
import { readProjectConfiguration } from "../src/adapter/trusted-root.ts"

const toolchain = resolveToolchain()
if (toolchain.status !== "resolved") throw new Error("no toolchain")
const destination = discoverDestination()
if (destination.status !== "found") throw new Error("no destination")

const workspace = mkdtempSync(join(tmpdir(), "zm-"))
const homeDir = join(workspace, "home")
mkdirSync(homeDir, { recursive: true })
const tree = generate({ out: join(workspace, "passing"), variant: "passing" })
const root = tree.root
mkdirSync(join(root, ".opencode"), { recursive: true })
writeFileSync(
  join(root, ".opencode", "xcode-test.json"),
  `${JSON.stringify({ schemaVersion: 1, scheme: FIXTURE.scheme, destination: destination.destination }, null, 2)}\n`,
)

const storage = storageFor(homeDir, root)
prepareStorage(storage)

const service = createTestToolService({
  storage,
  trustedRoot: root,
  homeDir,
  toolchain: toolchain.identity,
  runtime: { path: process.execPath },
  supervisorEntrypoint: join(import.meta.dir, "..", "src", "runner", "supervisor-entry.ts"),
  now: () => Date.now(),
  timestamp: () => new Date().toISOString(),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  freeBytes: () => Number.MAX_SAFE_INTEGER,
  cursorSecret: loadCursorSecret(storage),
  configuration: readProjectConfiguration(root),
} as never)

const rounds = Number(process.argv[2] ?? "1")
for (let i = 0; i < rounds; i += 1) {
  const result = await service.start(
    { requestedScope: { kind: "selected", tests: [{ bundle: FIXTURE.testTarget, suite: "NoSuchSuiteExists" }] } },
    { onState: () => {} },
  ).result
  const r = result as { outcome: string; reason?: string; message?: string }
  console.log(`${i + 1}: ${r.outcome}${r.reason ? "/" + r.reason : ""} — ${r.message ?? ""}`)
}
rmSync(workspace, { recursive: true, force: true })
