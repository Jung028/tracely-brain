// FR-35's formal investigation lifecycle. See
// docs/superpowers/specs/2026-08-24-module-08-state-machine-design.md for
// the full diagram and rationale behind every edge.
export type InvestigationState =
  | "CREATED"
  | "INVESTIGATING"
  | "RCA_IDENTIFIED"
  | "MANUAL_REVIEW_REQUIRED"
  | "RESOLUTION_PROPOSAL"
  | "RESOLVED";

export type TransitionEvent =
  | { type: "BEGIN_INVESTIGATING" }
  | { type: "RCA_CONFIRMED" }
  | { type: "INSUFFICIENT_EVIDENCE" }
  | { type: "PROPOSE_RESOLUTION" }
  | { type: "CLOSE_DIRECTLY" }
  | { type: "REOPEN" }
  | { type: "RESOLUTION_APPROVED" }
  | { type: "RESOLUTION_REJECTED" };

export interface TransitionContext {
  readonly retryCount: number;
}

export type TransitionResult =
  | { ok: true; state: InvestigationState }
  | { ok: false; error: string };
