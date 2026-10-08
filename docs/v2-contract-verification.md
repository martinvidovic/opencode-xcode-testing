# OpenCode V2 contract verification, 2026-10-08 (issue #140)

What the OpenCode V2 host and packages actually do, measured against a real
host before any of the migration under #139 relies on it. Every row below was
either read out of the published package types or observed on an isolated
`opencode serve` instance on this machine on this date. Where the docs and the
host disagree, the host wins and the disagreement is called out.

Nothing here was established against the user's shared background service:
every probe ran on a private `opencode serve` with its own `HOME`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`.

## Support policy (maintainer-approved)

- **V2 only.** No V1/V2 dual-export window. The V1 adapter is replaced, not
  kept beside the V2 one.
- **Validated exactly against 2.0.25** — host, `@opencode/plugin` and
  `@opencode/client` all at `2.0.25`. Other 2.x hosts load normally and get the
  existing one-time untested-version diagnostic; nothing claims blanket V2
  compatibility.
- **Package provisioning: exact-pinned dependencies.** `@opencode/plugin` and
  `@opencode/client` are declared at exactly `2.0.25` in `package.json` and
  installed with `bun install` in the checkout. `scripts/link-host-package.ts`
  and the host-managed symlink model are retired. This is a deliberate change
  to the dependency policy and is recorded in the migration ADR (#143).

## Provenance

| | |
| --- | --- |
| Host | `opencode v2.0.25` (Homebrew, Bun-compiled single-file executable), `ctx.app` = `{ name: "cli", version: "2.0.25", channel: "latest" }` |
| `@opencode/plugin` | `2.0.25` — depends on `@opencode/client`, `@opencode/schema`, `@opencode/protocol`, `@opencode/util`, `@opencode/ai` all `2.0.25`, and `effect` `4.0.0-rc.112` |
| `@opencode/client` | `2.0.25` — depends on `@opencode/schema` and `@opencode/protocol` `2.0.25` |
| npm `latest` | `2.0.25` for both packages on the date above |
| Runtime | Bun 1.4.2 |
| Docs | `opencode.ai/v2/docs/` — `migrate-v1`, `build/plugins`, `build/plugins/migrate-v1`, `build/client`, `plugins`, `permissions`, `agents`, `tools`, `config`, `providers` |

## Verified mappings

### Loading and entrypoint

| Question | Verified answer | Evidence |
| --- | --- | --- |
| Entrypoint shape | `export default Plugin.define({ id, setup })`. `Plugin.define` is the identity function; `setup(ctx)` may return a cleanup function. | `dist/promise/plugin.{js,d.ts}`; host loaded a probe built this way |
| Plugin ID | Stable string; storage and diagnostics are keyed by it. `xcode-test` is free to keep. | docs; `plugin.list` reports the ID |
| Config key | `plugins` (plural). V1 `plugin` is migrated by the host but V1 *implementations* do not run. | docs |
| **Configured file path** | **Rejected.** An absolute path to a `.ts` file in `plugins` logs `configured plugin path must be a directory` and loads nothing. The docs example showing `/absolute/path/plugin.ts` does not match 2.0.25. | host log |
| Configured directory | Loads. The host resolves `<dir>/server`, then `<dir>/index` (Node resolution of a *path*, so `.ts`/`.js` and `server/index.ts` work). `package.json` `main` and `exports` are **not** consulted; a directory with only those loaded nothing and logged nothing. The resolved entry must be inside the directory. | host loader source (`resolve` in the bundled `Host` module); probes |
| Discovered files | Direct `.ts`/`.js` files, symlinks to them, and immediate directories under `<config>/plugins/` and `<config>/plugin/` (`.opencode/` or `~/.config/opencode/`). | host loader source; docs |
| `@opencode/plugin` at runtime | Resolved by the host to its own instance. A plugin directory with **no `node_modules`** loaded and ran `Plugin.define`. | probe |
| Load timing | Per Location, in the background. `location.get` and `plugin.list` return before `setup` finishes; a plugin still in `setup` is absent from `plugin.list`. | probe with a 4 s `setup` |
| Does a prompt wait for `setup`? | **Yes.** A session prompted immediately in a fresh Location got the slow plugin's tool on its first model turn, about 4 s later. | probe |
| `setup` throws | Plugin state becomes `failed` with the error **and its stack**, which includes private paths; host logs `failed to load plugin`. | `plugin.list` |
| `process.stderr` from `setup` | Goes to the server's stderr. | probe |
| Cleanup | Runs per Location instance on file change (hot reload), on config change and on removal from config. | probe |
| Adding a plugin entry | Takes effect without a restart: the acceptance gate removes the plugin from a watched config, then restores it, and the family is offered again (issue #142, `b1 plugin reload`). | gate |
| Project-level entries | A `plugins` entry in a project's `.opencode/opencode.json` loads like a global one (issue #143, `b1 documented installation path`); the docs list `./opencode.json(c)` and `./.opencode/opencode.json(c)` beside the global file. | gate; docs |
| Dual V1/V2 export | The plugin migration guide documents one default export carrying both `server()` (V1) and `setup()` (V2) for a temporary window. Not adopted (V2-only policy). | docs |
| `process.cwd()` | The server's working directory, not the Location. Never use it. | probe |

### Location and the two roots

`ctx.location` is the **plugin instance's** Location; the host creates one
instance per Location directory.

| Situation | `location.directory` | `location.project.directory` | `location.project.canonical` |
| --- | --- | --- | --- |
| Git checkout root | `/p` | `/p` | `/p` |
| Nested directory in a checkout | `/p/sub/deeper` | `/p` | `/p` |
| Linked worktree | `/wt` | `/wt` | `/p` (main checkout) |
| Nested directory in a worktree | `/wt/sub` | `/wt` | `/p` |
| Non-Git directory | `/n` | `/n` | `/n` |
| Nested non-Git directory | `/n/inner` | `/n/inner` | `/n/inner` |

Mapping onto the existing root roles:

- V1 `directory` → `ctx.location.directory` (the launch directory).
- V1 `worktree` → `ctx.location.project.directory` — the working-copy root, which
  for a linked worktree is **the worktree itself**, not the main checkout. So
  two worktrees of one repository get two Containment Roots and two storage
  identities, exactly as in V1.
- `project.canonical` is **not** a containment boundary: for a worktree it
  points outside the Location's working copy.
- A non-Git Location reports its own directory as `project.directory`, never
  `/`. The existing guard against an empty or `/` worktree stays as a
  defence-in-depth check; it is no longer reachable on 2.0.25.

### Tools

| Question | Verified answer | Evidence |
| --- | --- | --- |
| Registration | `await ctx.tool.transform((editor) => editor.add(...))`. The callback must be synchronous, cheap and replayable; external data is loaded first and captured. | types; docs; probe |
| Effective name | The `name` given, unless `options.namespace` is set, which prefixes it (`acme_greeting`). Keeping no namespace preserves `xcode_test`, `xcode_test_inspect`, `xcode_test_recover` exactly. | docs; probe |
| Input schema | JSON Schema, Effect Schema or Standard Schema. Plain JSON Schema (`type`, `properties`, `required`, `additionalProperties`, `minLength`, `minimum`, `maximum`, `description`) reaches the model unchanged. | types; stub-provider request body |
| Input validation | The host validates a call against the JSON Schema **before** `execute`: a missing required key, a too-short string and a wrong type each come back to the model as `Invalid arguments for tool …` and the executor never runs. Unknown keys under `additionalProperties: false` are **stripped**, not refused. Nested `anyOf` of `const`-tagged objects is accepted (issue #141, real plugin). | probe; real plugin on the isolated host |
| **Code Mode default** | **`codemode` defaults to on.** A tool registered without `options` is **not** offered to the model directly: it is only reachable through `execute` (Code Mode). With `options: { codemode: false }` it is offered as a first-class tool. | stub provider recorded each request's `tools` array |
| Permission action | Defaults to the tool's effective name. `options.permission` overrides it. | probe agent rules |
| Restricted agent | Agent rules `[{ "*","*",deny }, { "xcode_probe_pinned","*",allow }]` → the model was offered **only** `xcode_probe_pinned`; no `shell`, `read`, `edit`, `execute` or anything else. A `codemode` tool under the same agent was unreachable, because `execute` was denied. | stub-provider request body |
| Default `build` agent | Offered `edit`, `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`, the `codemode: false` tool, and `execute`. There is no `list`, `todoread` or `todowrite` tool on V2, and `write` and `patch` use the `edit` action. | stub-provider request body; permissions docs |
| Execute context | `{ sessionID, agent, messageID, id, signal, progress }`. `agent` is the agent ID (`runner`, `build`). | probe |
| Result | `{ content: string \| (TextContent \| FileContent)[], output?, metadata? }`. Content array text is what the model receives. | types; probe |
| Progress | `await context.progress(metadata)`; the latest metadata is kept on the tool part, including when the call is later aborted. | session context |

### Cancellation

| Question | Verified answer |
| --- | --- |
| Signal | `client.session.interrupt` aborts `context.signal` immediately (`AbortError`). |
| What the host records | The tool part goes straight to `status: "error"`, `error: { type: "aborted", message: "Tool execution interrupted" }`, carrying the last `progress` metadata. |
| Does the host wait for the executor? | **No.** The tool part completed before the executor returned its post-abort result, and that result was discarded. |

Consequence: the V1 rule "if terminal publication lands inside the abort wait,
return the real summary" can no longer reach the model. The bounded abort wait
is still what propagates cancellation to the supervisor, and the supervisor
still owns terminal publication. A `runId` published through `progress`
before the abort survives on the aborted part.

### Output limits and truncation

| Question | Verified answer |
| --- | --- |
| Is plugin tool output truncated? | **Yes.** Defaults are 2,000 lines and 51,200 bytes (`tool_output.max_lines` / `max_bytes`), matching the V2 config docs. |
| What truncation looks like | The model receives a notice that names **the absolute path** of the full output under the host's data directory: `[showing lines 1-2000 of 2500; full output saved to /…/tool-output/tool_…]`. A single over-long line leaves the model with *only* the notice. Metadata gains `truncated: true` and `outputPath`. |
| Is `tool_output` honoured for plugin tools? | Yes. `max_lines: 50`, `max_bytes: 1000` truncated a 2,000-byte and an 80-line result. |
| Is it re-read? | **Yes, live.** Editing `tool_output` in a watched config file applied to the next call without a restart. The V1 "read once, configuration is not hot-reloaded" premise is false on V2. |
| Can the plugin read the effective limits? | **No supported route.** The plugin context has no `config` domain (context keys: `app`, `location`, `options`, `agent`, `aisdk`, `command`, `event`, `experimental`, `generate`, `model`, `provider`, `integration`, `mcp`, `permission`, `plugin`, `reference`, `rpc`, `skill`, `storage`, `tool`, `vcs`, `websearch`, `worktree`, `session`, `shell`). The client's `config.get` returns raw per-file documents, not an effective merge, and the plugin has neither the server URL nor credentials to call it. |

So the adapter budgets against the verified V2 defaults, takes an explicit
lower limit from plugin options when the user has lowered `tool_output`, and
re-reads options per plugin instance — which the host already rebuilds on
every config change. It never inherits the V1 numbers by assumption; they
happen to be equal, and that is now a verified fact with a source.

### Host version

`ctx.app.version` — no HTTP read, no bounded fetch, no `unknown` fallback
needed for a loaded plugin.

### Isolated host for acceptance tests

| Question | Verified answer |
| --- | --- |
| Start | `opencode serve --hostname 127.0.0.1 --port 0` with a private `HOME` and `XDG_*_HOME`. Never `--service`, never `Service.ensure()` — those address the user's shared background service. |
| Endpoint discovery | stdout line `server listening on http://127.0.0.1:<port>`; with `--port 0` the kernel picks the port. |
| Authentication | `OPENCODE_SERVER_PASSWORD` sets the password (otherwise one is generated and printed). HTTP Basic, user `opencode`. No credentials → 401, wrong password → 401. |
| Client | `OpenCode.make({ baseUrl, headers: { authorization: "Basic …" } })` from `@opencode/client`. |
| Plugin registration check | `client.plugin.list({ location: { directory } })` → `{ id, source, state: { status } }`. There is no client route that lists tools, so registration and permissions are checked from the model request (below). |
| Session flow | `session.create({ agent, model: { id, providerID }, location: { directory } })` → `session.prompt({ sessionID, text })` → `session.wait({ sessionID })` → `session.context({ sessionID })` returns messages whose `content` holds `{ type: "tool", name, state: { status, input, content, metadata } }`. |
| Cancellation | `session.interrupt({ sessionID })` → `{ interrupted: true }`; the final message is `{ type: "idle", outcome: "interrupted" }`. |
| Scripted model | `providers.<id>` with `package: "@opencode/ai/providers/openai-compatible"` (bundled in the host — nothing downloaded) and `settings.baseURL` pointed at a local stub that streams OpenAI chat-completion chunks. The stub sees each request's `tools` array, which is the authoritative record of what the model was offered. |
| A title request | The first request of a new session is a tool-less title generation; a scripted call must be emitted only on a request that actually carries tools. |
| Shared temp dir | `server.info().paths.tmp` is `/private/tmp/opencode` even for the isolated host. Nothing in the gate may rely on that directory being private. |

