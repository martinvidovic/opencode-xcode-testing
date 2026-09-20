# Xcode Test Tool

> **Work in progress.** This is an early build being hardened against a real
> Xcode install, and some of its edges show it: paths are absolute throughout,
> installation is a manual symlink, and the shape of a tool's arguments may
> still change between commits. It works, and it is not yet settled.

A local OpenCode capability for running scoped Xcode tests while exposing only
trustworthy, compact results to the model.

It runs `xcodebuild test` against an explicit Requested Scope, keeps the full
diagnostics on disk and out of the model's context, and reports a compact
result that carries enough evidence to reject a false success — including the
case a naive wrapper gets wrong, where a filter matched no tests at all and
`xcodebuild` exits zero.

The capability is three separately-deniable tools:

| Tool | Purpose |
| --- | --- |
| `xcode_test` | Run a Test Run against an explicit Requested Scope. |
| `xcode_test_inspect` | Read deeper into a finished Test Run, without rerunning it. |
| `xcode_test_recover` | Clear a stuck execution slot. Takes no arguments. |

Three IDs rather than one multiplexed tool, because that is what makes exact
allowlisting meaningful: an agent can be given the ability to run tests without
being given the ability to clear a quarantine.

## Requirements

- **macOS with Xcode 26.** The tool reads Result Bundles back with the same
  toolchain that wrote them, and claims exactly one Xcode major.
- **Bun on `PATH`.** See below — this is the prerequisite people are most
  likely to be missing.
- **OpenCode `1.18.29` or `1.18.30`.** Other versions load normally and emit a
  one-time startup diagnostic; the plugin never refuses to load over a patch
  bump.

### Bun is a real prerequisite

The plugin ships as source with no build step, so its supervisor process is
spawned as TypeScript and needs a runtime that can execute it.

A Homebrew-installed `opencode` is a **Bun-compiled single-file executable**.
It reports a Bun version, but it cannot run a `.ts` file — so having `opencode`
installed implies nothing about Bun being available. If `bun` is not on your
`PATH`, install it:

```bash
curl -fsSL https://bun.sh/install | bash
```

The plugin probes candidates in order and **verifies each one actually runs a
trivial script** rather than trusting a version string:

1. an explicit `runtime` path in the project configuration,
2. `opencode`'s own executable — expected to fall through, for the reason above,
3. `bun` on `PATH`.

If none works, a Test Run fails closed with `runnerFailure`, naming Bun, the
candidates it probed, and the configuration key that would fix it. There is no
silent fallback.

## Installation

Clone the repository somewhere stable. The path becomes machine-local
configuration, so pick a location you will not move.

```bash
git clone https://github.com/martinvidovic/opencode-xcode-testing.git
cd opencode-xcode-testing
bun scripts/link-host-package.ts
```

### Why that second command is not optional

A source-loaded plugin resolves its imports from **its own** location, not from
OpenCode's config directory — so a checkout with no `node_modules` cannot find
`@opencode-ai/plugin`, and the host swallows the module-load error. The result
is a plugin that loads nothing and says nothing, which is indistinguishable from
a project you have not enabled yet.

`link-host-package.ts` symlinks the package OpenCode installed and manages in
its config environment into this checkout. It is a symlink rather than an
install because the package is host-managed and this repository commits no
manifest for it; the link is still necessary because source-loaded code resolves
imports from the checkout. Run OpenCode once first if the script reports the
package is not there yet.

### Global install (the documented default)

Install once per machine, in OpenCode's own config directory:

```json
{
  "plugin": ["/absolute/path/to/opencode-xcode-testing/src/adapter/plugin.ts"]
}
```

in `~/.config/opencode/opencode.json`. Or, equivalently, symlink the plugin
**file** into OpenCode's plugin directory:

```bash
mkdir -p ~/.config/opencode/plugin
ln -s /absolute/path/to/opencode-xcode-testing/src/adapter/plugin.ts \
  ~/.config/opencode/plugin/xcode-test.ts
```

