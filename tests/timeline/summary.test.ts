import { describe, expect, test } from "bun:test";
import { buildSummary } from "../../src/timeline/summary";
import type { InvestigationResult } from "../../src/agent/types";

describe("buildSummary", () => {
  test("CONFIRMED outcome maps to a single hypothesis and a non-null rca", () => {
    const result: InvestigationResult = {
      outcome: "CONFIRMED",
      hypothesis: {
        id: "H1",
        statement: "Scheduler is disabled",
        supportingEvidence: [],
        contradictingEvidence: [],
        status: "CONFIRMED",
        confidence: 0.9,
      },
      rca: "The liability-assignment scheduler was disabled.",
      evidenceTrail: [],
      toolCalls: [],
    };

    const summary = buildSummary(result);

    expect(summary.outcome).toBe("CONFIRMED");
    expect(summary.rca).toBe("The liability-assignment scheduler was disabled.");
    expect(summary.reason).toBeNull();
    expect(summary.hypotheses).toEqual([
      { id: "H1", statement: "Scheduler is disabled", status: "CONFIRMED", confidence: 0.9 },
    ]);
  });

  test("INSUFFICIENT_EVIDENCE outcome maps all hypothesesConsidered and sets reason/rca correctly", () => {
    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [
        {
          id: "H1",
          statement: "Downstream consumer is down",
          supportingEvidence: [],
          contradictingEvidence: [],
          status: "REFUTED",
          confidence: 0.1,
        },
      ],
      reason: "No hypothesis reached the confirmation threshold.",
      toolCalls: [],
    };

    const summary = buildSummary(result);

    expect(summary.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(summary.rca).toBeNull();
    expect(summary.reason).toBe("No hypothesis reached the confirmation threshold.");
    expect(summary.hypotheses).toEqual([
      { id: "H1", statement: "Downstream consumer is down", status: "REFUTED", confidence: 0.1 },
    ]);
  });

  test("INSUFFICIENT_EVIDENCE with zero hypotheses considered produces an empty hypotheses array", () => {
    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    };

    const summary = buildSummary(result);

    expect(summary.hypotheses).toEqual([]);
  });
});
