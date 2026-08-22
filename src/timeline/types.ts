// Module 04's canonical display data model. This is a pure rendering-shaped
// view over Module 03's `ToolCallRecord` (src/agent/types.ts) — see
// build.ts for the transform. Field renames/shape here exist purely to
// match how the UI (a later task) will consume this: FR-21 requires "what
// was queried, why, what was found, what it means, which hypothesis it
// supports/refutes, which source produced it" per step.
export interface TimelineStep {
  readonly id: string;
  readonly toolName: string;
  readonly query: unknown;
  readonly why: string;
  readonly result: unknown;
  readonly meaning: string | null;
  readonly hypothesisId: string | null;
  readonly supports: "supporting" | "contradicting" | null;
  readonly timestamp: Date;
  readonly concurrencyGroup: string;
}

export interface InvestigationTimeline {
  readonly steps: readonly TimelineStep[];
}
