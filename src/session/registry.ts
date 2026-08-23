// In-memory, poll-based session registry (FR-28). A caller with a
// sessionId can read a running investigation's current state at any point
// before investigate() resolves — see docs/human-collaboration.md.
import type { InvestigationState } from "../agent/tools";
import type { LiveInvestigationState } from "./types";

const sessions = new Map<string, InvestigationState>();

/** Throws on a duplicate sessionId — prevents one investigation's state
 * from silently overwriting/cross-talking with another's in the registry. */
export function registerSession(sessionId: string, state: InvestigationState): void {
  if (sessions.has(sessionId)) {
    throw new Error(`session already registered: ${sessionId}`);
  }
  sessions.set(sessionId, state);
}

/** No-op if the sessionId isn't registered — safe to call unconditionally
 * from a finally block regardless of whether registration happened. */
export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Returns a defensive snapshot copy — never the live InvestigationState
 * object — so a caller can't mutate an in-progress investigation. */
export function getInvestigationState(sessionId: string): LiveInvestigationState | undefined {
  const state = sessions.get(sessionId);
  if (!state) return undefined;

  return {
    sessionId,
    status: "IN_PROGRESS",
    stepNumber: state.stepNumber,
    hypotheses: [...state.hypotheses],
  };
}
