/**
 * Runner-owned storage (#3).
 *
 * Everything the runner writes — Result Bundles, raw logs, isolated
 * DerivedData, metadata, locks, queue state, tombstones — lives outside the
 * repository, in a user-scoped root keyed by a hash of the canonical containment
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
  fstatSync,
  type Stats,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  realpathSync,
} from "node:fs"
import { join } from "node:path"

import { MAX_PRIVATE_FILE_BYTES } from "../domain/limits.ts"

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
  /** The global registry directory, shared across containment roots. */
  registryDir: string
  registryFile: string
  registryLock: string
  /** Everything scoped to one containment root in the current storage contract. */
  rootDir: string
  rootLock: string
  runsDir: string
  queueFile: string
  trashDir: string
  tombstonesDir: string
  /** Where inspections publish their read leases, one file each. */
  leasesDir: string
  /** The opaque key this containment root is stored under. */
  rootKey: string
}

/**
 * A hash, not the path itself: the storage layout must not spell out where
 * someone's repositories live, and a fixed-length key keeps path lengths bounded.
 */
export function rootKeyFor(canonicalContainmentRoot: string): string {
  // Keep the historical namespace: root-level sessions must retain their state.
  return createHash("sha256")
    .update(`trusted-root ${canonicalContainmentRoot}`, "utf8")
    .digest("hex")
}

/**
 * Exactly what `rootKeyFor` produces: a SHA-256 digest in lowercase hex.
 *
 * Checked wherever a key arrives from durable state rather than from the
 * function above, because a key names a directory that housekeeping renames
 * and recursively deletes. A shared build cache is keyed the same way and by
 * the same rule (issue #96), so it is checked with the same function rather
 * than with a second copy of the same regular expression.
 */
export function isRootKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

export function storageFor(homeDir: string, canonicalContainmentRoot: string): Storage {
  return storageForRootKey(homeDir, rootKeyFor(canonicalContainmentRoot))
}

/**
 * The same storage, addressed by the key instead of the path.
 *
 * User-wide housekeeping visits roots it has only ever seen as keys — the
 * repository they belong to may have moved or gone — so it cannot hash a path
 * to find them. Deriving every path from the key is what makes that possible
 * without the caller assembling directory names itself.
 */
export function storageForRootKey(homeDir: string, rootKey: string): Storage {
  const toolRoot = toolRootFor(homeDir)
  const registryDir = join(toolRoot, "registry")
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
    leasesDir: join(rootDir, "leases"),
    rootKey,
  }
}

/**
 * The tool-managed storage root under a home directory.
 *
 * One place, because everything this tool keeps lives under it and a second
 * spelling is a second thing to keep in step — the reports, the evidence store
 * and every run's artifacts all have to agree about where "here" is.
 */
export function toolRootFor(homeDir: string): string {
  return join(homeDir, "Library", "Application Support", TOOL_DIRECTORY)
}

/**
 * Where shared DerivedData for one container lives.
 *
 * Keyed by the **canonical container**, not by the containment root. A repository
 * with two containers is ordinary, and letting both write one DerivedData
 * would have them overwrite each other's build products — a shared cache that
 * makes builds slower and results less trustworthy is not a cache. The key is
 * a hash for the same reason the root key is: storage must not spell out where
 * anyone's code lives.
 */
export function sharedDerivedDataFor(storage: Storage, canonicalContainerPath: string): string {
  const key = createHash("sha256")
    .update(`xcode-container ${canonicalContainerPath}`, "utf8")
    .digest("hex")
  return join(sharedCacheRoot(storage), key)
}

/**
 * Where a root's shared build caches live, as a directory to be walked.
 *
 * Here rather than assembled by retention, for the reason `storageForRootKey`
 * gives: layout is this file's business, and a caller that joins its own path
 * to reclaim bytes is a caller that keeps working after the layout moves and
 * silently reclaims nothing.
 */
export function sharedCacheRoot(storage: Storage): string {
  return join(storage.rootDir, RUN_ARTIFACTS.derivedData)
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
    storage.leasesDir,
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

/**
 * Read a private file, checking the bytes that are actually returned.
 *
 * Checking a pathname and then reading that pathname names the path twice,
 * and the two calls need not reach the same file: the check and the read are
 * a time-of-check-to-time-of-use pair with a window between them, and there
 * is no safe version of that pair, which is why no such helper exists to
 * reach for. Opening once
 * with `O_NOFOLLOW` and validating the **descriptor** closes it — what is
 * checked and what is read are then the same object by construction, and a
 * link swapped in at any moment fails the open rather than redirecting it.
 */
export function readPrivateFile(path: string): string {
  const handle = openPrivateFile(path)
  try {
    // Bounded even though this tool wrote it. "We wrote it" describes the
    // past; what is on disk now is whatever a crash, a full volume, or
    // anything else with access left there, and reading it whole without a
    // limit makes every one of these files a way to exhaust the process.
    if (handle.size > MAX_PRIVATE_FILE_BYTES) {
      throw new UnsafeArtifactError(path, "is larger than a tool-managed file may be")
    }
    return readFileSync(handle.fd, "utf8")
  } finally {
    closeSync(handle.fd)
  }
}

/**
 * Open a private file for appending, creating it if it is absent.
 *
 * The caller owns the descriptor and must close it. Three flags carry the
 * whole guarantee. `O_NOFOLLOW` means a link planted at the name is refused
 * rather than followed, which for an append-only write matters more than for
 * a read: the target is added to rather than replaced, so a redirected write
 * leaves nothing about the victim looking disturbed. `O_NONBLOCK` means a
 * FIFO at that name answers immediately instead of blocking until somebody
 * reads it — a wait with no deadline, no diagnostic and no way out; regular
 * files, which are the only kind this returns, ignore it. And the `fstat`
 * decides what was opened rather than what the name said.
 */
export function openPrivateAppendFile(path: string): number {
  let fd: number
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    )
  } catch (error) {
    throw refusalFor(path, error)
  }

  validate(path, fd)
  return fd
}

