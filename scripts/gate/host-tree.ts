/**
 * Where the host keeps the packages this repository borrows.
 *
 * A leaf on purpose. The config directory is a fact about OpenCode, not about
 * linking, reading provenance, or booting anything — and every one of those
 * needs it. Left where the linker declared it, the linker could not learn what
 * it had just linked without importing the module that imports it back.
 */

import { homedir } from "node:os"
import { join } from "node:path"

export const HOST_SCOPE = "@opencode-ai"

export function defaultConfigDirectory(home = homedir()): string {
  return join(home, ".config", "opencode")
}
