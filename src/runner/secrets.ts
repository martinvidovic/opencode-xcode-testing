/**
 * The durable root-local secret that opaque cursors are derived from (#3).
 *
 * It has to be durable, not per-process: a cursor issued before a restart must
 * still be classifiable afterwards, or every crash would silently turn valid
 * cursors into `invalid` ones and a caller would have no way to tell that from
 * a tampered token.
 *
 * It is owner-only data retained for at least the maximum run and tombstone
 * lifetime, which is why it lives beside the run store rather than in memory.
 */

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { assertSafeFile, writePrivateFileAtomic, type Storage } from "./paths.ts"

export const SECRET_BYTES = 32

export function cursorSecretPath(storage: Storage): string {
  return join(storage.rootDir, "cursor.key")
}

/** Read the root's cursor secret, creating one on first use. */
export function loadCursorSecret(storage: Storage): Buffer {
  const path = cursorSecretPath(storage)

  try {
    assertSafeFile(path)
    const existing = readFileSync(path)
    if (existing.length === SECRET_BYTES) return existing
  } catch {
    // Absent, unreadable, or unsafe: a fresh secret is written below. Losing an
    // old one only invalidates outstanding cursors, which is a recoverable
    // state — reusing an unsafe one would not be.
  }

  const secret = randomBytes(SECRET_BYTES)
  writePrivateFileAtomic(path, secret)
  return secret
}
