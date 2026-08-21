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
  id: string;
  statement: string;
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];
  status: HypothesisStatus;
  /** 0-1, recomputed on every evidence addition. See hypotheses.ts. */
  confidence: number;
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
