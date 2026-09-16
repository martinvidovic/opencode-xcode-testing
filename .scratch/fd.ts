import { createWriteStream, openSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

async function trial(label: string, usePath: boolean, autoClose: boolean): Promise<string> {
  const p = join(tmpdir(), `fdtest-${Math.random().toString(16).slice(2)}.json`)
  const fd = openSync(p, "wx", 0o600)
  const sink = createWriteStream(usePath ? p : "", { fd, autoClose })
  const errors: string[] = []
  sink.on("error", (e) => errors.push(String(e)))
  sink.write("x".repeat(1000))
  await new Promise<void>((r) => sink.end(() => r()))
  // What production does next: destroy, then unlink.
  sink.destroy()
  rmSync(p, { force: true })
  await new Promise((r) => setTimeout(r, 50))
  rmSync(p, { force: true })
  return `${label}: errors=[${errors.join("|")}]`
}

for (let i = 0; i < 3; i += 1) {
  console.log(await trial("path+autoClose", true, true))
  console.log(await trial("nopath+autoClose", false, true))
  console.log(await trial("path+noAutoClose", true, false))
}