The link points at the file, not at the checkout: OpenCode loads `.ts` files
from that directory and has no way to pick an entry point out of a repository.
The symlink still resolves its imports from the real checkout, which is what
lets the host-provided `@opencode-ai/plugin` link above do its job.

**Why global is the default:** the entry contains an absolute path that is true
only on your machine. `~/.config/opencode/opencode.json` is the one file that is
never committed to a project repository, so that is where a machine-local path
belongs. A globally installed plugin stays completely invisible in projects that
have not opted in, at a sub-millisecond cost per session start.

### Per-project install (the alternative)

A project's own `opencode.json` also accepts an absolute `plugin` entry:

```json
{
  "plugin": ["/absolute/path/to/opencode-xcode-testing/src/adapter/plugin.ts"]
}
```

This works, but the caveat is real: that path is machine-local, and committing
it means the file is wrong for every colleague and every CI machine. Use it for
a checkout you are not sharing.

## Enabling it for a project

Installation alone registers nothing. The plugin registers its tools only when
this file exists:

```
<configuration-root>/.opencode/xcode-test.json
```

The minimum is one line:

```json
{ "schemaVersion": 1 }
```

**Absent, the plugin registers nothing and says nothing.** "This is not an Xcode
project" is a normal state, not a diagnostic — so a global install does not put
Xcode tools in front of a model working on a Rust service.

This file is the enablement marker *and* the project configuration. Its fields
are all optional:

```json
{
  "schemaVersion": 1,
  "xcodeContainer": { "kind": "workspace", "path": "Example.xcworkspace" },
  "scheme": "App",
  "destination": { "kind": "named", "platform": "iOS Simulator", "name": "iPhone 17" },
  "derivedData": { "mode": "shared" },
  "timeoutSeconds": 900
}
```

| Field | Resolution when omitted |
| --- | --- |
| `xcodeContainer` | Discovered beneath the containment root. Exactly one workspace wins; only if there are no workspaces are projects considered. Two of either is a structured ambiguity you must resolve, never a guess. |
| `scheme` | Discovered from **checked-in shared schemes only**, and only when there is exactly one. A scheme under `xcuserdata` exists on one machine and would make discovery depend on whose laptop it ran on. |
| `destination` | **Required.** There is no safe default: guessing one runs your tests somewhere you did not ask for. |
| `derivedData` | `shared`. Use `isolated` for a per-run directory. |
| `timeoutSeconds` | `900`. Range is 1 to 7200. |

The plugin tracks two root roles explicitly. The **containment root** is the
canonical safety boundary used for discovery, container paths, execution, and
diagnostics. The **configuration root** is the nearest directory with this
configuration found from OpenCode's canonical launch directory through the
containment root, inclusive. The search never reads above containment. A
non-Git session safely uses its launch directory as both boundaries. If no
configuration exists in that range, the plugin registers nothing and says
nothing.

Each containment/configuration pair has separate Test Run artifacts, Execution
Slots, Read Leases, recovery, retention, and housekeeping state. A root-level
configuration retains the existing storage identity.

Container paths are containment-root-relative, and are rejected if they
traverse out of containment or resolve outside it through a symlink. A module
configuration can therefore name a container anywhere within its containment
root, for example `"Shared/App.xcodeproj"`, rather than using `../` paths.

### `runtime` is machine-local

The configuration also accepts an optional `runtime` path for a Bun that is not
on `PATH`:

```json
{ "schemaVersion": 1, "runtime": "/absolute/path/to/bun" }
```

Treat this like the `plugin` entry: it describes one machine. A relative value
resolves against the configuration root, which is the only form worth committing. An
explicit `runtime` that is set but unusable is a **hard error, never a
fallback** — a setting that silently degrades is worse than one that fails.

## Restricted agents

A plugin cannot register an agent, so the agents ship as committed templates in
[`examples/agent/`](examples/agent). They contain no absolute paths, so unlike
the plugin entry they are portable and a team can share them.

Copy the one you want into your project:

```bash
mkdir -p .opencode/agent
cp /absolute/path/to/opencode-xcode-testing/examples/agent/xcode-test-runner.md .opencode/agent/
```