## ADR 0002 decisions that need superseding

| ADR 0002 section | Superseded by |
| --- | --- |
| Registration and loading — `export default { id, server }`, the `tool` hook, factory awaited before every host service | `Plugin.define({ id, setup })`, tools through `ctx.tool.transform`, per-Location background `setup` that prompts wait for |
| Registration and loading — absolute `plugin` entry or symlinked **file** | `plugins` entry naming a **directory** that resolves to a `server`/`index` entry, or a file under `plugins/` |
| Tool surface — Zod `ZodRawShape` through `tool.schema`, legacy JSON Schema rejected | Plain JSON Schema with explicit `required`; the "every key required" fallback no longer exists |
| Tool surface — named exports give separately-deniable keys | Permission action = effective tool name; **`codemode: false` is required** for a restricted agent to see the tools at all |
| Containment root — `context.worktree`, else `context.directory` | `location.project.directory`, else `location.directory` |
| Rendering and the output budget — host limits read once via `client.config.get()` | V2 verified defaults, plus plugin-option override; limits are live on the host |
| Throw semantics — `output-error` part detail | V2 `Tool.Error`; still never throw a domain outcome, and never throw from `setup` (stack traces with paths reach `plugin.list`) |
| Running metadata — `context.metadata` | `context.progress` |
| Cancellation — the real summary is returned if publication lands in the wait | The host discards a post-abort result; the wait still bounds supervisor propagation |
| Restricted agent — `permission:` map, `bash`, `agent/` directory | Ordered `permissions:` rule list, `shell`/`edit`, `agents/` directory |
| Plugin-startup budget — bootstrap deadlock, host-version HTTP read | No config read from the host; version from `ctx.app.version` |
| Dependency posture — host-managed `@opencode-ai/plugin` symlinked into the checkout | Exact-pinned `@opencode/plugin` and `@opencode/client` |
| Host-version policy — 1.18.29/1.18.30 | 2.0.25 |

## Unresolved

- **Effective `tool_output` from inside a plugin.** No supported route on
  2.0.25. The adapter's guarantee that host truncation is unreachable now
  holds only when the user's `tool_output` is at or above the V2 defaults, or
  when a lower limit is also given to the plugin as an option. That is a
  regression from V1 and is accepted, documented and diagnosed rather than
  hidden.
- **Remote workspaces.** `location.workspaceID` exists for remote workspaces.
  Nothing here was verified against one, and the Test Tool claims only local
  Locations.
- **Docs drift.** The plugin guide shows absolute `.ts` file paths in
  `plugins`; 2.0.25 rejects them. The host behavior is what this project
  documents.
