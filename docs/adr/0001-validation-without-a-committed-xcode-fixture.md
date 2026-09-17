# ADR 0001: Validation without a committed Xcode fixture

- **Status:** Accepted — both open deferrals closed by [ADR 0002](0002-opencode-v1-adapter-and-restricted-agent-integration.md)
- **Date:** 2026-09-13
- **Decides:** [Issue #2 — Define validation without a committed Xcode fixture](https://github.com/martinvidovic/opencode-xcode-testing/issues/2)
- **Settled contracts relied on:** #3 (process lifecycle and Result Bundle retention), #4 (OpenCode v1 tool execution constraints), #6 (Test Run request and project configuration contract), #7 (Result Summary and progressive inspection contract), #8 (xcresult interpretation and fallback behavior)
- **Map:** [#1 — Deliver a trustworthy local Xcode test tool for OpenCode](https://github.com/martinvidovic/opencode-xcode-testing/issues/1)

## Context

The Test Tool must be verifiable — parsing, classification, false-pass prevention, failure caps, cancellation, and local end-to-end behavior — while the repository stays public and generic: no committed sample Xcode project, no private project names, paths, data, or assumptions (map #1). CI integration is out of scope; local end-to-end validation is the acceptance surface. At decision time there is no implementation: the Xcode runner, result interpreter, and OpenCode adapter are independent seams whose contracts are settled in #3–#8.

## Decision

Validation is layered along the module seams and is deliberately test-framework-agnostic. The concrete language and test framework are chosen with implementation structure.

### Layer 1 — Result interpreter: synthetic-payload contract tests

- Committed synthetic `xcresulttool` payload fixtures, keyed to the pinned pair from #8: explicit schema version `0.1.0` and the decoder version contract.
- Fixtures reproduce the exact observed shapes, including the `testFailures` object-or-array defect, so the allowlisted normalization path is genuinely exercised.
- Coverage: the six Test Run outcomes; the infrastructure reason taxonomy; zero-match Requested Scope mismatch; `contradictoryEvidence`; attempt-aggregation ordering; failure caps; cursor paging.
- Each fixture carries structured provenance fields (observed shape or defect, toolchain identity facts) — not prose comments — so freshness drift maps automatically to affected fixtures and normalization paths.

### Layer 2 — Xcode runner: stub-process suite and manifest-based discovery fixtures

- A committed controllable stub process (spawns children, sleeps, traps signals) deterministically covers the #3 machinery: gated launch protocol (`launchAuthorized`, `execObserved`), termination-trigger precedence, identity validation and PID-reuse safety, quarantine/recovery transitions, and bounded escalation ordering.
- Where the property under test is the *absence* of evidence — a child whose exit is never reported, an observation that never settles — a stub process cannot produce it, because a real process that is asked to exit does exit. Those cases substitute a hand-built `GatedChild` whose promises never settle. It is the narrow exception to the stub-process rule, and it is what makes the bounds around those waits provable rather than asserted (#114).
- Discovery ambiguity branches — multiple workspaces, multiple projects, non-shared schemes, hidden/symlinked/vendor exclusions — need no real Xcode. They are covered by declarative directory-tree manifests materialized into temp directories at test time, so symlinks and hidden entries survive where git would mangle or ignore them.
- Retention limits (#3: age, count, bytes) are validated against real temp directories with an injectable clock and explicit mtimes for age, count, and tombstone eviction. Byte-cap accounting (5 GiB per trusted root, 20 GiB user-wide) is exercised through sparse files or a documented size-injection seam — never real gigabyte allocation.

### Layer 3 — Freshness check (drift detection, non-fatal)

- A standalone command, reusing the E2E generation scaffolding to produce a real Result Bundle, verifies the same toolchain identity facts #8 requires: Xcode product/build, `xcresulttool` version, schema version.
- On drift it reports observed-versus-supported schema facts machine-readably — mapped to affected fixtures via the structured provenance fields — rather than merely failing.
- Invoked by the E2E as non-fatal: drift is surfaced, never blocks the acceptance gate.

### Layer 4 — Local E2E: the runner+interpreter acceptance gate

- Drives the Xcode runner and result interpreter directly through a harness — not through OpenCode; adapter validation belongs to #5.
- A committed generation script — itself a hygiene-linted artifact — emits both a standalone `.xcodeproj` and a wrapping `.xcworkspace` from one template set, with an embedded shared scheme (#6 discovery), real destination resolution, `-only-testing` scoping, and a `buildFailed` variant carrying a deterministic compile error (exercising build-results authority and `notReached` scope attestation end-to-end).
- A `--project` override accepts a locally-owned, uncommitted real project for realistic scheme/destination cases; it is never committed.
- **Required scenarios:** passing run; failing run; zero-match (`-only-testing` with a nonexistent identifier yields zero-match detection, never `passed`); `buildFailed`; progressive inspection from the retained Result Bundle without rerunning; capped/cursor inspection.
- **Report-only scenarios:** real `xcodebuild` cancellation; timeout escalation on a real run — timing-sensitive by nature; the stub suite proves the supervision machinery deterministically.
- **Gating:** the standing gate runs against the generated fixture only — reproducible from committed artifacts alone. `--project` runs must pass if invoked but do not form the gate. No usable destination is a failure with a diagnostic stating what discovery looked for and found — never a silent skip.
- **Run report:** every run emits a durable local report — toolchain identity facts observed, destinations discovered, per-scenario results, freshness-drift findings — written by construction to a tool-managed or explicitly gitignored location, never anywhere the repository could accidentally track. This is a structural guarantee, not a convention, because `--project` reports contain private project facts (schemes, destinations, paths).

### Governance

- A hygiene lint runs inside the test suite over every committed fixture, manifest, and the generation script: absolute paths, usernames, and identifiers outside the generic-identifier allowlist are rejected.
- Agent-ready validation implementation tickets graduate alongside implementation structure, not before (map #1's sequencing).

## Seam with #5

This E2E is the acceptance gate for the runner+interpreter seam and defines the reusable scaffolding: generation script, declarative discovery manifests, stub project, and `--project` override. The OpenCode adapter's validation belongs to #5, which must reuse this scaffolding; map #1's destination is claimable only after #5's adapter-inclusive E2E also passes — otherwise the destination could be claimed without ever validating the adapter wiring.

> **Resolved.** [ADR 0002](0002-opencode-v1-adapter-and-restricted-agent-integration.md) defines that adapter-inclusive gate as a pure adapter layer plus a headless-host layer — credential-free registration assertions that always gate, and an execution pass over these scenarios driven through a local stub provider.

## Open deferrals

> **Closed by [ADR 0002](0002-opencode-v1-adapter-and-restricted-agent-integration.md).** Both
> deferrals below were resolved when #5 settled implementation structure: the language and test
> framework are **TypeScript, Bun, and `bun:test`**; byte-cap eviction uses **sparse files via
> `node:fs`**, and the size-injection alternative is dropped. The text is retained as written for
> the record.

Two choices are deliberately open — surfaced, not silent — to be resolved by implementation tickets:

1. **Test framework / language** — this decision is framework-agnostic by design; the concrete choice lands with implementation structure.
2. **Byte-cap eviction mechanism** — sparse files or a documented size-injection seam, whichever suits the chosen language; the constraint either way is that byte accounting is exercised against the real filesystem without real disk consumption.

## Consequences

- Every validation layer is reproducible from committed, generic artifacts; the standing acceptance gate depends on nothing private.
- Edge cases that real Xcode runs rarely exhibit (zero-match, contradictions, object-or-array defects, cap boundaries) are deterministically reachable.
- The map's generic-artifacts constraint is enforced mechanically, not by convention.
- Adapter wiring remains unvalidated until #5 closes its adapter-inclusive E2E; the map's destination cannot be claimed before then.
