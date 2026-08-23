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

// Module 04 (Evidence Timeline) retrofit: records *every* evidence-tool call
// the model makes — not just the ones later cited by update_hypothesis — so
// a timeline can render the full investigation, including dead ends. See
// docs/HOW-IT-WORKS.md "Known gaps" and docs/DATA-MODEL.md "Reading the two
// halves together" for the gap this closes.
export interface ToolCallRecord {
  readonly id: string; // "stepId" — citable by update_hypothesis
  readonly toolName: string;
  readonly input: unknown; // what was queried
  readonly why: string; // model-supplied reason
  readonly result: unknown; // real tool result
  readonly timestamp: Date;
  readonly concurrencyGroup: string; // shared per toolRunner iteration — parallel vs sequential
  readonly hypothesisId: string | null;
  readonly supports: "supporting" | "contradicting" | null;
  readonly meaning: string | null; // set when update_hypothesis cites this step
}

export type InvestigationResult =
  | {
      outcome: "CONFIRMED";
      hypothesis: Hypothesis;
      rca: string;
      evidenceTrail: Evidence[];
      toolCalls: readonly ToolCallRecord[];
    }
  | {
      outcome: "INSUFFICIENT_EVIDENCE";
      hypothesesConsidered: Hypothesis[];
      reason: string;
      toolCalls: readonly ToolCallRecord[];
    };
