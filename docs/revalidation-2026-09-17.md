# Destination revalidation, 2026-09-17 (issue #101)

What the gates say after the re-audit repairs — #84, #96, #97, #98, #99, #100 —
measured rather than asserted. Every number came from a run on this machine on
this date; where something does not pass, it says so.

Supersedes `docs/revalidation-2026-09-16.md`, which is kept: the two together
are the record of what changed and what did not.

## Environment

| | |
| --- | --- |
| Xcode | 26.4.1 (17E202), xcresulttool 24757, schema 0.1.0 |
| OpenCode host | 1.18.29 |
| Linked packages | `@opencode-ai/plugin` 1.15.12, `@opencode-ai/sdk` 1.15.12 (manifest asks `^1.15.12`) |
| Runtime | Bun 1.4.0 |
| Compiler | TypeScript 5.9.3, `@types/bun` 1.4.2, both pinned exactly |
| Destination | discovered, not assumed: `iPhone 17 Pro`, iOS 26.4, addressed by simulator id |
| Scenarios | 27 — Layer 4 (8), B1 (6), B2 (10), and 3 conditional (`b1 host registration`, `b2 execution`, `supplied project run`) |
| Freshness | **fresh** — 20 fixtures checked, no drift against the observed toolchain |

## What passes

| Criterion | Result |
| --- | --- |
| AC1 — the combined quality gate, from a clean checkout | **passes** — `bun run check`: 0 type errors, then 1,081 pass / 0 fail |
| AC2 — the complete acceptance gate, repeatedly | **passes 3 of 3**, all 27 scenarios reached, no scenario unreached |
| AC3 — `b2 zero-match` reports `scopeMismatch` | **yes, 3 of 3**; an injected B2 failure keeps 55,374,602 bytes of evidence correlated per failed scenario to root key and run id |
| AC5 — `xcode_test` contains deep and malformed interpretation failures | **yes** — 14 regression tests, including late admission; the run id survives every contained failure |
| AC6 — Focused Detail tells absent from recognized from malformed | **yes** — 18 regression tests across ingestion, indexing, decoding and Focused Detail |
| AC7 — the durable report records the run without private path leakage | **yes** — compiler, suite, host, packages, toolchain, runtime, destination, scenarios, freshness and storage; no `$HOME`, `/var/folders` or `/private` |

### Regression paths

| Path | Where | Tests |
| --- | --- | --- |
| tool-boundary containment | `test/adapter/containment-boundary.test.ts` | 14 |
| Focused Detail frame evidence | `test/interpreter/multiline-frames.test.ts` | 18 |
| storage footprint and cache reclamation | `test/runner/footprint.test.ts` | 11 |
| B2 evidence correlation and root collection | `test/gate/b2-evidence.test.ts` | 22 |
| structured read staging | `test/interpreter/staging.test.ts` | 10 |
| the combined gate, executed | `test/lint/gate.test.ts` | 4 |
| housekeeping and stale roots | `test/runner/housekeeping.test.ts` | 22 |

## What does not pass

**AC4 — storage does not converge below its targets on this machine.**

The accounting is now right, and that is the part that was wrong before: the
tool measures **36.77 GiB** where the old arithmetic reported 4.74 GiB, because
it counted each root's `runs` and nothing else while shared DerivedData sat
beside it uncounted. The user-wide target is 20 GiB.

A reclamation pass over every root removed **193 caches, 6.69 GiB**, and left
**25.40 GiB** — still over. Almost all of the remainder, **25.07 GiB**, is a
single root's cache that reclamation is not permitted to touch:

```
root c7ff7b83…  caches 1  25.07 GiB  queue: active=fdde01a9…  lock: free
run  fdde01a9…  state launchAuthorized  startedAt 2026-09-16T14:06:55Z
```

That run never completed. Its process has been gone for nineteen hours and its
execution slot is still held, so every pass reads the slot, concludes a build
may be writing into that cache, and declines — correctly, given what it can
see. Releasing a stale slot is recovery's job and needs a process probe;
recovery runs when a root is next opened, and a root nobody opens again is
never reconciled. A crashed run therefore pins its root's cache permanently.

Three consecutive gate runs also left the total unmoved at 36.77 GiB, because
housekeeping runs at most once an hour (ADR 0002) and none of the three
triggered a pass. The bound is real; the schedule that applies it is slower
than the thing it bounds.

## How the numbers were measured

`bun run check` is re-runnable from a clone. The rest are observations of this
machine, and a reader who wants them again has to produce them the same way,
because the artefacts they come from are deliberately untracked (ADR 0001).

| Number | How |
| --- | --- |
| 3 of 3 gate runs, 27 scenarios | three consecutive `bun scripts/acceptance-gate.ts` runs |
| 36.77 / 25.40 GiB, 193 caches, 352 roots | `measureStorage`, the same walk the durable report records |
| 55,374,602 bytes of B2 evidence | one deliberately failed B2 scenario, measured under the report's own key |
| no `$HOME`, `/var/folders`, `/private` | grepped the durable report JSON those runs produced |
| the pinned root's slot and record | read directly from that root's `queue.json` and Run Record |

## Findings, classified (AC8)

| # | Finding | Class |
| --- | --- | --- |
| 1 | A stale execution slot exempts a root's build cache from reclamation for ever. Recovery releases such slots and runs only when a root is next opened, so a crashed run pins its cache — 25.07 GiB of the 25.40 GiB still held here | **destination-blocking** |
| 2 | Housekeeping's once-an-hour interval is slower than a gate run's storage growth, so the bound is correct and not applied often enough to hold between passes | **maintenance** |
| 3 | One unidentified per-root storage directory accumulates per B1 gate run, from a path no suite registers (#104) | **maintenance** |
| 4 | `b2 zero-match`'s host-only failure has no established cause. Three defects were repaired and two hypotheses disproved; what remains is mitigated by a bounded retry and, when it recurs, will leave the undecodable payload behind to be read (#84) | **accepted scope** |
| 5 | The unreadable-host-limits fallback still has no real-host proof: booting a host whose config route fails is not something the gate can arrange (#82) | **accepted scope** |
| 6 | At the linked package versions there is no route by which the `tool_output` read could be compiler-checked; the read is verified reachable against a live 1.18.29 host instead (#82, #81) | **documentation** |
| 7 | Layer 4's "cleanup on success" is verified against the real gate rather than by `bun test`, because a passing Layer 4 run requires Xcode by definition (#73) | **accepted scope** |

## Verdict

**The destination is closer than it was, and is not claimable today.**

Seven of the eight criteria are met, and the two that blocked the 2026-09-16
revalidation have both moved: `b2 zero-match` passed every run of the complete
gate during this work, and the storage accounting now measures what the tool
occupies instead of an eighth of it.

Finding 1 is what stops the claim, and it is a bound that does not bind rather
than a number that was wrong. A retention policy which any crashed run can
permanently exempt its largest artefact from is not a retention policy — and it
is the same shape of defect as the one #96 repaired, one layer further in:
the measurement was fixed, and the thing that acts on the measurement can still
be switched off by an accident nobody notices.
