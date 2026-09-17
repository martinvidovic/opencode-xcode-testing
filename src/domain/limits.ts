/**
 * Bounds fixed by the Result Summary and progressive inspection contract (#7).
 *
 * Every cap the model-facing contract promises lives here, so a change to one is
 * a change to one line rather than a search across the interpreter and adapter.
 *
 * And, at the end, the budgets two layers have to agree about. Those are not
 * model-facing caps; they are here because the module direction leaves nowhere
 * else both an interpreter and the runner can read them from (issue #124).
 */

/** Serialized UTF-8 bytes of domain data in any typed model-facing response. */
export const RESPONSE_BYTE_CAP = 65_536

/** Validation errors returned by a rejected request. */
export const REQUEST_ERROR_CAP = 50

/** Ambiguity candidates reported per validation error. */
export const AMBIGUITY_CANDIDATE_CAP = 20

/** Characters retained for a compact diagnostic or validation message. */
export const MESSAGE_CHAR_CAP = 1_000

/** Per-selection scope attestations carried in a compact summary. */
export const SCOPE_ATTESTATION_CAP = 20

/** Test-failure diagnostics carried in a compact summary. */
export const SUMMARY_TEST_FAILURE_CAP = 20

/** Build-error diagnostics carried in a compact summary. */
export const SUMMARY_BUILD_ERROR_CAP = 20

/** Sampled observed test identifiers carried in a compact summary. */
export const SUMMARY_OBSERVED_TEST_CAP = 20

/** Records returned by a structured inspection facet when no page size is given. */
export const INSPECTION_PAGE_DEFAULT = 20

/** Records an inspection facet page may be asked for. */
export const INSPECTION_PAGE_MAX = 100

/** Characters of a full message, available only to a focused diagnostic request. */
export const FOCUSED_MESSAGE_CHAR_CAP = 16_000

/** Stack frames carried by a focused diagnostic. */
export const FOCUSED_STACK_FRAME_CAP = 100

/** Activity nodes carried by a focused diagnostic. */
export const FOCUSED_ACTIVITY_NODE_CAP = 100

/** Depth of the activity hierarchy carried by a focused diagnostic. */
export const FOCUSED_ACTIVITY_DEPTH_CAP = 10

/** Characters per activity title or message. */
export const ACTIVITY_TEXT_CHAR_CAP = 2_000

/** Attachment metadata entries carried by a focused diagnostic. */
export const ATTACHMENT_METADATA_CAP = 100

/** Characters of an attachment name or media type. */
export const ATTACHMENT_TEXT_CHAR_CAP = 500

/** Characters of a stack-frame symbol or module. Display text, so it is cut. */
export const STACK_FRAME_TEXT_CHAR_CAP = 1_000

/**
 * Characters of a message retained with its line structure (issue #75).
 *
 * Derived from what can ever be read out of it rather than chosen: at most
 * `FOCUSED_STACK_FRAME_CAP` frames survive a focused response, and each
 * frame's text is cut at `STACK_FRAME_TEXT_CHAR_CAP`. Text past that cannot
 * reach a caller under any response, so keeping it only makes the index
 * slower to read on every inspection — and this index is read whole.
 *
 * Cutting mid-line is safe by construction: a frame pattern is anchored to a
 * whole line, so a half-line at the end matches nothing and is not a frame.
 */
export const DETAIL_MESSAGE_CHAR_CAP = FOCUSED_STACK_FRAME_CAP * STACK_FRAME_TEXT_CHAR_CAP

/**
 * The longest stack-frame path that will be shown.
 *
 * A separate name because it is a separate rule. The cap above is a length
 * things are cut *to*; this is a length past which a location is dropped
 * whole, because a path cut to a length is a different file name.
 */
export const STACK_FRAME_PATH_LIMIT = 1_000

/** Source-log bytes returned by a log chunk when no size is requested. */
export const LOG_CHUNK_DEFAULT_BYTES = 16_384

/** Source-log bytes a single log chunk may be asked for. */
export const LOG_CHUNK_MAX_BYTES = 65_536

/**
 * Source-log bytes a chunk is never smaller than: one whole character.
 *
 * Below this a window could land entirely inside a multi-byte sequence, and
 * the chunk would have to choose between returning nothing — which never
 * advances the cursor — and emitting half a character, which corrupts the text
 * for a caller reading page after page. Four is the longest sequence UTF-8
 * defines, so at this size neither can happen.
 */
export const LOG_CHUNK_MIN_BYTES = 4

/**
 * Room reserved inside `RESPONSE_BYTE_CAP` for everything a response carries
 * besides its records: the status, the facet tag, the truncation state, and a
 * cursor. Generous on purpose — the cap is a ceiling to stay under, not a
 * budget to spend exactly.
 */
export const RESPONSE_ENVELOPE_BYTES = 1_024

