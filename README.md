# Xcode Test Tool

> **Work in progress.** This is an early build being hardened against a real
> Xcode install, and some of its edges show it: paths are absolute throughout,
> installation is a machine-local `plugins` entry, and the shape of a tool's
> arguments may still change between commits. It works, and it is not yet settled.

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
- **OpenCode `2.0.25`, and only V2.** This is the one release the tool is
  validated against, together with `@opencode/plugin` and `@opencode/client`
  at exactly `2.0.25`. Other 2.x releases load normally and emit a one-time
  startup diagnostic; nothing here claims blanket V2 compatibility. OpenCode V1
  is not supported — a V1 plugin does not run on V2, and this one does not run
  on V1. See [ADR 0003](docs/adr/0003-opencode-v2-migration.md).

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
bun install
bun scripts/check-install.ts
```

### What `bun install` is for

The plugin itself needs **nothing installed to load**. Its only non-built-in
import is `@opencode/plugin`, and OpenCode V2 resolves that to its own copy for
every plugin it loads — a clean checkout with no `node_modules` registers the
tools, and the acceptance gate proves it from exactly such a copy.

`bun install` installs the two packages this checkout pins exactly —
`@opencode/plugin` and `@opencode/client`, both `2.0.25` — which the type
check and the acceptance gates run against. `bun scripts/check-install.ts`
says whether the `opencode` on your `PATH` is the validated release and
whether what is installed is what the checkout pins, and names the command
that fixes anything that is not.

### Global install (the documented default)

Add the checkout to `plugins` in `~/.config/opencode/opencode.json` (or
`opencode.jsonc`):

```json
{
  "plugins": ["/absolute/path/to/opencode-xcode-testing"]
}
```

The entry names the **checkout directory**, not a file. OpenCode 2.0.25 accepts
a configured plugin only as a directory and loads its `server.ts`, which is
there for exactly that. A path to a `.ts` file in `plugins` is rejected with
`configured plugin path must be a directory`.

Or, equivalently, symlink the plugin's entry file into OpenCode's plural
`plugins/` directory, which it discovers on its own:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s /absolute/path/to/opencode-xcode-testing/src/adapter/plugin.ts \
  ~/.config/opencode/plugins/xcode-test.ts
```

**Why global is the default:** the entry contains an absolute path that is true
only on your machine. `~/.config/opencode/opencode.json` is the one file that is
never committed to a project repository, so that is where a machine-local path
belongs. A globally installed plugin loads in every Location OpenCode opens and
stays completely invisible in projects that have not opted in.

OpenCode watches its configuration, so adding, changing or removing the entry
takes effect without a restart.

### If you lower `tool_output`

The tool keeps every response under OpenCode's output limits, because a
truncated response is replaced by a pointer to a file the model cannot open.
On V2 a plugin has no way to read those limits, so the tool assumes OpenCode's
defaults — 2,000 lines and 51,200 bytes, verified against 2.0.25. If you set
`tool_output` lower than that, give the plugin the same numbers:

```json
{
  "tool_output": { "max_lines": 300, "max_bytes": 4096 },
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-xcode-testing",
      "options": { "tool_output": { "max_lines": 300, "max_bytes": 4096 } }
    }
  ]
}
```

An option it cannot read holds responses to a conservative floor and says so on
startup.

### Per-project install (the alternative)

A project's own `opencode.json` — or `.opencode/opencode.json` — accepts the
same `plugins` entry:

```json
{
  "plugins": ["/absolute/path/to/opencode-xcode-testing"]
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
| `testLanguage` | Scheme default. Set e.g. `"en"` to pass `-testLanguage en`. |
| `testRegion` | Scheme default. Set e.g. `"US"` to pass `-testRegion US`. |

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

Treat this like the `plugins` entry: it describes one machine. A relative value
resolves against the configuration root, which is the only form worth committing. An
explicit `runtime` that is set but unusable is a **hard error, never a
fallback** — a setting that silently degrades is worse than one that fails.

## Restricted agents

A plugin does not register agents here, so the agents ship as committed
templates in [`examples/agent/`](examples/agent). They contain no absolute
paths, so unlike the plugin entry they are portable and a team can share them.

Copy the one you want into your project's plural `agents/` directory:

```bash
mkdir -p .opencode/agents
cp /absolute/path/to/opencode-xcode-testing/examples/agent/xcode-test-runner.md .opencode/agents/
```

| Template | Shape |
| --- | --- |
| `xcode-test-runner.md` | A subagent with the three test tools and nothing else. No shell, no file access. |
| `xcode-developer.md` | A primary agent that can read and edit code and run tests, but has no shell. |

Both use V2's ordered `permissions` rules and open with a catch-all:

```yaml
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: xcode_test
    resource: "*"
    effect: allow
  - action: xcode_test_inspect
    resource: "*"
    effect: allow
  - action: xcode_test_recover
    resource: "*"
    effect: allow
