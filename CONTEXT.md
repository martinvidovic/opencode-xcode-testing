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
_Avoid_: Detail page, expanded record, drill-down

**Log Chunk**:
One bounded, UTF-8-aligned window of a Test Run's retained raw log, with byte-range metadata and a continuation cursor. Its content is untrusted output from the project's own build and tests, and is never classified on.
_Avoid_: Log page, output slice

**Bundle-Backed Detail**:
Focused detail that can only be obtained by reopening the Result Bundle, as opposed to detail served from the immutable index. It degrades on its own — a mismatched digest or toolchain takes it away without affecting ordinary paging.
_Avoid_: Lazy data, deep read
