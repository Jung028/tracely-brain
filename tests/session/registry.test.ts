import { describe, expect, test } from "bun:test";
import { registerSession, unregisterSession, getInvestigationState } from "../../src/session";
import { createInvestigationState } from "../../src/agent/tools";
import { proposeHypothesis } from "../../src/agent/hypotheses";
import type { Hypothesis } from "../../src/agent/types";

describe("session registry", () => {
  test("getInvestigationState returns undefined for an unregistered session", () => {
    expect(getInvestigationState("does-not-exist")).toBeUndefined();
  });

  test("registerSession then getInvestigationState returns a snapshot of the current state", () => {
    const sessionId = crypto.randomUUID();
    const state = createInvestigationState();
    state.hypotheses.push(proposeHypothesis("Scheduler is disabled"));
    state.stepNumber = 3;

    registerSession(sessionId, state);
    const snapshot = getInvestigationState(sessionId);

    expect(snapshot).toBeDefined();
    expect(snapshot!.sessionId).toBe(sessionId);
    expect(snapshot!.status).toBe("IN_PROGRESS");
    expect(snapshot!.stepNumber).toBe(3);
    expect(snapshot!.hypotheses).toHaveLength(1);
    expect(snapshot!.hypotheses[0]!.statement).toBe("Scheduler is disabled");

    unregisterSession(sessionId);
  });

  test("registering the same sessionId twice throws", () => {
    const sessionId = crypto.randomUUID();
    registerSession(sessionId, createInvestigationState());

    expect(() => registerSession(sessionId, createInvestigationState())).toThrow();

    unregisterSession(sessionId);
  });

  test("unregisterSession removes the entry — subsequent getInvestigationState returns undefined", () => {
    const sessionId = crypto.randomUUID();
    registerSession(sessionId, createInvestigationState());
    unregisterSession(sessionId);

    expect(getInvestigationState(sessionId)).toBeUndefined();
  });

  test("unregistering a sessionId that was never registered is a harmless no-op", () => {
    expect(() => unregisterSession("never-registered")).not.toThrow();
  });

  test("the snapshot's hypotheses array is a copy, not a live reference into the registered state", () => {
    const sessionId = crypto.randomUUID();
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const snapshot = getInvestigationState(sessionId)!;
    (snapshot.hypotheses as Hypothesis[]).push(proposeHypothesis("mutated from outside"));

    expect(state.hypotheses).toHaveLength(0);

    unregisterSession(sessionId);
  });
});