/**
 * A private file of an exactly known size, as bytes.
 *
 * Bytes rather than text because the callers that know a file's exact size
 * know it because the file is not text — a key, a digest — and a value that
 * has been through a UTF-8 decoder is a different value that looks like the
 * right one. The size is checked before the read, so a file that is not the
 * expected thing is refused rather than loaded; and again after it, because
 * `size` describes the moment of the `fstat` and the file can be truncated
 * after it.
 */
export function readPrivateBytes(path: string, expected: number): Buffer {
  const handle = openPrivateFile(path)
  try {
    if (handle.size !== expected) throw new UnsafeArtifactError(path, "is not the size it must be")
    const bytes = readFileSync(handle.fd)
    if (bytes.length !== expected) throw new UnsafeArtifactError(path, "changed size while being read")
    return bytes
  } finally {
    closeSync(handle.fd)
  }
}

/**
 * The same guarantee, left open, for a file too large to read whole.
 *
 * The caller owns the descriptor and must close it. This exists for the
 * retained log, which can be gigabytes: reading it in full to return a window
 * of it is the one implementation that cannot be bounded.
 */
export function openPrivateFile(path: string): { fd: number; size: number } {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw refusalFor(path, error)
  }

  return { fd, size: validate(path, fd).size }
}

/**
 * What an opened descriptor has to be before anything is done with it: a
 * regular file, ours, and no more readable than that.
 *
 * Both openers decide it here rather than each for itself, because it is the
 * half of the guarantee that does not depend on the flags — and a second copy
 * of it is a second place for it to be relaxed. A descriptor that fails is
 * closed on the way out; there is nothing a caller could do with one.
 */
function validate(path: string, fd: number): Stats {
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) throw new UnsafeArtifactError(path, "is not a regular file")
    assertOwnedPrivately(path, stats.uid, stats.mode)
    return stats
  } catch (error) {
    closeSync(fd)
    throw error
  }
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

/**
 * A `runId` safe to address storage with.
 *
 * The `runId` is the one piece of storage addressing a caller controls, and it
 * arrives from a model, so the rule is a character set rather than a shape
 * check: an identifier made only of alphanumerics, `-` and `_`, starting with
 * an alphanumeric and bounded in length, cannot contain a separator, a `.` (so
 * no `..` component), a NUL, a leading dash, or anything else a path reads
 * specially. Traversal and absolute paths are unrepresentable rather than
 * filtered.
 *
 * Deliberately not "exactly what `newRunId` emits". Pinning the rule to 32 hex
 * characters would narrow nothing further — every dangerous character is
 * already gone — while making every identifier in a test unreadable, and a
 * diagnostic nobody can read is its own kind of defect.
 */
const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/

export function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value)
}

/**
 * Where a run's private artifacts live.
 *
 * Validation happens **here**, at the one place every filesystem path for a run
 * is derived from, rather than at each of the callers that would each have to
 * remember. Anything that is not a run identifier throws before a path exists
 * at all, so there is no such thing as a half-validated path in this codebase.
 */
export function runDirectory(storage: Storage, runId: string): string {
  if (!isRunId(runId)) throw new UnknownRunError()
  return join(storage.runsDir, runId)
}

/**
 * A `runId` that cannot address storage at all.
 *
 * Distinct from `UnsafeArtifactError` because the two mean different things to
 * a caller: a malformed handle names nothing and is reported as "not found",
 * while an unsafe artifact names something real that must not be trusted.
 */
export class UnknownRunError extends Error {
  constructor() {
    // The rejected value is never echoed: it is model-controlled text, and a
    // diagnostic that repeats it is a diagnostic that can be written by it.
    super("the Test Run identifier cannot address retained storage")
    this.name = "UnknownRunError"
  }
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
 * Canonicalize the adapter-supplied containment root. Symlinks are resolved once,
 * here, and never again: every later path decision is made against the real
 * directory, so a link swapped afterwards cannot redirect storage.
 */
export function canonicalizeContainmentRoot(path: string): string {
  const canonical = realpathSync(path)
  assertIsDirectory(canonical)
  return canonical
}

function assertIsDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) {
    throw new UnsafeArtifactError(path, "is not an existing directory")
  }
}

/** `ELOOP` on every Unix; macOS reports `EMLINK` for this case instead. */
function isSymlinkRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "ELOOP" || code === "EMLINK"
}

/**
 * A refused open, said in this tool's terms.
 *
 * `O_NOFOLLOW` reports a symbolic link by refusing to open it, and that is a
 * rejected artifact rather than a missing one — the two have to stay
 * distinguishable to the caller deciding what to tell a model. The refusals
 * that mean "that is not a regular file" arrive as several unrelated codes
 * and none of them says so. Anything else is the kernel's own answer and is
 * passed on unchanged.
 */
function refusalFor(path: string, error: unknown): unknown {
  if (isSymlinkRefusal(error)) return new UnsafeArtifactError(path, "is a symbolic link")
  const code = (error as { code?: unknown } | null)?.code
  // A directory refuses a write outright; a socket cannot be opened by name at
  // all; a FIFO nobody is reading answers `ENXIO` rather than blocking, which
  // is the whole point of opening it without blocking.
  const notAFile = code === "EISDIR" || code === "ENXIO" || code === "EOPNOTSUPP" || code === "ENOTSUP"
  return notAFile ? new UnsafeArtifactError(path, "is not a regular file") : error
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "EEXIST"
}
