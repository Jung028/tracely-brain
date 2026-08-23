// The persistent Investigation record (FR-33). Unlike src/session's
// in-memory registry (removed the moment investigate() resolves), this
// survives indefinitely — FR-34's link may be clicked long after the
// investigation finishes.
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";

export interface Investigation {
  readonly id: string;
  readonly status: "IN_PROGRESS" | "CONFIRMED" | "INSUFFICIENT_EVIDENCE";
  readonly problemDescription: string;
  readonly slackChannelId: string | null;
  readonly slackThreadTs: string | null;
  readonly result: { result: InvestigationResult; timeline: InvestigationTimeline } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
