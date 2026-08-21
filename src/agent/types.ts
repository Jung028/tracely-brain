// Domain types for Module 03. `Hypothesis`/`Evidence` implement FR-19's
// "explicit, named hypotheses ... not unstructured narrative" requirement —
// every field here is inspectable state, not prose the caller has to parse.

export type HypothesisStatus = "INVESTIGATING" | "CONFIRMED" | "REFUTED";

export interface Evidence {
  id: string;
  /** Which tool produced this evidence — e.g. "queryBrain", "searchCode". */
  toolSource: string;
  description: string;
  timestamp: Date;
  /** Reference to the underlying tool result, for inspection/debugging. */
  raw: unknown;
}

export interface Hypothesis {
  readonly id: string;
  readonly statement: string;
  readonly supportingEvidence: readonly Evidence[];
  readonly contradictingEvidence: readonly Evidence[];
  readonly status: HypothesisStatus;
  /** Reflects accumulated supporting evidence only (via addSupportingEvidence).
   * Contradicting evidence affects status but not confidence. Range: 0-1. */
  readonly confidence: number;
}

export type InvestigationResult =
  | {
      outcome: "CONFIRMED";
      hypothesis: Hypothesis;
      rca: string;
      evidenceTrail: Evidence[];
    }
  | {
      outcome: "INSUFFICIENT_EVIDENCE";
      hypothesesConsidered: Hypothesis[];
      reason: string;
    };