/**
 * The most structured output a single `xcresulttool` read may stage.
 *
 * The tool is given a Result Bundle this repository did not write, for a test
 * suite whose size nothing here controls, so the read needs a bound. Staging
 * the output in a private file rather than accumulating it is what lets the
 * bound be this high: the old ceiling had to cover the payload held as chunks,
 * again as one buffer, again as a string and again as objects, so it rejected
 * suites that were merely large — as `unsupported`, which reads as "this
 * schema is wrong" when the truth is "this suite is big".
 *
 * It is deliberately **not** disk-sized, though, because disk is not the
 * binding constraint. Decoding turns the staged bytes into one JavaScript
 * string, and a runtime will not build a string of any size; a cap above that
 * limit would admit payloads that stage perfectly and then fail at the last
 * step, which is a worse answer arrived at more slowly. This is the largest
 * output that can actually be decoded, with room to spare.
 */
export const MAX_STAGED_PAYLOAD_BYTES = 512 * 1024 * 1024

/**
 * The largest tool-managed file read whole into memory.
 *
 * Indexes, run records, the queue and the registry are written by this tool,
 * so their size is its own doing — but they are read back from a filesystem it
 * does not exclusively control, and "we wrote it" is not a guarantee about
 * what is there now. Reading without a bound makes every one of them a way to
 * exhaust the process.
 */
export const MAX_PRIVATE_FILE_BYTES = 64 * 1024 * 1024

/** Seconds a Test Run runs for when neither request nor configuration says otherwise. */
export const DEFAULT_TIMEOUT_SECONDS = 900

/** Inclusive bounds on a requested Test Run timeout. */
export const MIN_TIMEOUT_SECONDS = 1
export const MAX_TIMEOUT_SECONDS = 7_200

/** Fixed deadline for container and scheme discovery. */
export const DISCOVERY_TIMEOUT_SECONDS = 60

/**
 * How deep a structured payload may nest before a decode refuses it (#97).
 *
 * The test hierarchy is a tree — Test Plan, bundle, suite, case, and nested
 * suites within those — and both the decoder and everything that walks its
 * output are recursive. Real Xcode output is single digits deep. A payload
 * that is thousands deep is not a hierarchy anyone wrote; it exhausts the
 * stack, and a `RangeError` out of a decoder is a raw host error where a typed
 * answer about the evidence belonged.
 *
 * Generous by two orders of magnitude against anything observed, because this
 * is a stack bound and not a schema opinion: a real suite that nests more
 * deeply than expected should be read, not rejected.
 */
export const MAX_PAYLOAD_DEPTH = 256

/**
 * Per-operation budget for lazy, bundle-backed detail (#8).
 *
 * One fixed monotonic deadline covering toolchain verification, digest
 * verification and extraction together rather than each separately, because
 * the caller is waiting on the whole operation and dividing the budget would
 * let three steps that each finished "in time" take three times as long.
 *
 * Here rather than beside the interpreter's other budgets because a second
 * module has to agree with it: a Read Lease is only worth holding if it
 * outlives the read it covers, and the runner may not import the interpreter.
 * There were two copies of this number, and the exported one was dead — the
 * one an editor would find and change was not the one production read
 * (issue #124).
 */
export const LAZY_DEADLINE_MS = 60_000

/**
 * What a Read Lease is given beyond the operation it protects (issue #124).
 *
 * A lease covers the whole inspection, and the lazy read is only the middle
 * of it: the index is read and parsed before, and a page or a log window is
 * assembled after. A lifetime equal to the deadline would leave both ends
 * uncovered — and a lease that expires mid-read does not fail loudly, it
 * stops being seen by the housekeeping pass that then deletes what is being
 * read.
 *
 * Those ends carry no deadline of their own; they are bounded by size
 * instead, and this number is sized against those bounds rather than against
 * a guess. The index read is capped at `MAX_PRIVATE_FILE_BYTES`, a log window
 * at `LOG_CHUNK_MAX_BYTES`, and a response at `RESPONSE_BYTE_CAP` — 64 MiB,
 * 64 KiB and 64 KiB of local file reading and serialization. Thirty seconds
 * is orders of magnitude above what that costs on a machine that can also run
 * Xcode, and small enough that an abandoned lease is gone inside two minutes.
 *
 * It is a margin, not a guarantee: nothing stops a pathological machine from
 * exceeding it, and the consequence there is the pre-existing one — a reader
 * meets storage that has been reclaimed underneath it.
 */
export const LEASE_MARGIN_MS = 30_000

/**
 * How long a published Read Lease is believed.
 *
 * Derived, so the two cannot drift: the whole point is that it is longer than
 * the operation it protects, and a number chosen independently is a number
 * that stops being longer the day somebody raises the deadline.
 */
export const LEASE_LIFETIME_MS = LAZY_DEADLINE_MS + LEASE_MARGIN_MS
