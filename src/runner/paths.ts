/**
 * Runner-owned storage (#3).
 *
 * Everything the runner writes — Result Bundles, raw logs, isolated
 * DerivedData, metadata, locks, queue state, tombstones — lives outside the
 * repository, in a user-scoped root keyed by a hash of the canonical trusted
 * root. Two consequences follow, and both are deliberate: a `git clean` can
 * never destroy an in-flight run's evidence, and no public contract ever needs
 * to name a path.
 *
 * From the tool root downward every component is created owned-by-user with
 * `0700`/`0600` and is validated before use. Creation and access never follow
 * symlinks: a retained artifact reached through a link someone else controls is
 * not evidence.
 */

import { createHash, randomBytes } from "node:crypto"
import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  realpathSync,
} from "node:fs"
import { join } from "node:path"

export const TOOL_DIRECTORY = "opencode-xcode-test"

/** Fixed names inside a run's private directory. */
export const RUN_ARTIFACTS = {
  resultBundle: "result.xcresult",
  rawLog: "raw.log",
  metadata: "metadata.json",
  derivedData: "DerivedData",
} as const

export type Storage = {
  /** `<home>/Library/Application Support/opencode-xcode-test`. */
  toolRoot: string
  /** The global registry directory, shared across trusted roots. */
  registryDir: string
  registryFile: string
  registryLock: string
  /** Everything scoped to one trusted root. */
  rootDir: string
  rootLock: string
  runsDir: string
  queueFile: string
  trashDir: string
  tombstonesDir: string
  /** The opaque key this trusted root is stored under. */
  rootKey: string
}

/**
 * A hash, not the path itself: the storage layout must not spell out where
 * someone's repositories live, and a fixed-length key keeps path lengths bounded.
 */
export function rootKeyFor(canonicalTrustedRoot: string): string {
  return createHash("sha256").update(`trusted-root ${canonicalTrustedRoot}`, "utf8").digest("hex")
}

export function storageFor(homeDir: string, canonicalTrustedRoot: string): Storage {
  const toolRoot = join(homeDir, "Library", "Application Support", TOOL_DIRECTORY)
  const registryDir = join(toolRoot, "registry")
  const rootKey = rootKeyFor(canonicalTrustedRoot)
  const rootDir = join(toolRoot, "roots", rootKey)

  return {
    toolRoot,
    registryDir,
    registryFile: join(registryDir, "registry.json"),
    registryLock: join(registryDir, "registry.lock"),
    rootDir,
    rootLock: join(rootDir, "root.lock"),
    runsDir: join(rootDir, "runs"),
    queueFile: join(rootDir, "queue.json"),
    trashDir: join(rootDir, "trash"),
    tombstonesDir: join(rootDir, "tombstones"),
    rootKey,
  }
}

/** Create every directory the runner needs, owner-only, before anything runs. */
export function prepareStorage(storage: Storage): void {
  for (const dir of [
    storage.toolRoot,
    storage.registryDir,
    join(storage.toolRoot, "roots"),
    storage.rootDir,
    storage.runsDir,
    storage.trashDir,
    storage.tombstonesDir,
  ]) {
    createPrivateDirectory(dir)
  }
}

/** `0700`, created if absent, and rejected outright if it is a symlink. */
export function createPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertSafeDirectory(path)
}

/**
 * A directory is safe when it is a real directory, owned by this user, and not
 * group- or world-accessible. Anything else is rejected rather than repaired:
 * quietly tightening permissions on something we do not own would be worse.
 */
export function assertSafeDirectory(path: string): void {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) throw new UnsafeArtifactError(path, "is a symbolic link")
  if (!stats.isDirectory()) throw new UnsafeArtifactError(path, "is not a directory")
  assertOwnedPrivately(path, stats.uid, stats.mode)
}

/** The same guarantee for a file. */
export function assertSafeFile(path: string): void {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) throw new UnsafeArtifactError(path, "is a symbolic link")
  if (!stats.isFile()) throw new UnsafeArtifactError(path, "is not a regular file")
  assertOwnedPrivately(path, stats.uid, stats.mode)
}

function assertOwnedPrivately(path: string, uid: number, mode: number): void {
  const self = typeof process.getuid === "function" ? process.getuid() : undefined
  if (self !== undefined && uid !== self) throw new UnsafeArtifactError(path, "is owned by another user")
  if ((mode & 0o077) !== 0) throw new UnsafeArtifactError(path, "is accessible beyond its owner")
}

export class UnsafeArtifactError extends Error {
  constructor(path: string, reason: string) {
    // The message names the reason, never the private path's contents.
    super(`a retained artifact ${reason}`)
    this.name = "UnsafeArtifactError"
    this.path = path
  }
  readonly path: string
}

/**
 * A cryptographically random 128-bit identifier. It is the only handle any
 * public contract ever exposes, so it must carry no structure worth guessing.
 */
export function newRunId(): string {
  return randomBytes(16).toString("hex")
}

export function runDirectory(storage: Storage, runId: string): string {
  return join(storage.runsDir, runId)
}

/**
 * Create the run's private directory atomically. A collision means the caller
 * should retry with a fresh `runId` rather than reuse someone else's directory.
 */
export function createRunDirectory(storage: Storage, runId: string): string | undefined {
  const path = runDirectory(storage, runId)
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (isExists(error)) return undefined
    throw error
  }
  assertSafeDirectory(path)
  return path
}

/**
 * Write through a temporary file in the same directory and rename over the
 * target, so a reader never observes a half-written record and a crash leaves
 * either the old state or the new one.
 */
export function writePrivateFileAtomic(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(temporary, data, { mode: 0o600, flag: "wx" })
  syncFile(temporary)
  renameSync(temporary, path)
}

function syncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Canonicalize the adapter-supplied trusted root. Symlinks are resolved once,
 * here, and never again: every later path decision is made against the real
 * directory, so a link swapped afterwards cannot redirect storage.
 */
export function canonicalizeTrustedRoot(path: string): string {
  const canonical = realpathSync(path)
  assertIsDirectory(canonical)
  return canonical
}

function assertIsDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) {
    throw new UnsafeArtifactError(path, "is not an existing directory")
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "EEXIST"
}
