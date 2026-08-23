// FR-28's read model — a point-in-time snapshot of a running investigation,
// returned by getInvestigationState. Never a live reference into the
// mutable InvestigationState a running investigate() call owns.
import type { Hypothesis } from "../agent/types";

export interface LiveInvestigationState {
  readonly sessionId: string;
  readonly status: "IN_PROGRESS";
  readonly stepNumber: number;
  readonly hypotheses: readonly Hypothesis[];
}
