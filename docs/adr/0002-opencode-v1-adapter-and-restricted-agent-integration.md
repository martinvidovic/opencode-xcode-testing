# ADR 0002: OpenCode v1 adapter and restricted-agent integration

- **Status:** Accepted
- **Date:** 2026-09-13
- **Decides:** [Issue #5 — Define the OpenCode v1 adapter and restricted-agent integration](https://github.com/martinvidovic/opencode-xcode-testing/issues/5)
- **Settled contracts relied on:** #3 (process lifecycle and Result Bundle retention), #4 (OpenCode v1 tool execution constraints), #6 (Test Run request and project configuration contract), #7 (Result Summary and progressive inspection contract), #8 (xcresult interpretation and fallback behavior), #2 / ADR 0001 (validation layers)
- **Map:** [#1 — Deliver a trustworthy local Xcode test tool for OpenCode](https://github.com/martinvidovic/opencode-xcode-testing/issues/1)

## Context

Issue #5 is the last decision ticket under map #1. Every domain contract is settled; what remained
was how the OpenCode v1 host actually reaches them: how the Test Tool registers, how typed domain
results become minimal model-facing text, how progressive inspection is exposed, how the project
is located, how cancellation propagates, and how an agent uses the tool while general shell access
is denied.

Two constraints from map #1 shape the whole design. The destination is a plugin **loaded from
source**, and **npm publication is out of scope** — so there is no registry escape hatch for
distribution, dependency installation, or version negotiation. Everything must work from a git
checkout.

All API facts below were verified against OpenCode upstream at tag `v1.18.30`, with the locally
installed `1.18.29` compared and matched.

**Which artifacts, precisely** (issue #81). "Verified against 1.18.30" names a host, and a host is
not what this adapter is compiled against. Three separate things were compared, and a later reader
checking this claim needs all three:

| Artifact | What it is | Where it comes from |
| --- | --- | --- |
| OpenCode host `1.18.29` / upstream `v1.18.30` | the binary the gate executes, and the tag every API fact is cited against | `opencode --version`; the upstream git tag |
| `@opencode-ai/plugin` | the package this adapter's `tool` hook and types are written against | installed and managed by OpenCode in its config environment, then symlinked into this checkout by `scripts/link-host-package.ts` because source-loaded code resolves imports there |
| `@opencode-ai/sdk` | the package the (b1) and (b2) gates drive a host through | the same tree, installed as a dependency of the plugin package |

The two packages are **host-managed**: OpenCode installs them into its config directory on first
run, against a range in a manifest this repository does not own, and upgrading the host does not
revisit that install. A machine can therefore run host `1.18.29` with packages `1.15.12` — which is
what the machine this was written on was doing, silently, for the whole of its acceptance history.

So the gate reads and reports the two package versions **separately from the host version** on
every run, and `scripts/gate/provenance.ts` states the supported relationship as a rule:

- the two packages must be the **same version as each other** — they ship as a set, so a tree where
  they differ was assembled by hand or interrupted part-way;
- what is **installed must satisfy what the config manifest asks for** — otherwise the next install
  in that directory changes what is being tested and nobody afterwards can say which run was which;
- the packages' **major must match the host's** — across a major the plugin interface may change,
  and a gate passing against these would prove something about an interface nobody ships;
- a **trailing minor is a caveat, not a failure**, printed on every report. It is the ordinary state
  of a host-managed install, and failing on it would make the gate unrunnable because of an install
  nobody has re-run in a directory this repository does not own. That is the same warn-and-record
  policy this ADR already applies to host-version skew, extended to the packages — the change is
  that the skew is now *visible*.

## Decision

### Registration and loading

A v1 **plugin** (`export default { id, server }`, `id: "xcode-test"`) registering tools through the
`tool` hook — not bare `.opencode/tool/*.ts` files. The plugin factory is invoked at instance
bootstrap, awaited sequentially before every other host service, which is what makes #3's startup
reconciliation possible. Tool definitions live in a shared, independently testable module.

`dispose` is a **best-effort backstop only** — nothing may depend on it running. It is strictly
time-bounded (≤5 seconds) and performs only prompt-safe in-memory cleanup such as cancelling
waits. It must never attempt process cleanup, signalling, or reconciliation; those are #3's
crash-tolerant paths. A `dispose` that cannot finish promptly returns rather than blocking
shutdown.

**Installation is global, gated by per-project opt-in.** The plugin is installed once per machine
(`~/.config/opencode/opencode.json` with an absolute `plugin` entry, or a symlink in
`~/.config/opencode/plugin/`), so the machine-local absolute path lives in the one file never
committed to a project repo. The factory registers tools only when
`<trusted-root>/.opencode/xcode-test.json` **exists**. Absent, it registers nothing and stays
silent — "this is not an Xcode project" is a normal state, not a diagnostic. Per-project
installation via an absolute `plugin` entry remains available and documented, with the
machine-local caveat.

**Structural verification happens at startup, not at first run.** The factory stats the computed
supervisor entrypoint path and the description sidecar `.txt` files — exactly the files a static
import graph cannot protect — and if any is missing, registers no tools and emits a diagnostic
naming the expected checkout layout. A partial copy of the plugin is a different failure class
from host-version skew, and registering tools that cannot work is worse than registering none.

### Tool surface

**Three tool IDs**, not one multiplexed tool: `xcode_test`, `xcode_test_inspect`,
`xcode_test_recover`. Named exports yield independent, separately-deniable permission keys, which
is what makes exact allowlisting meaningful. `xcode_test_recover` takes **empty args** — recovery
is idempotent and bounded per #3, so there is nothing to parameterize and no ceremonial argument
is invented for a non-domain reason; invocation guidance lives in its description.

Arguments are declared as real Zod schemas (a flat `ZodRawShape`; unions live inside individual
args). The host's legacy JSON-Schema fallback is rejected outright: it marks every key required,
which would turn every optional argument — container, scheme, destination, timeout — into a
required one.

Descriptions are loaded from sidecar `.txt` files. A description-vs-outcome-vocabulary consistency
check runs in the adapter test layer, so descriptions cannot drift from the outcome vocabulary the
renderer actually emits.

### Trusted root and configuration

`context.worktree` when present, else `context.directory`; resolved once, canonicalized (symlinks
resolved, must be an existing real directory), and **never influenced by tool args**.
Canonicalization failure is a hard resolution error. Configuration lookup is exactly
`<trusted-root>/.opencode/xcode-test.json` with no upward search.

### Rendering and the output budget

The renderer is a **pure function from typed domain object to text** — no I/O, no clock, no
host handles — which is what makes byte-exact golden testing natural.

The adapter enforces its own rendered-text cap so that **host truncation is unreachable by
construction**. This matters beyond tidiness: host truncation replaces output with a pointer to a
truncation directory, and that pointer must never reach a model which has no file access. Never
tripping host truncation is an adapter invariant; a final pre-return size check applies #7's
priority-ordered deterministic truncation as a last resort, and tripping it is a defect covered by
tests.

The adapter cannot assume the documented 50 KiB / 2000 lines: `tool_output.max_lines` and
`max_bytes` are user-configurable and may be lower, and the host does **not** materialize defaults
— an unset `tool_output` arrives as `undefined`. Effective limits are read **once per session**
(config is not hot-reloaded) and the adapter enforces
`min(self-cap, effective host limit − safety margin)` for both lines and bytes, with baseline
self-caps of ~1900 lines and ~32 KiB. #7's 65,536-byte domain-data cap remains separate and
unchanged.

**Amended (issue #82): the guarantee is unconditional only while the limits are readable.**
"Unreachable by construction" is a claim about arithmetic — stay under the host's number — and it
holds exactly as long as the host's number is known. Three answers are possible, and the first
version of this collapsed two of them:

| What the host said | Ceiling applied | Guarantee |
| --- | --- | --- |
| a `tool_output` block | its numbers | unconditional |
| no `tool_output` block | the documented 2,000 lines / 50 KiB, which is what the host will apply | unconditional |
| nothing readable | a conservative floor of 200 lines / 5 KiB | **conditional on that floor** |

The third row is the amendment. A failed read used to be treated as the second, so the adapter
helped itself to 2,000 lines on a machine whose owner may have configured 200 — the one situation
the invariant exists to prevent, reached by assuming the best about a question nobody could ask.

**The route is real; the declared type is not.** `input.client.config.get()` is typed by the linked
`@opencode-ai/plugin`, whose `Config` is the SDK's **v1** generated type and has no `tool_output`
field at all. The SDK's v2 generated types do declare it, and the plugin package exports no v2
entrypoint — so at the linked versions there is **no supported route by which this read could be
compiler-checked**, and the adapter narrows the payload itself instead.

That is a limitation of the linked package set rather than a guess about the host. Asked directly,
OpenCode 1.18.29 answers `GET /config` with the configured block — verified against a live host
started with `tool_output: { max_lines: 321, max_bytes: 7654 }`, which came back verbatim. The (b2)
gate proves the same thing from the other end: it configures the host below the documented defaults
and every response is measured against them, and an adapter that ignores the configuration fails
that check. So the limits are read; what is missing is a declared shape to check the read against,
and #81's package skew (host 1.18.29, packages 1.15.12) is why.

The floor is a policy, not a measurement. It covers every lowering anyone is likely to configure by
hand and **cannot cover all of them**: a host set to `max_lines: 10` is beyond anything an adapter
that cannot read the configuration could know. So an unreadable read is also **announced** on
stderr, once, naming the reason and saying plainly that limits lower than the floor may still be
exceeded. A conservative guess nobody is told about is still a guess; a printed one is a fact the
person running it can act on.

**Amended (issue #37): "once at plugin startup" is not reachable, and is now "once, on first
use".** The plugin factory runs *inside* the host's own bootstrap. Asking the host for its
configuration from there deadlocks it: the config route cannot answer until the plugin it is
waiting on has returned, so the factory waits on a server that is waiting on the factory. Observed
against OpenCode 1.18.29, where it presents as a host that starts, serves `/doc`, and never answers
`/config` — with the plugin's tools silently absent, which is indistinguishable from a project that
never opted in.

The property the original wording existed to protect is *read once*, not *read early*: two calls in
one session must never disagree about the effective limits. Deferring the read to the first tool
invocation and memoizing it preserves that exactly, because the host's configuration is not
hot-reloaded between them. What is given up is only that the first rendered response pays for one
config call. The acceptance gate exercises the documented installation path end to end, so a
regression here shows up as a host that hangs rather than as a subtly wrong budget.

### Throw semantics

**Never throw for a domain outcome.** `invalid`, `cancelled`, `infrastructureFailed`, queued
failures and `timedOut` all render as ordinary tool output. Throwing is reserved for genuine
adapter defects, and thrown messages carry no paths or private identifiers. This follows from a
host fact: a thrown error yields an `output-error` part in which the model sees only the message —
`title`, `metadata` and `attachments` are discarded and `tool.execute.after` never fires — so
throwing a domain outcome would destroy the evidence #7 requires.

`context.ask` rejections must propagate and must never be swallowed by a surrounding `try/catch`;
the host wraps `ask` in `Effect.orDie`, so a rejection is a defect, and swallowing one would
silently override a user's denial. **The v1 tools never call `ask`**, which makes this rule moot by
construction — recorded here so that any future addition of `ask` re-opens it deliberately rather
than inheriting a rule nobody remembers.

### Running metadata

`context.metadata` is **human/TUI-only** and reports only durable protocol states — `admitted`,
`supervisorReady`, `launchAuthorized`, `executionCompleted`, `interpreting` — plus elapsed time
and `runId`. There are deliberately **no inferred `building` / `testing` phases**: #7 forbids
inferring phase from elapsed time or partial text, and that discipline holds for human-facing
metadata too. Hard invariant: no fact may exist only in metadata; `runId` is the one deliberate
mirror.

### Cancellation

The abort wait is **bounded at 30 seconds**, covering #3's bounded termination window (~25s
escalation plus drain). If terminal publication completes within it, the real summary is returned;
otherwise the tool returns `cancelled` with `unknown` evidence where facts are still pending, plus
the `runId`. Early return never abandons the run — #3's supervisor and reconciliation finalize it
regardless, and the model can inspect the terminal summary afterward. The abort wait is never held
open through the full interpretation budget merely to render evidence that inspection can deliver
later.

**Inspection ignores abort.** This is adapter behavior, not a contract change: inspection is a
bounded operation under a short read lease whose result lands in session history, so completing it
is strictly more useful than discarding it.

### Restricted agent

Agents cannot be registered programmatically by a plugin; they are markdown under
`{agent,agents}/**/*.md` or an `agent` block in config. Both agent configurations therefore ship as
**committed generic templates under `examples/agent/`**, documented for project-local placement
(`<project>/.opencode/agent/`). Unlike the plugin path they contain no absolute paths, so they are
portable and committable and a team can share them.

They use `permission:`, never the deprecated `tools:` map — `tools` is normalized into `permission`
and then overridden by any explicit `permission` block. Rules are last-match-wins with key order
preserved, so the working form is a catch-all first and specifics after:

```yaml
permission:
  "*": deny
  xcode_test: allow
  xcode_test_inspect: allow
  xcode_test_recover: allow
```

A rule whose pattern is exactly `"*"` with action `deny` **hides** the tool from the model entirely
rather than blocking at call time, which is what a restricted agent wants. `bash`'s tool id and
permission key are literally `bash`.

The templates are materialized and asserted by the adapter-inclusive gate, so they are tested
artifacts rather than documentation that drifts, and they fall under ADR 0001's hygiene lint.

### Plugin-startup budget

Nothing in the factory may block host startup indefinitely — the same principle `dispose` applies
from the other end of the lifecycle. The factory is awaited before every other host service, once
per `ctx.directory` instance, so a worktree with two session directories pays twice.

- **Gates first, sequentially**: the enablement-marker check and structural tree verification run
  first and in order, because only they can short-circuit everything behind them. Both are
  sub-millisecond.
- **Unmarked-root fast path**: when the marker is absent the factory skips the runtime probe, the
  version fetch, and root-local reconciliation entirely — not merely registration.
- **Everything else is bounded and concurrent** under a **shared 10-second deadline**: the runtime
  probe (2s), the host-version read (2s), root-local reconciliation (5s), and #3's user-wide
  housekeeping (5s). They are independent — a subprocess probe, an HTTP read, and two lock-guarded
  filesystem passes — so concurrency puts the expected worst case near 5 seconds. The 10-second
  ceiling is a **defect guard**, not an expected cost. On expiry the factory returns with whatever
  completed; every item is idempotent, retried next start, or degradable to `unknown`.
- Both reconciliation passes **try the lock without waiting**. A held lock means a sibling instance
  is already doing the work, so the second instance returns immediately. There is no adapter-side
  instance deduplication — it would be a second, weaker lock racing #3's real one.
- **Minimum-interval guard**: user-wide housekeeping records `lastHousekeepingAt` in the global
  registry and skips the pass when the previous one is under an hour old. This is what actually
  stops an unconfigured project from paying for maintenance it has no stake in on every session
  start.
- **Runtime-probe caching**: the probe result is cached in the machine-local registry and
  re-validated by `stat` (path, mtime, size, recorded version) rather than re-spawned, re-probing
  only on mismatch — the identity-recheck philosophy #8 applies to toolchains. First start pays the
  full probe; later starts pay milliseconds.

### Language, topology, and runtime resolution

**TypeScript throughout.** The adapter runs in-process under the Bun-hosted CLI; #3's supervisor is
a separate process spawned via the resolved runtime. Because the plugin ships as source with no
build step, the supervisor entrypoint is spawned as TypeScript directly, resolved relative to
`import.meta.url`.

Runtime resolution precedence, each candidate **probed and verified** rather than assumed, once at
startup:

1. an explicit `runtime` path in `<trusted-root>/.opencode/xcode-test.json` — **set-but-unusable is
   a hard error, never a fallback**, because an explicit setting that silently degrades is worse
   than one that fails;
2. `process.execPath`, only if probing confirms a real Bun runtime that can execute a trivial
   script. This is **expected to fall through**: the shipped host is a Bun-compiled single-file
   executable, which reports a version but cannot run a `.ts` file;
3. `bun` on `PATH`, same probe;
4. otherwise fail closed with `runnerFailure`, naming Bun, the probed candidates, and the config
   key that would fix it. No silent fallback.

Resolved runtime path and version are recorded in durable run metadata, mirroring #8's toolchain
identity recording. Note that a Homebrew-installed `opencode` implies nothing about Bun being on
`PATH`; installing Bun may be a genuine prerequisite for a source-loaded plugin, and the
fail-closed diagnostic says so.

### Dependency posture

**Zero runtime dependencies, mechanically enforced.** Shipped code — `src/domain`, `src/runner`,
`src/interpreter`, `src/adapter` — may import only `node:*` built-ins, plus exactly one runtime
import of `@opencode-ai/plugin` for `tool.schema`, permitted **only in `src/adapter`**.
`src/domain`, `src/runner` and `src/interpreter` import `@opencode-ai/plugin` **not at all** — not
even type-only — so those layers stay host-agnostic in source, not merely at runtime, and ADR
0001's runner and interpreter test layers never need a host.

`@opencode-ai/plugin` is installed and managed by OpenCode in its config environment, not provided
by this repository. A source-loaded checkout still resolves imports from its own location, so
`scripts/link-host-package.ts` symlinks that host-installed package into the checkout. If the host
install has not completed, module load fails loudly, which is correct structural-failure behavior
rather than silent degradation. The host also writes
`.opencode/package.json`, `package-lock.json`, `bun.lock` and a `.gitignore` listing them — that
file set is the host's, not ours, which is why a zero-dependency plugin never needs to commit a
manifest.

`scripts/` (generation script, freshness check, E2E driver) execute under the resolved Bun runtime
and may use `bun:*` APIs; the zero-dependency lint applies to shipped code only.

### Repository structure

```
src/domain/       shared typed results and the CONTEXT.md vocabulary; imports none of the below
src/runner/       Xcode runner + supervisor entrypoint
src/interpreter/  xcresult interpretation
src/adapter/      plugin.ts entrypoint, tool definitions, renderer
test/             mirrors src across ADR 0001's four layers
test/fixtures/    synthetic payloads, discovery manifests
test/golden/      byte-exact renderer goldens
examples/agent/   restricted-agent templates
scripts/          generation script, freshness check
```

Dependency direction is one-way and lint-enforced: `domain ← interpreter ← adapter` and
`domain ← runner ← adapter`; `runner` and `interpreter` never import each other. The supervisor
entrypoint lives in `src/runner` and may import only `domain` and `runner` code — never adapter
code, since it must outlive the adapter call that started it.

### Test-layer enforcement

All invariants run as ordinary `bun:test` suites, and the gate is `bun run check`: the strict
TypeScript check and then those suites. One command, because two were one too many — this document
said `bun test` was the single gate while the compiler it does not run held 240 errors, and Bun
strips types rather than checking them, so a green suite says nothing about whether the code
type-checks (issue #100). The import lint
reads `src/` with `node:fs`, matches static `import` / `export … from` specifiers, and asserts both
the allowlist and the one-way direction. It **rejects dynamic `import()` and `require()` outright**
in `src/` rather than analyzing them — Bun executes CommonJS-style `require` in TypeScript files,
so ignoring either would leave the lint exactly as unsound as permitting it.

Renderer goldens live in `test/golden/*.txt`, one per fixture-outcome pair, regenerated only under
an explicit `UPDATE_GOLDENS=1`. ADR 0001's hygiene lint **extends to cover goldens**: they render
real diagnostics and are precisely where a private path would leak into a public repo. A golden
diff in review is the intended signal that model-facing text changed.

### The adapter-inclusive gate

ADR 0001's Layer 4 gates the runner+interpreter seam through a harness, deliberately not through
OpenCode. #5's gate adds the adapter in two parts, reusing ADR 0001's generation script, discovery
manifests, and stub project.

**(a) Adapter test layer** — pure and fast. Calls exported tool `execute` with a synthesized
context over ADR 0001's synthetic domain outputs. Covers renderer goldens, the budget invariant,
the description-vocabulary check, and cancellation edges.

**(b1) Host registration, credential-free — always gating.** Boots a headless instance via
`createOpencode()` and asserts, without any model provider: that the three tool IDs register; each
tool's description and exact `parameters` JSON schema; and that the restricted-agent templates,
materialized into the temp trusted root, produce a permission ruleset that hides `bash` and exposes
the family.

**(b2) Execution.** Tool execution requires a real provider turn, and no built-in stub model
provider exists, so the required scenarios — passing, `testFailed`, zero-match, `buildFailed`,
inspection-without-rerun, and run-report emission — are driven through a **local
OpenAI-compatible stub provider** (`provider.<id>.npm` plus `options.baseURL`) emitting scripted
tool calls: deterministic, credential-free, no network. The stub's npm package is host-managed test
infrastructure inside the temp trusted root, not a repository dependency, so the zero-dependency
rule is unaffected.

A real `testFailed` run is required in (b2) specifically because neither ADR 0001's harness gate
nor layer (a) ever renders realistic diagnostics from a real Result Bundle under the budget
invariant.

(b2)'s gating status is **decided by implementation-time fact, not deferred**: if the stub-provider
route works, (b2) gates with the full scenario set; if it fails, the degradation to a scripted
manual checklist is **recorded** rather than silently accepted, and that checklist becomes the
gate. **The map destination is never claimable without execution-level validation passing in some
recorded form.**

> **Resolved at implementation time (issue #14): the stub-provider route works, and (b2) gates with
> the full scenario set.** A local OpenAI-compatible server configured through `provider.stub.npm`
> = `@ai-sdk/openai-compatible` plus `options.baseURL` emits scripted tool calls, and the host
> executes our tools from a real model turn — deterministically, credential-free, with no network.
> No degradation was needed, and no manual checklist replaces it.

Cancellation stays **report-only**, matching ADR 0001's treatment of timing-sensitive cases; the
stub-process suite proves the supervision machinery deterministically. The concurrent-instance
assertion joins (b1) only if headless drivability permits two instances; otherwise it stays in the
stub suite where #3's lock machinery is already proven.

Run reports go to the tool-managed or explicitly gitignored location ADR 0001 already mandates,
since these reports contain host paths.

### Host-version policy

The tested host set is an **explicitly enumerated list**: **`1.18.29` and `1.18.30`**. `1.18.30`
because every API fact is cited against that tag; `1.18.29` because it is the locally installed
binary the gate actually executes on, and its sources were compared against the `1.18.30` facts and
matched. Adding a version to this set is a deliberate recorded act, never a wildcard range.

Outside the set, the plugin emits a **one-time startup diagnostic** and registers normally. It
never fails closed on skew: a plugin that refuses to load on a patch bump is worse than one that
warns. `engines.opencode` is enforced only for npm-installed plugins, never file plugins, so it is
unavailable to a source-loaded plugin and warn-and-record is the only available policy.

The host version is not exposed on `PluginInput`; it is read by a **bounded 2-second `fetch` of
`GET /global/health`** against `input.serverUrl`. Unreachable, erroring, or unparseable results in
`version: unknown`, the diagnostic skipped, `unknown` recorded in run metadata, and **registration
never blocked**.

The observed host version is recorded in durable run metadata alongside the runtime facts and #8's
toolchain identity, and appears in the E2E run report — surfacing drift rather than blocking on it,
matching ADR 0001's freshness philosophy.

## Contracts amended

This ADR amends four points across two closed contracts. Each is listed here so a reader arriving
from the original contract is not misled.

1. **#3 — Test Tool family.** "Exposed through the same exact-allowlisted Test Tool" becomes "the
   same exact-allowlisted Test Tool **family** (three tool IDs)". The allowlisting property is
   preserved — each ID is separately deniable — but the surface is three tools, not one.
2. **#3 — Housekeeping trigger.** "Whenever any plugin instance starts" becomes "**triggered by**
   any plugin instance start, **at most once per interval**" (one hour, tracked as
   `lastHousekeepingAt` in the global registry). Without this, an unconfigured project pays for
   user-wide maintenance on every session start.
3. **#6 — Configuration schema.** A new **optional `runtime` field** under `schemaVersion` 1,
   documented as **machine-local**; a relative value resolves against the trusted root. A committed
   configuration must not assume one machine's absolute layout.
4. **#6 — Configuration presence.** The configuration file's **presence becomes the per-project
   enablement marker**. Its fields remain optional; its existence is now required for the Test Tool
   to register at all. This amends #6's position that configuration is optional. #3's user-wide
   housekeeping still runs regardless of the marker, so abandoned or de-marked roots remain
   covered; only root-local reconciliation is gated on enablement.

## Deferral closure (ADR 0001)

Both of ADR 0001's open deferrals are closed here.

1. **Test framework / language** → **TypeScript, Bun, and `bun:test`.** This settles all four
   validation layers with a single toolchain and no npm test dependency.
2. **Byte-cap eviction mechanism** → **sparse files via `node:fs`.** The documented
   size-injection seam is **dropped**. Zero-dependency shipped code makes the filesystem route the
   only one that needs no helper package, and it exercises byte accounting against the real
   filesystem without real disk consumption, which was the actual constraint.

## Consequences

- Installation is a git clone plus one machine-local config entry; no npm publication, no committed
  manifest, no dependency install step of our own.
- A globally installed plugin stays invisible in projects that have not opted in, at a
  sub-millisecond cost per session start.
- Host truncation is unreachable whenever the host's limits can be read, so the model can never
  receive a truncation-directory pointer it cannot read. When they cannot be read, the adapter
  holds to a conservative floor and says so — see the amendment under *Output budget* (issue #82).
- The model's entire view of a Test Run is deterministic, byte-exact, and golden-tested; changes to
  it are visible in review.
- Bun becomes a genuine prerequisite on machines where `opencode` was installed as a compiled
  binary. The failure is explicit and names the fix.
- Host-version drift is surfaced but never blocking; the enumerated tested set means adding a
  version is a recorded decision.
- The restricted-agent templates are tested artifacts, so a permission regression breaks the gate
  rather than silently widening what an agent can do.
- Adapter wiring is validated end-to-end for the first time; map #1's destination becomes claimable
  only once that gate passes.

## Established at implementation time

Facts later work settled, each of which the ADR had either assumed or left open. The first three
come from the adapter-inclusive gate (issue #14).

1. **A source-loaded plugin must be able to resolve `@opencode-ai/plugin` from its own checkout.**
   The ADR expected an unresolved import to "fail loudly"; in practice the host swallows the
   module-load error, and the plugin loads nothing and says nothing — indistinguishable from a
   project that has not opted in. Installation therefore has a scripted step
   (`scripts/link-host-package.ts`) that symlinks the package OpenCode installed in its config
   environment into the checkout, where source-loaded code resolves imports. This does not make it
   a repository dependency: nothing is committed, and shipped code still imports it exactly once,
   in `src/adapter`.

2. **`worktree` is not always a project root.** A host that finds no git worktree reports `/`
   rather than omitting the field. Taking it at face value makes the filesystem root the trusted
   root, which silently disables the plugin in every non-git project and would key artifact storage
   and container discovery to the whole filesystem. The trusted root now treats `/` and the empty
   string as absent and falls back to `context.directory`.

3. **The stub-provider route for (b2) works**, so execution-level validation gates with the full
   scenario set rather than degrading to a checklist. See the deferral note above.

4. **Shared DerivedData is keyed by canonical container, not by trusted root** (issue #26).
   "Shared" was written as shared *across runs*, and one directory per trusted root reads like the
   same thing right up to the point where a repository holds two Xcode containers — which is
   ordinary. Both would then write one DerivedData and overwrite each other's build products, so
   every run after a switch pays a full rebuild and reads a cache that describes something else. A
   cache that makes builds slower and results less trustworthy is not a cache. The key is a hash of
   the canonical container path, for the same reason the root key is a hash: storage must not spell
   out where anyone's code lives. Isolated mode is unaffected — it was already per-run.

### Test seams in shipped interfaces

ADR 0001 dropped its documented size-injection seam in favour of exercising the
real mechanism, and that direction still holds wherever the real mechanism is
reachable. Two seams nonetheless live in shipped interfaces, recorded here so
they are deliberate rather than accidental:

- `ServiceEnvironment.xcresultToolFor` — how a Result Bundle is read. The
  recovery path interprets artifacts left by a process that is gone; without
  this, exercising it would require a machine with Xcode, which the unit suite
  must not.
- `AdmissionOptions.newRunId` — how a run id is allocated. A collision is
  otherwise astronomically rare, and the property under test is precisely what
  happens when one occurs.
- `ServiceEnvironment.killProcess` / `identifyProcess` (issue #35) — how an
  unhandshaken supervisor is signalled, and how the machine is asked whether it
  is still there. "The signal could not be delivered" is not a state a real
  machine can be asked to produce on demand, and it is the one that decides
  whether a trusted root is held or released.
- `bootHost.port` (issue #133) — an explicit requested OpenCode port for the
  B1 host test. Holding it lets the test reproduce a new host failing while a
  client at that fixed endpoint still reaches the existing listener.

Both default to the real implementation and are overridden only by tests. Where
a real mechanism *is* reachable — locks, atomic renames, apparent file size —
it continues to be used directly.

## Risks accepted

- The stub-provider route for (b2) is mechanically available but unverified at decision time. The
  fallback is recorded, not silent, and execution-level validation is required either way.
- Bun caches failed module resolution permanently within a process, so a broken import cannot
  self-heal on retry. Startup structural verification is what turns that into an immediate, legible
  failure.
- A worktree with two session directories produces two plugin instances against one trusted root.
  #3's cross-process FIFO and root lock carry this; the try-lock-without-wait rule keeps the second
  instance from duplicating work or delaying startup.
