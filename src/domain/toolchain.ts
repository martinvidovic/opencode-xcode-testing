/**
 * Toolchain identity (#8).
 *
 * Shared vocabulary rather than either module's private concern: the runner
 * freezes the developer directory for the child, and the interpreter must read
 * the Result Bundle back with the very same installation. Both need to mean the
 * same thing by "the same toolchain", so the definition lives here.
 *
 * A path-and-version match is deliberately not enough. An Xcode replaced in
 * place keeps both and changes neither, which is exactly the case where reading
 * a bundle with the wrong decoder would look like it worked.
 */

export type ToolchainIdentity = {
  /** Canonical effective developer directory. Private; never model-facing. */
  developerDirectory: string
  xcodeVersion: string
  xcodeBuild: string
  /** Canonical resolved path. Private; never model-facing. */
  xcresulttoolPath: string
  xcresulttoolVersion: string
  /** SHA-256 of the `xcresulttool` executable. Private; never model-facing. */
  xcresulttoolDigest: string
  /** The structured schema version this installation supports. */
  schemaVersion: string
}

/** Every identity fact must match. There is no partial credit here. */
export function toolchainIdentityMatches(a: ToolchainIdentity, b: ToolchainIdentity): boolean {
  return (
    a.developerDirectory === b.developerDirectory &&
    a.xcodeVersion === b.xcodeVersion &&
    a.xcodeBuild === b.xcodeBuild &&
    a.xcresulttoolPath === b.xcresulttoolPath &&
    a.xcresulttoolVersion === b.xcresulttoolVersion &&
    a.xcresulttoolDigest === b.xcresulttoolDigest &&
    a.schemaVersion === b.schemaVersion
  )
}
