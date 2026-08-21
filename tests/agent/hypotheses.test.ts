import { describe, expect, test } from "bun:test";
import {
  addContradictingEvidence,
  addSupportingEvidence,
  CONFIRMATION_THRESHOLD,
  proposeHypothesis,
  REFUTATION_THRESHOLD,
} from "../../src/agent/hypotheses";
import type { Evidence } from "../../src/agent/types";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: crypto.randomUUID(),
    toolSource: "queryBrain",
    description: "test evidence",
    timestamp: new Date(),
    raw: null,
    ...overrides,
  };
}

describe("proposeHypothesis", () => {
  test("starts INVESTIGATING with confidence 0 and no evidence", () => {
    const h = proposeHypothesis("Scheduler is disabled");
    expect(h.status).toBe("INVESTIGATING");
    expect(h.confidence).toBe(0);
    expect(h.supportingEvidence).toEqual([]);
    expect(h.contradictingEvidence).toEqual([]);
    expect(h.statement).toBe("Scheduler is disabled");
  });
});

describe("addSupportingEvidence", () => {
  test("raises confidence but stays INVESTIGATING below CONFIRMATION_THRESHOLD", () => {
    const h = proposeHypothesis("Scheduler is disabled");
    const updated = addSupportingEvidence(h, evidence());
    expect(updated.supportingEvidence).toHaveLength(1);
    expect(updated.confidence).toBeGreaterThan(0);
    expect(updated.confidence).toBeLessThan(CONFIRMATION_THRESHOLD);
    expect(updated.status).toBe("INVESTIGATING");
  });

  test("transitions to CONFIRMED once confidence crosses the threshold with zero contradicting evidence", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    // Each addSupportingEvidence call is independently reviewable — verify
    // the exact boundary: stays INVESTIGATING at 3 items, transitions at 4.
    for (let i = 0; i < 3; i++) {
      h = addSupportingEvidence(h, evidence());
    }
    expect(h.supportingEvidence).toHaveLength(3);
    expect(h.confidence).toBeLessThan(CONFIRMATION_THRESHOLD);
    expect(h.status).toBe("INVESTIGATING");

    // Now add the 4th item — should cross the threshold and transition to CONFIRMED
    h = addSupportingEvidence(h, evidence());
    expect(h.supportingEvidence).toHaveLength(4);
    expect(h.confidence).toBeGreaterThanOrEqual(CONFIRMATION_THRESHOLD);
    expect(h.status).toBe("CONFIRMED");
  });

  test("never reaches CONFIRMED while any contradicting evidence remains, regardless of supporting count", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    for (let i = 0; i < 10; i++) {
      h = addSupportingEvidence(h, evidence());
    }
    expect(h.status).not.toBe("CONFIRMED");
  });
});

describe("addContradictingEvidence", () => {
  test("transitions to REFUTED once contradicting weight crosses REFUTATION_THRESHOLD", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    // Verify the exact boundary: stays INVESTIGATING at 3 items, transitions at 4.
    for (let i = 0; i < 3; i++) {
      h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    }
    expect(h.contradictingEvidence).toHaveLength(3);
    expect(h.status).toBe("INVESTIGATING");

    // Now add the 4th item — should cross the threshold and transition to REFUTED
    h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    expect(h.contradictingEvidence).toHaveLength(4);
    expect(h.status).toBe("REFUTED");
  });

  test("a single weak contradiction does not refute the hypothesis outright", () => {
    const h = proposeHypothesis("Scheduler is disabled");
    const updated = addContradictingEvidence(h, evidence());
    expect(updated.contradictingEvidence).toHaveLength(1);
    expect(updated.status).toBe("INVESTIGATING");
  });

  test("REFUTED is terminal: further supporting evidence cannot move it back to INVESTIGATING or CONFIRMED", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    for (let i = 0; i < 5; i++) {
      h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    }
    expect(h.status).toBe("REFUTED");
    h = addSupportingEvidence(h, evidence());
    expect(h.status).toBe("REFUTED");
  });
});
