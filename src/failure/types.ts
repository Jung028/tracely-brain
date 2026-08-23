// FR-25/FR-26's output shape — the "never fabricate a root cause" gate's
// formatted result. Consumed by whatever calls investigate() when its
// outcome is "INSUFFICIENT_EVIDENCE"; module 08 (state-machine) owns
// actually acting on `status` — this module only produces it correctly.
export interface FailureReport {
  readonly status: "MANUAL_REVIEW_REQUIRED";
  readonly rootCause: "NOT CONFIRMED";
  /** Friendly labels for every distinct evidence source actually called, e.g. "Company Brain". */
  readonly investigated: readonly string[];
  readonly missing: string;
  readonly recommendedNextStep: string;
}
