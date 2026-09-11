# OpenCode v1 tool execution constraints

Accessed 2026-09-11. This report covers the then-current stable OpenCode v1 release only: `v1.18.30`, published 2026-09-09, tag commit [`3104c1428ec91f809e5ab86631300de41eb6952e`](https://github.com/anomalyco/opencode/commit/3104c1428ec91f809e5ab86631300de41eb6952e). GitHub marked [`v1.18.30`](https://github.com/anomalyco/opencode/releases/tag/v1.18.30) latest, and npm's `latest` tags resolved both [`opencode-ai`](https://registry.npmjs.org/opencode-ai/1.18.30) and [`@opencode-ai/plugin`](https://registry.npmjs.org/@opencode-ai%2Fplugin/1.18.30) to `1.18.30`. Source citations below are pinned to that commit.

## Decision summary

| Concern | Stable v1 fact | Constraint for a runner/adapter |
| --- | --- | --- |
| Registration | Project `.opencode/tools/*.{ts,js}` modules are discovered and imported. A default export uses the filename; named exports use `<filename>_<export>`. | A project-local TypeScript wrapper is supported. Keep each entry point directly under `.opencode/tools/` and use a unique filename/tool ID. |
| Cancellation | The v1 custom-tool context **does contain `abort: AbortSignal`**, and the host supplies the AI SDK tool-call signal. | Pass `context.abort` to the subprocess API or install an abort listener that signals the directly spawned `xcodebuild`. Cancellation is cooperative; OpenCode does not automatically terminate a process created by custom code. |
| Process trees | v1 gives the tool a signal, not a public process-tree supervisor. | The runner must own escalation and descendant cleanup. Do not equate cancelling the direct `xcodebuild` process with a guaranteed whole-tree kill. |
| Permissions | Agent permission keys match tool IDs, including custom tools. A terminal `deny` rule removes a tool from the model-visible tool set. | Use an agent-level default deny followed by an exact tool-ID allow. Do not assume an `ask` rule automatically prompts around a custom tool; call `context.ask` in the tool when approval is required. |
| Results/progress | Execution returns text or `{ output, title?, metadata?, attachments? }`; `context.metadata` can update running state. | Put model-consumable content in `output` (and supported attachments), not `title` or `metadata`. Treat metadata as UI/session state, not a model channel. |
| Cleanup | Standalone custom-tool definitions have no dispose hook. v1 plugins do have `dispose`, invoked by an instance finalizer. | Clean per-call resources in `try/finally`. If instance-lifetime cleanup is required, register the tool through a v1 plugin and implement its `dispose`; otherwise use an external supervised runner. |

## Findings

### Registration and local source loading

The stable documentation supports JavaScript or TypeScript definitions in project `.opencode/tools/` or global `~/.config/opencode/tools/`, documents default- and named-export naming, and says a custom ID can replace a built-in ID ([custom-tools docs, lines 10-103](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/web/src/content/docs/custom-tools.mdx#L10-L103)).

The implementation scans every resolved config directory for immediate children matching `{tool,tools}/*.{js,ts}`, dynamically imports each file, accepts exports shaped like a tool definition, and derives IDs as documented ([registry, lines 123-203](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/registry.ts#L123-L203)). Config directories include the global config directory and project `.opencode` directories found from the session directory up to the worktree root ([config paths, lines 23-40](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/config/paths.ts#L23-L40)). OpenCode also installs `@opencode-ai/plugin` into those directories before importing matching tools ([config, lines 430-479](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/config/config.ts#L430-L479)).

Consequences:

- `.opencode/tools/` is the documented, dependable project location. The singular `.opencode/tool/` works in source but is undocumented, so downstream code should not depend on it.
- Discovery is one directory deep; nested tool entry points are not matched.
- TypeScript is loaded as local source by the Bun-hosted CLI. Stable source pins Bun `1.3.14` ([root package metadata, line 7](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/package.json#L7)), and the published plugin package exposes its compiled v1 root and `./tool` entry points ([published metadata](https://registry.npmjs.org/@opencode-ai%2Fplugin/1.18.30)).
- Custom definitions are appended after built-ins and assigned into the tool record by ID, which implements the documented custom-tool precedence ([registry, lines 229-258](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/registry.ts#L229-L258), [session tools, lines 92-133](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/tools.ts#L92-L133)). Accidental collisions are therefore dangerous.

### AbortSignal and `xcodebuild` cancellation

This is a current v1 fact, not a v2 inference. The public v1 `ToolContext` declares `abort: AbortSignal`, alongside `metadata` and `ask` ([plugin tool type, lines 3-20](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/plugin/src/tool.ts#L3-L20)). The execution bridge assigns `ToolExecutionOptions.abortSignal` to `context.abort` before invoking a registered tool ([session tools, lines 59-90](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/tools.ts#L59-L90)). The LLM stream owns an `AbortController` and aborts it when the stream scope is released ([LLM runtime, lines 357-381](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/llm.ts#L357-L381)). The stable custom-tools documentation lists only the identity/path context fields, so that page is incomplete on this point ([custom-tools docs, lines 137-156](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/web/src/content/docs/custom-tools.mdx#L137-L156)).

The signal does not cancel arbitrary work by itself. The host calls a custom tool through a normal promise and does not know which subprocesses it created ([registry, lines 143-179](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/registry.ts#L143-L179)). OpenCode's own shell tool explicitly waits for `ctx.abort` and then invokes an internal process-handle kill with three-second forced escalation ([shell tool, lines 533-555](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/shell.ts#L533-L555)); that internal process-tree handle is not part of the custom-tool API.

For a direct spawn, the minimum safe v1 pattern is:

```ts
const proc = Bun.spawn({
  cmd: ["xcodebuild", ...args],
  cwd: context.directory,
  signal: context.abort,
  killSignal: "SIGTERM",
  stdout: "pipe",
  stderr: "pipe",
})

try {
  return await collectResult(proc)
} finally {
  // Also close streams/files and remove any manually installed listeners here.
}
```

This makes the directly spawned `xcodebuild` receive termination when the OpenCode call is aborted. If the adapter uses Node child processes instead, install a `{ once: true }` listener on `context.abort`, call `child.kill("SIGTERM")`, remove the listener in `finally`, and add bounded `SIGKILL` escalation. In either case, descendant-process cleanup is not guaranteed by the OpenCode v1 contract; a robust runner should supervise a process group/tree outside this thin adapter when orphan prevention matters.

### Permission identity and per-agent allowlisting

Stable docs state that permission keys are wildcard-matched against underlying tool names, including custom tools, and that permissions can be overridden per agent ([agents docs, lines 423-480](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/web/src/content/docs/agents.mdx#L423-L480)). Source filters model-visible tools using the merged agent/session ruleset; a last matching whole-tool `deny` removes the tool ([request preparation, lines 208-214](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/llm/request.ts#L208-L214), [permission evaluation, lines 28-37](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/permission/index.ts#L28-L37), [disabled-tool filtering, lines 204-219](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/permission/index.ts#L204-L219)). Therefore this is a valid allowlist shape:

```json
{
  "agent": {
    "build-runner": {
      "permission": {
        "*": "deny",
        "xcode_build": "allow"
      }
    }
  }
}
```

The identity must be the resolved tool ID. For example, default export `xcode-build.ts` is `xcode-build`; named export `build` in `xcode.ts` is `xcode_build`.

There is a gap around `ask`: the generic custom-tool call path does not invoke permission approval before `item.execute`; built-in tools call `context.ask` themselves ([session tools, lines 99-129](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/tools.ts#L99-L129)). A custom tool requiring runtime approval must call the supplied `context.ask({ permission, patterns, always, metadata })`. `deny` remains reliable as a visibility/execution gate; `ask` alone is not a generic custom-tool approval wrapper.

### Model-visible results, progress, and metadata

The v1 type accepts either a string or `{ output: string, title?, metadata?, attachments? }` ([plugin tool type, lines 29-48](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/plugin/src/tool.ts#L29-L48)). The host normalizes strings, retains object metadata/attachments, and may truncate output while adding `truncated` and `outputPath` metadata ([registry, lines 154-169](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/tool/registry.ts#L154-L169)).

`context.metadata({ title, metadata })` updates the running tool-call state, so it can carry UI progress such as a phase, elapsed time, or latest log excerpt ([session tools, lines 67-80](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/tools.ts#L67-L80)). It is state replacement, not a documented streaming event schema or append-only progress channel.

On subsequent model turns, OpenCode converts completed calls using `state.output` plus eligible attachments; title and metadata are not included in the model tool result ([message conversion, lines 290-319](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/session/message-v2.ts#L290-L319)). Therefore all facts the model must consume belong in textual `output`. Metadata is useful for the UI, persisted diagnostics, truncation pointers, and plugin hooks, but is not itself model-visible.

### Cleanup and disposal

`ToolDefinition` has only `description`, `args`, and `execute`; standalone files have no initialization/disposal protocol ([plugin tool type, lines 36-54](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/plugin/src/tool.ts#L36-L54)). Module-level resources in `.opencode/tools/` therefore have no custom-tool lifecycle callback. Each execution must clean up child processes, abort listeners, streams, temporary files, and open handles in `finally`, including failure paths.

The v1 plugin API is different: a plugin `Hooks` object may expose both `tool` registrations and `dispose()` ([plugin hooks, lines 222-228](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/plugin/src/index.ts#L222-L228)), and the host registers an instance finalizer that awaits every plugin dispose hook while logging and ignoring disposal failures ([plugin runtime, lines 255-278](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/plugin/index.ts#L255-L278)). This is the only stable v1 instance-lifetime cleanup hook found for custom registrations. It is best-effort application lifecycle cleanup, not a substitute for cancellation-time process cleanup.

## Installed corroboration

The locally installed CLI was `1.18.29`, one patch behind stable, so these checks corroborate but do not define `1.18.30`:

- A temporary project-local `.opencode/tools/context-probe.ts` loaded without package scaffolding and executed through `opencode debug agent ... --tool ...`.
- Runtime context keys included `abort`, `agent`, `ask`, `callID`, `directory`, `messageID`, `messages`, `metadata`, `sessionID`, and `worktree`; `abort instanceof AbortSignal` was true.
- The embedded runtime reported Bun `1.3.14`. A subprocess spawned inside that runtime with an `AbortSignal` and `killSignal: "SIGTERM"` observed `SIGTERM` when the controller was aborted.
- An agent configured with `"*": "deny"` and only the exact custom ID allowed could execute that custom tool, while direct execution of `read` was rejected as disabled.

No private repository, organization, project, session, or filesystem identifiers were retained in these observations.

## v2 boundary and unresolved facts

The `1.18.30` plugin package also publishes explicit `./v2/*` subpaths, while the v1 APIs remain at the package root and `./tool` ([package metadata](https://registry.npmjs.org/@opencode-ai%2Fplugin/1.18.30)). v2 registration/disposal types must not be used to infer v1 custom-tool behavior; every API claim above is from the v1 root types and v1 execution path.

Unresolved or deliberately not guaranteed:

- No stable v1 contract promises that a signal reaches every descendant of a spawned build. Process-group/tree ownership and forced escalation remain runner responsibilities.
- No end-to-end interactive cancellation test was run against `1.18.30`; the exact stable source wiring was inspected, and the one-patch-older installed runtime verified context shape and subprocess signal behavior separately.
- The docs do not state compatibility guarantees for undocumented context fields or the singular `tool/` directory. Pin the plugin version with the CLI and re-verify on upgrades.
- There is no structured, model-visible progress stream in the v1 custom-tool result contract. Only final output/attachments are model input; running metadata is host state.
