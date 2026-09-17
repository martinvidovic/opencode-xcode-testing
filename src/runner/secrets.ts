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
import { join } from "node:path"

import { readPrivateBytes, UnsafeArtifactError, writePrivateFileAtomic, type Storage } from "./paths.ts"

export const SECRET_BYTES = 32

export function cursorSecretPath(storage: Storage): string {
  return join(storage.rootDir, "cursor.key")
}

/** Read the root's cursor secret, creating one on first use. */
export function loadCursorSecret(storage: Storage): Buffer {
  const path = cursorSecretPath(storage)

  const existing = readExistingSecret(path)
  if (existing !== undefined) return existing

  // Losing an old secret only invalidates outstanding cursors, which is a
  // recoverable state — reusing one this tool cannot vouch for would not be.
  const secret = randomBytes(SECRET_BYTES)
  writePrivateFileAtomic(path, secret)
  return secret
}

/**
 * The secret at `path`, if that path holds one this tool can vouch for.
 *
 * Everything is decided about the opened object, never about the name: a name
 * that is checked and then read is resolved twice, and between the two
 * resolutions it can stop meaning the same file — which for a signing key
 * means being handed one somebody else chose.
 *
 * `undefined` says "write a fresh key over whatever is there", and only the
 * states that answer to that are converted into it: absent, and everything
 * `readPrivateBytes` refuses — a symlink, a directory, a file readable beyond
 * its owner, a file of the wrong size. A key we are not permitted to read is
 * among them, because a root whose key cannot be opened is otherwise unusable
 * for ever. Anything else — a full descriptor table, an I/O error — is raised:
 * those say nothing about the key, and silently replacing it on one would
 * invalidate every live cursor for a condition that will pass.
 */
function readExistingSecret(path: string): Buffer | undefined {
  try {
    return readPrivateBytes(path, SECRET_BYTES)
  } catch (error) {
    if (replaceable(error)) return undefined
    throw error
  }
}

function replaceable(error: unknown): boolean {
  if (error instanceof UnsafeArtifactError) return true
  const code = (error as { code?: string } | null)?.code
  return code === "ENOENT" || code === "EACCES" || code === "EPERM"
}
