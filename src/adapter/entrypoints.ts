/**
 * Files the plugin runs by path rather than by import.
 *
 * A static import graph cannot protect a file that is only ever handed to a
 * runtime by name, so each of these is one structural verification checks is
 * there before any tools are registered (ADR 0002).
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "runner")

/** Spawned as its own process for every Test Run, so it outlives the host. */
export const SUPERVISOR_ENTRYPOINT = join(RUNNER, "supervisor-entry.ts")

/** Started on a worker thread for user-wide housekeeping (issue #153). */
export const HOUSEKEEPING_ENTRYPOINT = join(RUNNER, "housekeeping-entry.ts")