```

Two details matter here. The **last matching rule wins**, so the catch-all has
to come first and the specifics after — the reverse order denies everything.
And each tool's permission action is its own ID, so each can be allowed or
denied on its own: an agent can run tests without being able to clear a
quarantine. The shell (`shell` on V2) and Code Mode (`execute`) are never
allowed back, and a model under either template is not offered them at all.

The Test Tools are registered outside Code Mode, so a restricted agent reaches
them directly without being granted `execute` — which would be authority over
every other tool's catalog, and nothing a test run needs.

These templates are asserted by the acceptance gate, which installs these exact
files in an isolated OpenCode, reads the effective permissions OpenCode
resolves for them, and checks what a model under each is actually offered.
They are tested artifacts, not documentation that drifts.

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
`node:*` built-ins plus `@opencode/plugin` confined to `src/adapter`, and that
is enforced by a lint rather than by convention.

```
src/domain/       shared typed results and the GLOSSARY.md vocabulary
src/runner/       Xcode runner, supervisor, admission, retention, recovery
src/interpreter/  xcresult interpretation
src/adapter/      plugin entrypoint, tool definitions, renderer
server.ts         the checkout's entry as a V2 plugin directory
scripts/          fixture generation, freshness check, install check, acceptance gate
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

**They are development dependencies, and the distinction matters.** The
zero-runtime-dependency rule is about the *plugin*: it is loaded from source,
so anything it imports has to be there on a user's machine. A compiler and a
set of type declarations run on a developer's machine and are never imported
by shipped code; `@opencode/plugin` is imported, but OpenCode supplies its own
copy at runtime; and `@opencode/client` is the acceptance gate's.
`dependencies` stays empty; `devDependencies` holds exactly `typescript`,
`@types/bun`, `@opencode/plugin` and `@opencode/client`, the last two pinned to
`2.0.25`, and a test asserts all of that so the line cannot drift.

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
(`bun install`). It does not require OpenCode, Xcode, a simulator, or a real
OpenCode host. The acceptance gate needs a real machine — Xcode, a simulator,
OpenCode 2.0.25 on `PATH`, and `bun install` — because it is the only thing
that proves the whole path works rather than that each piece agrees with its
own tests:

```bash
bun scripts/acceptance-gate.ts            # everything
bun scripts/acceptance-gate.ts --layer4   # runner + interpreter, real xcodebuild
bun scripts/acceptance-gate.ts --b1       # registration, permissions, isolation, installation
bun scripts/acceptance-gate.ts --b2       # execution through a scripted model turn
```

B1 and B2 never touch your own OpenCode. Each starts a private `opencode serve`
with its own configuration, data, state and cache directories and its own
password, never the shared background service, and only drives a server that
reports the process it started. Its only model is a local stub that emits
scripted tool calls, so neither needs a credential or the network.

It generates its own Xcode project, so it depends on nothing private and
nothing committed beyond this repository. Every run writes a durable report —
selected suites, observed toolchain, host and package versions, resolved runtime,
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

The vocabulary is in [`GLOSSARY.md`](GLOSSARY.md); the decisions are in
[`docs/adr/`](docs/adr). Start with
[ADR 0003](docs/adr/0003-opencode-v2-migration.md) if you want to know why
installation works the way it does; it supersedes the V1-specific parts of
[ADR 0002](docs/adr/0002-opencode-v1-adapter-and-restricted-agent-integration.md),
which is kept as the record of how the V1 integration was decided. The V2 host
facts both rest on are in
[`docs/v2-contract-verification.md`](docs/v2-contract-verification.md).
