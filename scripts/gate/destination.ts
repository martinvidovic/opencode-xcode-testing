/**
 * Destination discovery for the acceptance gate (ADR 0001).
 *
 * "No usable destination" is a **failure with a diagnostic**, never a silent
 * skip. A gate that quietly passes because it found nothing to run on is worse
 * than no gate: it reports green on a machine where nothing was verified.
 */

import { spawnSync } from "node:child_process"

import type { Destination } from "../../src/domain/request.ts"

export type DestinationDiscovery =
  | { status: "found"; destination: Destination; deviceName: string; runtime: string }
  | { status: "none"; diagnostic: string }

type SimctlDevice = { name: string; udid: string; isAvailable?: boolean; state: string }

/**
 * Prefer a booted simulator, then any available iOS one. Booting a simulator
 * ourselves would make the gate's runtime depend on how cold the machine is.
 */
export function discoverDestination(): DestinationDiscovery {
  const result = spawnSync("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"], {
    encoding: "utf8",
  })

  if (result.status !== 0) {
    return {
      status: "none",
      diagnostic:
        "`xcrun simctl list devices available` failed. The gate looked for an available iOS simulator and could not enumerate any; check that Xcode and its iOS platform are installed.",
    }
  }

  let devices: Record<string, SimctlDevice[]>
  try {
    devices = (JSON.parse(result.stdout) as { devices: Record<string, SimctlDevice[]> }).devices
  } catch {
    return {
      status: "none",
      diagnostic: "`xcrun simctl list devices available -j` produced output the gate could not parse.",
    }
  }

  const candidates = Object.entries(devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([runtime, entries]) =>
      entries
        .filter((entry) => entry.isAvailable !== false)
        .map((entry) => ({ runtime, ...entry })),
    )

  if (candidates.length === 0) {
    const runtimes = Object.keys(devices).sort()
    return {
      status: "none",
      diagnostic: `the gate looked for an available iOS simulator and found none. Runtimes present: ${
        runtimes.length === 0 ? "(none)" : runtimes.join(", ")
      }. Install an iOS platform with \`xcodebuild -downloadPlatform iOS\`.`,
    }
  }

  const booted = candidates.find((entry) => entry.state === "Booted")
  const chosen = booted ?? candidates[0]
  if (chosen === undefined) {
    return { status: "none", diagnostic: "no usable iOS simulator was found." }
  }

  // An id destination is exact: two simulators can share a name across runtimes.
  return {
    status: "found",
    destination: { kind: "id", id: chosen.udid },
    deviceName: chosen.name,
    runtime: chosen.runtime,
  }
}
