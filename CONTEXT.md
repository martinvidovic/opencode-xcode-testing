# Xcode Test Tool

A local OpenCode capability for running scoped Xcode tests while exposing only trustworthy, compact results to the model.

## Language

**Test Tool**:
The OpenCode-facing capability that executes and inspects Xcode tests. Exposed as a family of three separately-deniable tool IDs — `xcode_test`, `xcode_test_inspect`, `xcode_test_recover` — which together form one capability.
_Avoid_: Test plugin, test wrapper

**Test Run**:
One execution of a Requested Scope, including its retained diagnostics and reported outcome.
_Avoid_: Build, invocation

**Requested Scope**:
The test selection that a caller intends a Test Run to execute.
_Avoid_: Filter, test target

**Result Bundle**:
The durable `.xcresult` artifact produced for a Test Run and retained for later inspection.
_Avoid_: Test output, report

**Result Summary**:
The compact, classified account of a Test Run exposed to the model, including enough evidence to reject false success.
_Avoid_: Log, formatter output

**Facet**:
One named, separately-readable view of a retained Test Run — `scope`, `failures`, `buildErrors`, `tests`, `log`. Each reports its own availability, so "there were none" and "none could be read" stay distinguishable per view.
_Avoid_: Section, category, channel

**Focused Detail**:
The expanded view of a single diagnostic or a single test, reached by identifier rather than by paging. A different shape from a page, not a larger one: it carries the full message, identity, safe location, stack frames, activities and attachment metadata.
_Avoid_: Detail page, expanded record, drill-down, focused view, focused read

**Log Chunk**:
One bounded, UTF-8-aligned window of a Test Run's retained raw log, with byte-range metadata and a continuation cursor. Its content is untrusted output from the project's own build and tests, and is never classified on.
_Avoid_: Log page, output slice

**Bundle-Backed Detail**:
Focused detail that can only be obtained by reopening the Result Bundle, as opposed to detail served from the immutable index. It degrades on its own — a mismatched digest or toolchain takes it away without affecting ordinary paging.
_Avoid_: Lazy data, deep read

**Execution Slot**:
The single permission to run `xcodebuild` under one trusted root. V1 serializes Test Runs per root, so holding the slot is what makes a run the active one; releasing it is what lets the next be admitted.
_Avoid_: Lock, mutex, semaphore

**Quarantine**:
A hold on a trusted root's Execution Slot, raised when a Test Run's lifecycle could not be confirmed and cleared only on identity-safe evidence that nothing attributable to it is still running. It refuses new Test Runs with a reason rather than making them wait.
_Avoid_: Lockout, freeze, block

**Run Record**:
The durable per-run metadata the runner writes as a Test Run progresses — its monotonic state, the process identities it recorded, and what it was asked to do. It is what recovery reads after a crash, and the only account of a run whose processes are gone.
_Avoid_: Run state file, metadata blob

**Shared Build Cache**:
The `DerivedData` tree the tool keeps for one Xcode container so the next build does not start cold. Regenerable by definition, keyed by an opaque hash like every other tool-managed directory, and counted against the byte targets it used to sit quietly beside. Reclaimed only after eviction has done what it can, because a warm start is worth less than evidence nobody can rebuild.
_Avoid_: Build artifacts, intermediates, scratch

**Stale Root**:
A trusted root nobody has opened for long enough that its storage is collected whole. The registry keeps a hash and a `lastSeenAtMs` and deliberately never a path, so age is the only signal there is — which is both the privacy guarantee and the entire basis on which this can be decided.
_Avoid_: Dead project, orphaned repo, abandoned root
