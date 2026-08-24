import { describe, expect, test } from "bun:test";
import { transition } from "../../src/state-machine";
import type { TransitionEvent } from "../../src/state-machine";

const noRetries = { retryCount: 0 };

describe("transition — legal edges", () => {
  test("CREATED --BEGIN_INVESTIGATING--> INVESTIGATING", () => {
    const result = transition("CREATED", { type: "BEGIN_INVESTIGATING" }, noRetries);
    expect(result).toEqual({ ok: true, state: "INVESTIGATING" });
  });

  test("INVESTIGATING --RCA_CONFIRMED--> RCA_IDENTIFIED", () => {
    const result = transition("INVESTIGATING", { type: "RCA_CONFIRMED" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RCA_IDENTIFIED" });
  });

  test("INVESTIGATING --INSUFFICIENT_EVIDENCE--> MANUAL_REVIEW_REQUIRED", () => {
    const result = transition("INVESTIGATING", { type: "INSUFFICIENT_EVIDENCE" }, noRetries);
    expect(result).toEqual({ ok: true, state: "MANUAL_REVIEW_REQUIRED" });
  });

  test("RCA_IDENTIFIED --PROPOSE_RESOLUTION--> RESOLUTION_PROPOSAL", () => {
    const result = transition("RCA_IDENTIFIED", { type: "PROPOSE_RESOLUTION" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLUTION_PROPOSAL" });
  });

  test("RCA_IDENTIFIED --CLOSE_DIRECTLY--> RESOLVED", () => {
    const result = transition("RCA_IDENTIFIED", { type: "CLOSE_DIRECTLY" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLVED" });
  });

  test("MANUAL_REVIEW_REQUIRED --REOPEN--> INVESTIGATING (under the retry cap)", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "REOPEN" }, { retryCount: 2 });
    expect(result).toEqual({ ok: true, state: "INVESTIGATING" });
  });

  test("MANUAL_REVIEW_REQUIRED --CLOSE_DIRECTLY--> RESOLVED", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "CLOSE_DIRECTLY" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLVED" });
  });

  test("RESOLUTION_PROPOSAL --RESOLUTION_APPROVED--> RESOLVED", () => {
    const result = transition("RESOLUTION_PROPOSAL", { type: "RESOLUTION_APPROVED" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLVED" });
  });

  test("RESOLUTION_PROPOSAL --RESOLUTION_REJECTED--> MANUAL_REVIEW_REQUIRED", () => {
    const result = transition("RESOLUTION_PROPOSAL", { type: "RESOLUTION_REJECTED" }, noRetries);
    expect(result).toEqual({ ok: true, state: "MANUAL_REVIEW_REQUIRED" });
  });
});

describe("transition — illegal edges", () => {
  test("the spec's explicit example: CREATED --CLOSE_DIRECTLY--> RESOLVED (skipping the whole lifecycle) is rejected", () => {
    const result = transition("CREATED", { type: "CLOSE_DIRECTLY" }, noRetries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("CREATED");
  });

  test("INVESTIGATING cannot REOPEN (REOPEN only applies from MANUAL_REVIEW_REQUIRED)", () => {
    const result = transition("INVESTIGATING", { type: "REOPEN" }, noRetries);
    expect(result.ok).toBe(false);
  });

  test("RCA_IDENTIFIED cannot receive INSUFFICIENT_EVIDENCE", () => {
    const result = transition("RCA_IDENTIFIED", { type: "INSUFFICIENT_EVIDENCE" }, noRetries);
    expect(result.ok).toBe(false);
  });

  test("MANUAL_REVIEW_REQUIRED cannot receive BEGIN_INVESTIGATING", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "BEGIN_INVESTIGATING" }, noRetries);
    expect(result.ok).toBe(false);
  });
});

describe("transition — RESOLVED is terminal", () => {
  const allEvents: TransitionEvent[] = [
    { type: "BEGIN_INVESTIGATING" },
    { type: "RCA_CONFIRMED" },
    { type: "INSUFFICIENT_EVIDENCE" },
    { type: "PROPOSE_RESOLUTION" },
    { type: "CLOSE_DIRECTLY" },
    { type: "REOPEN" },
    { type: "RESOLUTION_APPROVED" },
    { type: "RESOLUTION_REJECTED" },
  ];

  for (const event of allEvents) {
    test(`RESOLVED rejects ${event.type}`, () => {
      const result = transition("RESOLVED", event, noRetries);
      expect(result.ok).toBe(false);
    });
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
