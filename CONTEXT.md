# Xcode Test Tool

A local OpenCode capability for running scoped Xcode tests while exposing only trustworthy, compact results to the model.

## Language

**Test Tool**:
The OpenCode-facing capability that executes and inspects Xcode tests.
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
