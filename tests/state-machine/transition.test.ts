import { describe, expect, test } from "bun:test";
import { transition } from "../../src/state-machine";
import type { InvestigationState, TransitionEvent } from "../../src/state-machine";

describe("transition — exhaustive legal/illegal coverage", () => {
  const ALL_STATES: InvestigationState[] = [
    "CREATED",
    "INVESTIGATING",
    "RCA_IDENTIFIED",
    "MANUAL_REVIEW_REQUIRED",
    "RESOLUTION_PROPOSAL",
    "RESOLVED",
  ];

  const ALL_EVENTS: TransitionEvent[] = [
    { type: "BEGIN_INVESTIGATING" },
    { type: "RCA_CONFIRMED" },
    { type: "INSUFFICIENT_EVIDENCE" },
    { type: "PROPOSE_RESOLUTION" },
    { type: "CLOSE_DIRECTLY" },
    { type: "REOPEN" },
    { type: "RESOLUTION_APPROVED" },
    { type: "RESOLUTION_REJECTED" },
  ];

  // Independently declared expected-legal set (not imported from
  // src/state-machine/transition.ts's own table) so this test is a real
  // check against the spec's 9 edges, not a tautology against the
  // implementation's own data structure.
  const LEGAL_PAIRS: ReadonlySet<string> = new Set([
    "CREATED:BEGIN_INVESTIGATING",
    "INVESTIGATING:RCA_CONFIRMED",
    "INVESTIGATING:INSUFFICIENT_EVIDENCE",
    "RCA_IDENTIFIED:PROPOSE_RESOLUTION",
    "RCA_IDENTIFIED:CLOSE_DIRECTLY",
    "MANUAL_REVIEW_REQUIRED:REOPEN",
    "MANUAL_REVIEW_REQUIRED:CLOSE_DIRECTLY",
    "RESOLUTION_PROPOSAL:RESOLUTION_APPROVED",
    "RESOLUTION_PROPOSAL:RESOLUTION_REJECTED",
  ]);

  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const key = `${state}:${event.type}`;
      const expectLegal = LEGAL_PAIRS.has(key);

      test(`${key} is ${expectLegal ? "legal" : "illegal"}`, () => {
        // retryCount 0 for every case except MANUAL_REVIEW_REQUIRED:REOPEN,
        // which the dedicated retry-cap describe block below already
        // covers at every boundary value — this loop only needs one
        // representative retryCount to prove the (state, event) pair's
        // legality.
        const result = transition(state, event, { retryCount: 0 });
        expect(result.ok).toBe(expectLegal);
      });
    }
  }
});

describe("transition — reopen retry cap", () => {
  test("allows reopening at retryCount 0, 1, 2 (under the cap of 3)", () => {
    for (const retryCount of [0, 1, 2]) {
      const result = transition("MANUAL_REVIEW_REQUIRED", { type: "REOPEN" }, { retryCount });
      expect(result).toEqual({ ok: true, state: "INVESTIGATING" });
    }
  });

  test("rejects reopening at retryCount 3 (cap reached), naming the limit in the error", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "REOPEN" }, { retryCount: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("3");
  });
});
