import type {
  InvestigationState,
  TransitionContext,
  TransitionEvent,
  TransitionResult,
} from "./types";

const REOPEN_LIMIT = 3;

// The full legal-transition table (9 edges). Any (state, event) pair not
// listed here is illegal. RESOLVED has no entries at all — it accepts no
// events, per FR-35's terminal-state requirement.
const TRANSITIONS: Record<
  InvestigationState,
  Partial<Record<TransitionEvent["type"], InvestigationState>>
> = {
  CREATED: {
    BEGIN_INVESTIGATING: "INVESTIGATING",
  },
  INVESTIGATING: {
    RCA_CONFIRMED: "RCA_IDENTIFIED",
    INSUFFICIENT_EVIDENCE: "MANUAL_REVIEW_REQUIRED",
  },
  RCA_IDENTIFIED: {
    PROPOSE_RESOLUTION: "RESOLUTION_PROPOSAL",
    CLOSE_DIRECTLY: "RESOLVED",
  },
  MANUAL_REVIEW_REQUIRED: {
    REOPEN: "INVESTIGATING",
    CLOSE_DIRECTLY: "RESOLVED",
  },
  RESOLUTION_PROPOSAL: {
    RESOLUTION_APPROVED: "RESOLVED",
    RESOLUTION_REJECTED: "MANUAL_REVIEW_REQUIRED",
  },
  RESOLVED: {},
};

export function transition(
  current: InvestigationState,
  event: TransitionEvent,
  context: TransitionContext,
): TransitionResult {
  if (
    event.type === "REOPEN" &&
    current === "MANUAL_REVIEW_REQUIRED" &&
    context.retryCount >= REOPEN_LIMIT
  ) {
    return {
      ok: false,
      error: `cannot reopen investigation: retry limit reached (${context.retryCount}/${REOPEN_LIMIT})`,
    };
  }

  const nextState = TRANSITIONS[current]?.[event.type];
  if (!nextState) {
    return {
      ok: false,
      error: `illegal transition: cannot apply ${event.type} from ${current}`,
    };
  }

  return { ok: true, state: nextState };
}
