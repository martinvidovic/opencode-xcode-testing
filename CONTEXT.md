# Xcode Test Tool

A local OpenCode capability for running scoped Xcode tests while exposing only trustworthy, compact results to the model.

## Language

**Test Tool**:
The OpenCode-facing capability that executes and inspects Xcode tests. Exposed as a family of three separately-deniable tool IDs — `xcode_test`, `xcode_test_inspect`, `xcode_test_recover` — which together form one capability.
_Avoid_: Test plugin, test wrapper

**Containment Root**:
The canonical directory supplied by the adapter that bounds repository scanning, container resolution, execution working directories, and diagnostic path disclosure. Tool arguments can never move it.
_Avoid_: Trusted root

**Configuration Root**:
The canonical directory whose `.opencode/xcode-test.json` enables and configures the Test Tool, and against which configuration-relative values resolve. It is tracked independently from the Containment Root even when both identify the same directory.
_Avoid_: Config root

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
One named, separately-readable view of a retained Test Run — `scope`, `failures`, `buildErrors`, `tests`, `log`. Each reports its own availability, so "there were none" and "none could be read" stay distinguishable per view. Within a view the same distinction runs to three: see **Stack Frame Evidence**.
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

**Control Channel**:
The private pair of inherited pipe endpoints between the adapter and a supervisor process. Possession of an endpoint is what authenticates the two to each other — nothing else on the machine holds one — which is why the invocation travels through it rather than through a command line or the environment. Losing it means the adapter is gone, which the supervisor records and survives.
_Avoid_: Control socket, IPC link

**Execution Slot**:
The single permission to run `xcodebuild` under one Containment Root. V1 serializes Test Runs per root, so holding the slot is what makes a run the active one; releasing it is what lets the next be admitted.
_Avoid_: Lock, mutex, semaphore

**Exit Evidence**:
What a supervisor actually observed about how a Test Run's direct child ended — its exit code, its signal, or neither. It is separate from whether the process group drained: the group is read from the process table, and the child's end is reported by the runtime that owned it, so the two can disagree. Absent evidence is `unknown`, never a failed exit.
_Avoid_: Exit info, exit result

**Quarantine**:
A hold on a Containment Root's Execution Slot, raised when a Test Run's lifecycle could not be confirmed and cleared only on identity-safe evidence that nothing attributable to it is still running. It refuses new Test Runs with a reason rather than making them wait.
_Avoid_: Lockout, freeze, block

**Read Lease**:
A short, expiring file published under a Containment Root's current storage scope while an inspection reads one Test Run's retained evidence, and removed when it finishes. It is what stops user-wide retention — which runs in whichever OpenCode instance reaches the hour first — from evicting evidence another instance is reading. It expires rather than being probed, so a crashed reader costs one pass and never pins evidence; anything unreadable among them counts as held.
_Avoid_: Read lock, pin, reservation

**Run Record**:
The durable per-run metadata the runner writes as a Test Run progresses — its monotonic state, the process identities it recorded, and what it was asked to do. It is what recovery reads after a crash, and the only account of a run whose processes are gone.
_Avoid_: Run state file, metadata blob

**Shared Build Cache**:
The `DerivedData` tree the tool keeps for one Xcode container so the next build does not start cold. Regenerable by definition, keyed by an opaque hash like every other tool-managed directory, and counted against the byte targets it used to sit quietly beside. Reclaimed only after eviction has done what it can, because a warm start is worth less than evidence nobody can rebuild.
_Avoid_: Build artifacts, intermediates, scratch

**Stale Root**:
A stored Containment Root nobody has opened for long enough that its storage is collected whole. The registry keeps a hash and a `lastSeenAtMs` and deliberately never a path, so age is the only signal there is — which is both the privacy guarantee and the entire basis on which this can be decided.
_Avoid_: Dead project, orphaned repo, abandoned root

**Adapter Failure**:
The infrastructure reason for a Test Run the Test Tool itself could not finish handling — a decoder meeting a shape it did not expect, a renderer meeting a payload it could not render. Deliberately not `runnerFailure`: that names the machinery which runs `xcodebuild`, and a caller told it goes to inspect a toolchain that is working. A contained failure keeps the run id, so the evidence stays reachable.
_Avoid_: Internal error, unexpected error, crash

**Stack Frame Evidence**:
What a failure's text says about its own backtrace, which is three answers rather than two: **absent** — nothing in it was frame-shaped, so an empty stack is complete; **extracted** — every frame-shaped line was read; **partial** — frame-shaped lines were there and at least one could not be read. Only the third is a loss. Reading it as two described the commonest failure there is — a plain assertion with no trace — as evidence somebody had withheld.
_Avoid_: No frames, missing stack, unavailable trace