| Template | Shape |
| --- | --- |
| `xcode-test-runner.md` | A subagent with the three test tools and nothing else. No shell, no file access. |
| `xcode-developer.md` | A primary agent that can read and edit code and run tests, but has no shell. |

Both use `permission:` rules, never the deprecated `tools:` map, and both open
with a catch-all:

```yaml
permission:
  "*": deny
  xcode_test: allow
  xcode_test_inspect: allow
  xcode_test_recover: allow
```

Two details matter here. Rules are **last-match-wins with key order preserved**,
so the catch-all has to come first and the specifics after — the reverse order
denies everything. And a rule whose pattern is exactly `"*"` with action `deny`
**hides** the remaining tools from the model entirely, rather than blocking them
at call time. For a restricted agent that is the point: `bash` is not something
the model is refused, it is something the model never sees.

These templates are asserted by the acceptance gate, which materializes these
exact files and checks that the resulting permission ruleset hides `bash` while
exposing the family. They are tested artifacts, not documentation that drifts.

## What the tool will not do

The design is deliberately narrow, and the boundaries are worth knowing before
you reach for them:

- **No arbitrary shell.** Every Test Run spawns `/usr/bin/xcodebuild` with a
  fixed `test` action and runner-generated arguments. There is no executable,
  command, argument array, environment override, working directory or shell
  fragment a caller can supply. (Your project's own build-phase scripts still
  run — the repository is trusted. The guarantee is that *model-controlled
  input* cannot select arbitrary execution.)
- **No automatic reruns.** A flaky test that passes on retry is information, not
  noise. Start another Test Run yourself if you want one.
- **No private or artifact paths in results.** Nothing a result carries names
  where on this machine anything lives. Result Bundles, DerivedData and logs
  live outside your repository, under `~/Library/Application Support/opencode-xcode-test`
  — so a `git clean` cannot destroy an in-flight run's evidence — and that
  location never appears in a result: the only handle to it is an opaque run
  id. Absolute paths, home directories and temporary directories are withheld
  from every message, including the text of an error that happened to quote
  one.

  What a result *does* carry is the repository-relative container path you
  configured, and bounded source locations for failures and build errors —
  `Sources/App/Login.swift:42`, relative to the containment root when the file is
  inside it, and reduced to the bare filename when it is not. Those are the
  point: a diagnostic nobody can locate is a diagnostic nobody can act on.
- **One Test Run at a time per containment/configuration storage scope.** Isolated DerivedData alone does not
  make concurrent simulator, device or package-cache use trustworthy, so runs
  are serialized across processes.
- **Logs are never classified on.** Raw log text is version-dependent, possibly
  localized, and written by your repository. It is retained in full and
  inspectable on request, but it never decides whether a run passed.

## Development

```bash
bun run check
```

`bun run check` is the gate: the strict TypeScript check, then the unit suites
and the import and hygiene lints, all ordinary `bun:test` suites. **The local
quality gate** below says why it is one command and how to run either half on
its own.

The project has **zero runtime dependencies** — shipped code may import only
`node:*` built-ins plus exactly one `@opencode-ai/plugin` import confined to
`src/adapter`, and that is enforced by a lint rather than by convention.

```
src/domain/       shared typed results and the CONTEXT.md vocabulary
src/runner/       Xcode runner, supervisor, admission, retention, recovery
src/interpreter/  xcresult interpretation
src/adapter/      plugin entrypoint, tool definitions, renderer
scripts/          fixture generation, freshness check
examples/agent/   restricted-agent templates
```

### The local quality gate

One command, and it has to pass before a change is done:

```bash
bun run check     # the TypeScript contract, then the unit and lint suite
```

Either half on its own, for fixing one kind of problem at a time:

```bash
bun run typecheck # the TypeScript contract, over src, test and scripts
bun test          # the unit and lint suite
```

**Why the type check is part of the gate and not a formality.** Bun strips
types rather than checking them, so a strict `tsconfig.json` sitting in a
repository nothing ever compiles is a configuration everybody can see and
nobody can fail. This one had been that for its whole life, and 240 errors had
accumulated behind it — including a scenario-name union that had collapsed to
`never`, two acceptance-gate types naming identifiers nothing defined, and a
validator reading a field off a type with no such field. None of it could fail
a test, because none of it runs.

