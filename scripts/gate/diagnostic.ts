/**
 * Describing a failure without describing the machine (ADR 0001).
 *
 * Scenario details land in a durable report and are pasted into issues. A
 * thrown error's message routinely carries a temp directory, a home
 * directory, or a full path to someone's checkout — none of which a reader
 * elsewhere can act on, and all of which say where this machine keeps things.
 *
 * The same rule the adapter applies to anything a model may see, and the same
 * function: two audiences, one need, and two copies of a redaction is two
 * places for the bug that turns it into a leak.
 */

export { safeFailure as safeDiagnostic } from "../../src/adapter/sanitize.ts"
