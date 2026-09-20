/**
 * Advisory coordination locks (#3).
 *
 * These must be kernel-managed. A lock directory, a best-effort lock, or a
 * process-local mutex would each silently permit two Test Runs to hold the same
 * containment root's execution slot, which is precisely the failure the
 * serialization guarantee exists to prevent — so this fails closed rather than
 * falling back to any of them.
 *
 * `O_EXLOCK` is the BSD/Darwin `open(2)` flag that takes an exclusive `flock`
 * atomically with the open, and `O_NONBLOCK` turns a held lock into an error
 * instead of a wait. That pairing is what "try the lock without waiting" needs:
 * a second plugin instance discovers a sibling is already working and returns
 * immediately rather than delaying host startup behind it.
 */

import { closeSync, constants, openSync } from "node:fs"

/** `O_EXLOCK` on Darwin. Not exposed by `node:fs` constants under Bun. */
const O_EXLOCK = 0x0020

export class LockUnavailableError extends Error {
  constructor(path: string) {
    super(`the advisory lock at ${path} is held elsewhere`)
    this.name = "LockUnavailableError"
  }
}

export class LockUnsupportedError extends Error {
  constructor(cause: string) {
    super(`kernel-managed advisory locking is unavailable: ${cause}`)
    this.name = "LockUnsupportedError"
  }
}

export type Lock = {
  path: string
  release(): void
}

/**
 * Take the lock, waiting until it is available. Used where the work genuinely
 * must happen — an admission transition, for instance — rather than where a
 * sibling doing it instead is an acceptable outcome.
 */
export function acquireLock(path: string): Lock {
  return open(path, false)
}

/**
 * Take the lock only if it is free. A held lock means another process is
 * already doing this work, and the correct response is to return, not to queue
 * behind it.
 */
export function tryLock(path: string): Lock | undefined {
  try {
    return open(path, true)
  } catch (error) {
    if (isWouldBlock(error)) return undefined
    throw error
  }
}

/** Run `work` under the lock, releasing it even if `work` throws. */
export function withLock<T>(path: string, work: (lock: Lock) => T): T {
  const lock = acquireLock(path)
  try {
    return work(lock)
  } finally {
    lock.release()
  }
}

/** Run `work` only if the lock is free. Returns `undefined` when it is held. */
export function withTryLock<T>(path: string, work: (lock: Lock) => T): T | undefined {
  const lock = tryLock(path)
  if (lock === undefined) return undefined
  try {
    return work(lock)
  } finally {
    lock.release()
  }
}

function open(path: string, nonBlocking: boolean): Lock {
  const flags =
    constants.O_CREAT | constants.O_RDWR | O_EXLOCK | (nonBlocking ? constants.O_NONBLOCK : 0)

  let fd: number
  try {
    fd = openSync(path, flags, 0o600)
  } catch (error) {
    if (nonBlocking && isWouldBlock(error)) throw error
    if (isUnsupported(error)) throw new LockUnsupportedError(codeOf(error) ?? "unknown")
    throw error
  }

  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      closeSync(fd)
    },
  }
}

function isWouldBlock(error: unknown): boolean {
  const code = codeOf(error)
  return code === "EAGAIN" || code === "EWOULDBLOCK"
}

function isUnsupported(error: unknown): boolean {
  const code = codeOf(error)
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP"
}

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}
