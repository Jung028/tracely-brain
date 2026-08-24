// Pure transform: agent InvestigationResult -> a small UI-friendly summary.
// Kept separate from build.ts (which only handles the step timeline) since
// this reads a different half of InvestigationResult — the concluded
// outcome/hypotheses, not the ToolCallRecord[] — and callers (server.ts's
// /api/timeline/:id route, TimelineView's summary header) need both halves
// independently. No I/O, pure function of its input, same shape as build.ts.
import type { Hypothesis, InvestigationResult } from "../agent/types";

export interface HypothesisSummary {
  readonly id: string;
  readonly statement: string;
  readonly status: Hypothesis["status"];
  readonly confidence: number;
}

export interface InvestigationSummary {
  readonly outcome: InvestigationResult["outcome"];
  readonly rca: string | null;
  readonly reason: string | null;
  readonly hypotheses: readonly HypothesisSummary[];
}

function toHypothesisSummary(hypothesis: Hypothesis): HypothesisSummary {
  return {
    id: hypothesis.id,
    statement: hypothesis.statement,
    status: hypothesis.status,
    confidence: hypothesis.confidence,
  };
}

export function buildSummary(result: InvestigationResult): InvestigationSummary {
  if (result.outcome === "CONFIRMED") {
    return {
      outcome: "CONFIRMED",
      rca: result.rca,
      reason: null,
      hypotheses: [toHypothesisSummary(result.hypothesis)],
    };
  }
  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    rca: null,
    reason: result.reason,
    hypotheses: result.hypothesesConsidered.map(toHypothesisSummary),
  };
}
