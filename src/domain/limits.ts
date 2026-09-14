/**
 * Bounds fixed by the Result Summary and progressive inspection contract (#7).
 *
 * Every cap the model-facing contract promises lives here, so a change to one is
 * a change to one line rather than a search across the interpreter and adapter.
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

/** Characters of a stack-frame symbol, module, or displayed path. */
export const STACK_FRAME_TEXT_CHAR_CAP = 1_000

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

/** Seconds a Test Run runs for when neither request nor configuration says otherwise. */
export const DEFAULT_TIMEOUT_SECONDS = 900

/** Inclusive bounds on a requested Test Run timeout. */
export const MIN_TIMEOUT_SECONDS = 1
export const MAX_TIMEOUT_SECONDS = 7_200

/** Fixed deadline for container and scheme discovery. */
export const DISCOVERY_TIMEOUT_SECONDS = 60