The compiler is pinned to an exact version and run through Bun rather than
through its own shebang: this repository needs nothing but Bun, and a `node`
shim on the path is enough to stop the bare binary. CI is a separate decision;
what this establishes is that the check exists, is repeatable, and is green.

**It is a development dependency, and the distinction matters.** The
zero-runtime-dependency rule is about the *plugin*: it is loaded from source
and resolves its imports from its own location, so anything it imports has to
be there on a user's machine. A compiler and a set of type declarations run on
a developer's machine and are never imported by shipped code. `dependencies`
stays empty; `devDependencies` holds exactly `typescript` and `@types/bun`,
and a test asserts both of those facts so the line cannot drift.

Two more commands are worth knowing:

```bash
# Generate a real, buildable Xcode fixture project (no sample project is committed)
bun scripts/generate-fixture-project.ts --out /tmp/fixture

# Check whether the committed fixtures still match this machine's Xcode
bun scripts/freshness-check.ts
```

The freshness check is **non-fatal by design**. Drift means the fixtures are
stale, not that the tool is wrong, and a check that broke the build on a routine
Xcode update would be switched off within a week.

### The acceptance gate

`bun run check` needs Bun and this checkout's installed development dependencies
(`bun install`). It does not require OpenCode, Xcode, a simulator, a linked host
package, or a real OpenCode host. The acceptance gate needs a real machine —
Xcode, a simulator, OpenCode, and the host-package link from the installation
steps above — because it is the only thing that proves the whole path works
rather than that each piece agrees with its own tests:

```bash
bun scripts/acceptance-gate.ts            # everything
bun scripts/acceptance-gate.ts --layer4   # runner + interpreter, real xcodebuild
bun scripts/acceptance-gate.ts --b1       # headless registration, credential-free
bun scripts/acceptance-gate.ts --b2       # execution through a scripted model turn
```

It generates its own Xcode project, so it depends on nothing private and
nothing committed beyond this repository. Every run writes a durable report —
selected suites, observed toolchain, host version, resolved runtime,
destination, per-scenario results and freshness drift — into the tool-managed
storage root, never anywhere this repository could accidentally track it. That
includes runs that fail before a scenario starts: an invocation that left no
trace is one nobody can check afterwards.

When Layer 4 **fails**, it keeps the run evidence a diagnosis needs — Run
Records, raw logs, the normalized index and the Result Bundles — beside the
report, under the same key, owner-only. A passing run keeps nothing: its
workspace is regenerable, and its evidence would prove only what the report
already says. The store is bounded by age, by count and by bytes, and a single
run's evidence too large for the whole budget is discarded rather than granted
an exception — an unbounded diagnostic aid is a disk that fills up quietly.
The report names the key and never a path.

A `--project` run that fails keeps evidence about **your** project: the Run
Records, logs and Result Bundles of runs against it name its scheme, its tests
and where it lives. The report itself still records only that a project was
supplied. That is the trade — private, owner-only, bounded, and yours to delete
— and it is the reason the evidence store is not somewhere the repository could
ever reach.

`--project <path>` additionally runs against a real Xcode project you own:

```bash
bun scripts/acceptance-gate.ts --layer4 --project ~/code/MyApp
```

Those scenarios are **report-only**, always. The standing gate has to be
reproducible from committed files by anyone, and a green run that depended on a
project only one person has is a claim nobody else can check — so a supplied
project adds evidence and never supplies the verdict.

Three things are deliberately failures rather than skips, because each one
would otherwise report green on a machine where nothing was verified: no usable
simulator, an option the gate does not recognize, and a selection that ran no
gating scenario.

## Design record

The vocabulary is in [`CONTEXT.md`](CONTEXT.md); the decisions are in
[`docs/adr/`](docs/adr). Start with
[ADR 0002](docs/adr/0002-opencode-v1-adapter-and-restricted-agent-integration.md)
if you want to know why installation works the way it does.
