// The persistent Investigation record (FR-33, FR-35). Unlike src/session's
// in-memory registry (removed the moment investigate() resolves), this
// survives indefinitely — FR-34's link may be clicked long after the
// investigation finishes. `status` is now the full FR-35 lifecycle (see
// src/state-machine/), not module 07's original 3-value placeholder.
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";
import type { InvestigationState } from "../state-machine";

export interface Investigation {
  readonly id: string;
  readonly status: InvestigationState;
  readonly retryCount: number;
  readonly problemDescription: string;
  readonly slackChannelId: string | null;
  readonly slackThreadTs: string | null;
  readonly result: { result: InvestigationResult; timeline: InvestigationTimeline } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type InvestigationTransitionResult =
  | { ok: true; investigation: Investigation }
  | { ok: false; error: string };
