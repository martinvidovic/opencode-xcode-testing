/**
 * Private anomaly records (#8).
 *
 * Lossless normalization is recorded rather than announced: an anomaly changes
 * public completeness only when it actually loses information or affects
 * classification. There is deliberately no public warning collection — a model
 * that cannot act on a warning is only distracted by one.
 */

import { DECODER_VERSION, REQUESTED_SCHEMA_VERSION } from "./schema.ts"

/** Which structured `xcresulttool` command produced the payload. */
export type XcresultCommand =
  | "metadata get"
  | "get content-availability"
  | "get build-results"
  | "get test-results tests"
  | "get test-results summary"

export type Anomaly = {
  command: XcresultCommand
  schemaVersion: string
  decoderVersion: number
  /** Dotted path into the payload, e.g. `testFailures`. */
  fieldPath: string
  observedShape: string
  /** What the decoder did about it. `none` means it was recorded only. */
  normalizationApplied: string
  /** Set when the anomaly lost information or moved a facet's completeness. */
  lossy: boolean
}

/** Accumulates anomalies across one interpretation. Never model-facing. */
export class AnomalyLog {
  readonly #records: Anomaly[] = []

  record(input: {
    command: XcresultCommand
    fieldPath: string
    observedShape: string
    normalizationApplied: string
    lossy?: boolean
  }): void {
    this.#records.push({
      command: input.command,
      schemaVersion: REQUESTED_SCHEMA_VERSION,
      decoderVersion: DECODER_VERSION,
      fieldPath: input.fieldPath,
      observedShape: input.observedShape,
      normalizationApplied: input.normalizationApplied,
      lossy: input.lossy ?? false,
    })
  }

  get records(): readonly Anomaly[] {
    return this.#records
  }

  /** True when any recorded anomaly cost information rather than merely noting one. */
  get hasLossyRecords(): boolean {
    return this.#records.some((record) => record.lossy)
  }
}
