# Destination revalidation, 2026-09-16 (issue #79)

What the gates say after the ten repairs under #1, measured rather than asserted.
Every number here came from a run on this machine on this date; where something
does not pass, it says so.

## Environment

| | |
| --- | --- |
| Xcode | 26.4.1 (17E202), xcresulttool 24757, schema 0.1.0 |
| OpenCode host | 1.18.29 |
| Linked packages | `@opencode-ai/plugin` 1.15.12, `@opencode-ai/sdk` 1.15.12 (manifest asks `^1.15.12`) |
| Runtime | Bun 1.4.0 |
| Compiler | TypeScript 5.9.3, `@types/bun` 1.4.2, both pinned |

The package skew is reported on every run and is **not** a gate failure: ADR 0002
records a trailing minor as warn-and-record. It is why this report names the
packages separately from the host — before #81 it named only the host, and every
green report in this repository's history described a package set nobody had
named.

## What passes

| Criterion | Result |
| --- | --- |
| Enforced TypeScript check over `src`, `test`, `scripts` | **0 errors** (`bun run typecheck`) |
| Unit and lint suite | **996 pass, 0 fail** |
| No leaked subprocesses after a full suite | **0** (was ~6 per run, 354 accumulated, before #86) |
| No temporary projects left on disk | **0** |
| A failed Layer 4 run leaves diagnosable evidence | **yes** — 121,110,440 bytes under the report's own key: 6 Run Records carrying supervisor identity, child identity, termination trigger and `startedAt`; 6 raw logs; 6 Result Bundles |
| The durable report leaks no private path | **yes** — no `$HOME`, no `/var/folders`, no `/private` in the report JSON |

### Regression paths (AC5)

| Path | Where |
| --- | --- |
| long post-handshake execution | `test/adapter/handshake.test.ts` (9) |
| Focused Detail frames | `test/interpreter/multiline-frames.test.ts` (10) |
| diagnostic completeness | `test/interpreter/diagnostic-completeness.test.ts` (8) |
| incomplete annotations | `test/adapter/annotations.test.ts` (9) |
| filesystem failure containment | `test/adapter/containment.test.ts` (14) |
| control-channel loss | `test/runner/channel-loss.test.ts` (3) |
| B1 SDK-load failure | `test/gate/sdk-load.test.ts` (4) |
| package provenance | `test/gate/provenance.test.ts` (16) |
| configured host output limits | `b2 configured host limits`, against a real host |
| Layer 4 failure evidence | `test/gate/evidence.test.ts` (17) |

## What does not pass

**The complete acceptance gate does not pass repeatedly.** `--layer4` and `--b1`
pass; `--b2` passed four consecutive runs in isolation and then failed inside a
full gate run. One scenario is responsible: `b2 zero-match`.

Three real defects were found and fixed while chasing it, and each removed a
distinct failure mode:

1. `testingReached` became true only when the Result Bundle advertised a
   test-results section. For a run whose selection matched nothing, Xcode does
   not reliably write one — which is why this was intermittent rather than
   constant. The scope check that turns a zero-match run into `scopeMismatch` is
   consulted only when testing was reached, so the run that most needs a scope
   verdict was the one guaranteed not to get one.
2. A stream error raised *after* the child had exited cleanly — this runtime
   raises `EBADF: bad file descriptor, close` often enough to matter inside a
   busy host process — was reported as `resultBundleUnreadable`. The tool was
   blaming a caller's Result Bundle for its own difficulty putting a file down.
3. Two different staging failures, "could not be created" and "could not be
   written", shared one wording. They send a reader to look at completely
   different things.

What remains is **not** a single logic defect. Under full-gate load two further
failures were captured directly:

```
get build-results :: commandFailed :: ... the file could not be written
metadata get      :: bundleUnreadable :: xcresulttool exited with status 1
```

The second is `xcresulttool` itself refusing to open a bundle it had just
written. Neither reproduces outside the OpenCode host process: the same
zero-match run through the same service succeeded **6 times out of 6** when
driven directly, and Layer 4's own zero-match scenario passes.

## Findings, classified (AC7)

| # | Finding | Class |
| --- | --- | --- |
| 1 | `b2 zero-match` fails intermittently under full-gate load; two captured causes are a staged-write failure and `xcresulttool metadata get` exiting 1, neither reproducible outside the host process | **destination-blocking** |
| 2 | User-wide byte eviction counts only `roots/<key>/runs`. On this machine that is **5.0 GB** against **34.3 GB** of DerivedData in the same tree — the cap is computed over an eighth of what the tool occupies | **destination-blocking** |
| 3 | 304 root directories accumulate and nothing collects them. The registry stores a hash and `lastSeenAtMs` and deliberately never stores a path, so the tool cannot ask whether a root still exists — `lastSeenAtMs` is the signal an age-based sweep would use | **maintenance** |
| 4 | `controlChannelLost` is written durably and nothing reads it (#78) | **maintenance** |
| 5 | The unreadable-host-limits fallback has no real-host proof; booting a host whose config route fails is not something the gate can arrange (#82) | **accepted scope** |
| 6 | At the linked package versions there is no route by which the `tool_output` read could be compiler-checked: the plugin's `Config` is the SDK's v1 type and declares no such field. The read itself is verified reachable against a live 1.18.29 host (#82, #81) | **documentation** |
| 7 | AC2's "cleanup on success" for Layer 4 evidence is verified against the real gate rather than by `bun test`, because a passing Layer 4 run requires Xcode by definition (#73) | **accepted scope** |

## Verdict

**The destination is not claimable today.** Findings 1 and 2 are
destination-blocking: a gate that does not pass repeatedly cannot serve as the
evidence #1 asks for, and a retention cap that measures an eighth of what is
retained is not a bound. Everything else on the list is either recorded work or
an accepted limit of what this repository can prove about someone else's host.
