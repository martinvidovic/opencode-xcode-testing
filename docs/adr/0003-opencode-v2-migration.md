# ADR 0003: OpenCode V2 migration

- **Status:** Accepted
- **Date:** 2026-10-08
- **Decides:** [#139 — Migrate the Xcode Test Tool to OpenCode V2](https://github.com/martinvidovic/opencode-xcode-testing/issues/139), through #140, #141, #142 and #143
- **Supersedes, in part:** [ADR 0002](0002-opencode-v1-adapter-and-restricted-agent-integration.md). The sections named below are superseded; everything else in ADR 0002 stands.
- **Evidence:** [`docs/v2-contract-verification.md`](../v2-contract-verification.md)

## Context

ADR 0002 decided how the Test Tool reaches an OpenCode **V1** host. OpenCode V2 replaces the
plugin API, the client, the configuration keys and the permission model, and V1 plugin
implementations do not run on it. The Test Tool had to move, and every V1 fact ADR 0002 relied on
had to be re-established rather than assumed to carry over.

So the migration began by verifying, not by porting (#140). Every V2 fact this ADR relies on was
read from the published package types or observed on an isolated `opencode serve` — never the
user's shared service — and is recorded with its evidence in `docs/v2-contract-verification.md`.
Where the V2 documentation and the 2.0.25 host disagree, the host wins.

What did not change is the substance: three separately-deniable tools, the containment and
configuration roots, the domain contracts, the renderer, the runner and the interpreter. Runner,
interpreter and domain still import nothing from OpenCode.

## Decision

### Support policy

**V2 only.** There is no V1/V2 dual-export window. A temporary one was possible — V2's plugin
migration guide documents one default export carrying both `server()` and `setup()` — and was
declined by the maintainer: it doubles the adapter and
gate surface for a host the project no longer needs to run on.

**Validated against exactly one release:** OpenCode `2.0.25`, with `@opencode/plugin` `2.0.25` and
`@opencode/client` `2.0.25`. The tested host set is `["2.0.25"]`. Other 2.x hosts load normally
and get the existing one-time untested-version diagnostic; a different major is a provenance
problem in the acceptance gate. Nothing here claims blanket V2 compatibility, and adding a version
remains a deliberate, recorded act.

### Entrypoint and registration

*Supersedes ADR 0002 "Registration and loading".*

`src/adapter/plugin.ts` default-exports `Plugin.define({ id: "xcode-test", setup })`. All of
`setup`'s decisions live in the host-free `src/adapter/setup.ts`; the entrypoint reads three host
handles — `ctx.location`, `ctx.app.version`, `ctx.options` — and registers the result through one
synchronous, replayable `ctx.tool.transform`.

- `setup` runs **once per Location, in the background**, and the host holds that Location's
  prompts until it returns. ADR 0002's "factory awaited before every other host service" is gone,
  and with it the bootstrap deadlock its amendment worked around.
- `setup` **never throws.** On V2 a throw marks the plugin `failed` with its full stack — private
  paths included — readable through `plugin.list`. Every failure is contained, sanitized and
  reported on stderr.
- No cleanup is returned. Registrations are disposed by the host with the plugin; process cleanup
  and reconciliation remain the supervisor's crash-tolerant paths, and a cleanup hook that
  signalled processes would run on every hot reload.

**Installation** is a `plugins` entry naming the **checkout directory**, or the entry file
symlinked into the config directory's plural `plugins/`. 2.0.25 rejects a configured plugin
*file* path and resolves a configured directory to `<directory>/server` then `<directory>/index`,
never `package.json` `main` or `exports` — so the checkout carries a root `server.ts` that
re-exports the entrypoint. Global installation in `~/.config/opencode/` remains the documented
default, for ADR 0002's reason: it is the one file never committed to a project.

### Tool surface

*Supersedes ADR 0002 "Tool surface" where it names Zod and named exports.*

The three IDs are unchanged: `xcode_test`, `xcode_test_inspect`, `xcode_test_recover`.

- **No namespace.** The permission action is the effective tool name; a namespace would rename
  every key an agent allowlists.
- **Out of Code Mode.** On 2.0.25 a tool registered with default options is offered to a model
  **only through `execute`**. A restricted agent has `execute` denied, so it would see no Test Tool
  at all. Each tool is registered with `codemode: false`, which makes it first-class and
  separately deniable without granting Code Mode authority.
- **JSON Schema, not Zod.** ADR 0002's rule that schemas be Zod — and its rejection of the legacy
  JSON-Schema fallback that marked every key required — no longer applies: V2 takes JSON Schema
  directly, validates calls against it before `execute` (refusing missing keys, short strings and
  wrong types, and stripping unknown keys), and honours `required`. The schemas are plain data in
  `src/adapter/schema.ts`. Domain validation is retained in full; host validation is a
  convenience, not a guarantee the adapter relies on.
- **Structured results.** Each call returns `{ content: [{ type: "text", text }] }` wrapping the
  unchanged renderer output, and no `metadata`. Renderer goldens are unchanged.

### Roots

*Supersedes ADR 0002 "Containment root and configuration root" where it names the V1 handles.*

`context.worktree` becomes `ctx.location.project.directory`; `context.directory` becomes
`ctx.location.directory`. For a linked worktree, `project.directory` is the worktree itself, so
two worktrees of one repository keep separate containment roots and storage identities, as on V1.
`project.canonical` names the main checkout and is **never** used as a boundary. A non-Git
Location reports its own directory rather than `/`; the guard against `/` remains as defence in
depth. The configuration-root search and storage identity are unchanged.

### Output limits

*Supersedes ADR 0002 "Rendering and the output budget" where it reads host limits, and its #37
and #82 amendments.*

V2 truncates plugin tool output at 2,000 lines and 51,200 bytes by default, honours a configured
`tool_output`, and **re-reads it live** when a watched config file changes. Truncation replaces
the output with a notice naming an absolute path, so the invariant that host truncation is
unreachable still matters. But **a V2 plugin has no supported route to the effective limits**:
the plugin context has no configuration domain, and the client route returns raw per-file
documents.

So the adapter budgets against the **verified V2 defaults** unless the user declares lower limits
in the plugin's options, in the same `tool_output` shape. A declaration it cannot read holds
responses to the existing conservative floor and is announced once. Options are re-read per
plugin instance, and the host rebuilds instances on every config change, so they cannot go stale.

This is a **regression from V1, accepted**: the guarantee is now unconditional only while the
user's `tool_output` is at or above the defaults or is also declared to the plugin. The README
says so where a user setting `tool_output` will read it.

### Context bridge, cancellation and metadata

*Supersedes ADR 0002 "Running metadata" and "Cancellation" where they name V1 handles.*

`context.abort` becomes `context.signal`; `context.metadata` becomes `context.progress`, which
carries the same durable protocol states and `runId`, fire-and-forget so a failing channel never
costs a result. An abort that lands before the run starts listening now still reaches the
supervisor; on V1 that window silently lost the cancellation.

V2 records an interrupted call as aborted **immediately and discards the executor's late
result**. The 30-second abort wait is kept, because it bounds how long cancellation takes to reach
the supervisor, and the supervisor still owns terminal publication; the `runId` the model needs
afterwards has already been published through `progress`.

*Supersedes ADR 0002 "Throw semantics" where it describes V1's `output-error` part.* On V2 a thrown
error becomes the tool part's `error`, and the model sees its message. The rule is unchanged:
domain outcomes are ordinary results, and only adapter defects throw, with no paths in the
message.

### Host version

*Supersedes ADR 0002 "Host-version policy" and the host-version item of "Plugin-startup budget".*

The version is `ctx.app.version`. ADR 0002's bounded `GET /global/health` read is gone. The
warn-and-record policy and the recorded provenance are unchanged.

### Restricted agents

*Supersedes ADR 0002 "Restricted agent" where it describes V1 syntax.*

The templates use V2's ordered `permissions:` list of `{ action, resource, effect }` rules: a
`*`/`*`/`deny` catch-all first, then exact allows. The last matching rule wins. `shell` replaces
`bash`; `edit` covers write and patch; V1's `list`, `todoread` and `todowrite` have no V2 action
and are dropped. Neither template allows `shell` or `execute`. Templates go in the plural
`.opencode/agents/`. They stay manually installed, portable templates: migration does not
require automatic agent registration, and none is introduced.

### Package provisioning

*Supersedes ADR 0002 "Dependency posture" where it describes the host-managed package link.*

`@opencode/plugin` and `@opencode/client` are **exact-pinned devDependencies** of this checkout,
installed with `bun install`. `scripts/link-host-package.ts` and the V1 model it served — a
host-managed `@opencode-ai/plugin` symlinked into the checkout so the plugin could load at all —
are retired.

At runtime V2 resolves `@opencode/plugin` to the host's own instance for every plugin it loads, so
**a clean checkout with no `node_modules` loads and registers the tools**; the acceptance gate
proves it from such a copy. The pinned packages exist for type-checking and the acceptance gate.
`scripts/check-install.ts` says whether the host on `PATH` is the validated release and whether
the checkout's installed packages are what it pins, naming the command that fixes each.

This is an explicit change to the dependency policy: `devDependencies` grows from `typescript`
and `@types/bun` to those plus the two pinned OpenCode packages, asserted by a test.
`dependencies` stays empty, and shipped code still imports only `node:*` plus `@opencode/plugin`
confined to `src/adapter`.

### The acceptance gate

*Supersedes ADR 0002 "The adapter-inclusive gate" where it describes the V1 host and SDK.*

B1 and B2 spawn a **private** `opencode serve --port 0` with their own XDG directories and server
password — never `--service`, never `Service.ensure()`, never the user's configuration — and drive
it through the pinned `@opencode/client`. Readiness requires the child to announce its port *and*
the server answering there to report that child's pid, so a stale listener can never pass for the
host. `HOME` stays real, because Xcode and the simulators live there.

V2 has no client route that lists tools, so the local stub provider is also the witness: each
model request's `tools` array is what the host offered under that agent's effective permissions.
B1 asserts IDs, descriptions, schemas, marker silence, the templates' effective permissions and
offered tools, each tool's independent deniability, nested-module and worktree isolation, plugin
unload and reload, and both documented installation forms from a clean checkout. B2 runs every
call under the shipped `xcode-test-runner` agent and additionally checks the host's own
`truncated` flag. Provenance reads the checkout's pinned packages; the V1 rules that the packages
share one version and live in a host-managed tree are gone.

## Consequences

- One host release is validated. Moving to another is the same deliberate act ADR 0002 required:
  verify, then add it to the tested set.
- The output-limit guarantee is weaker than on V1 for a user who lowers `tool_output` without
  telling the plugin. This is documented, and reversible the day V2 exposes effective limits to a
  plugin.
- Installation is one configuration line or one symlink, with nothing installed for the plugin to
  load. Development and the acceptance gates need `bun install`.
- ADR 0002 is kept unchanged as the record of the V1 decisions and their evidence; its status
  line points here.
