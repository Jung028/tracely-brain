// Unit tests for TimelineView's pure hypothesis-linkage formatting helpers
// (src/timeline/TimelineView.tsx). No DOM/React testing library needed —
// these are plain functions extracted specifically so they're testable
// without rendering. Locks in the fix for the review finding that
// "Supports: {hypothesisId} ({supports}) — {meaning}" duplicated the
// hypothesis id and didn't match specs/04-evidence-timeline.md's literal
// example for the canonical demo step.
import { describe, expect, test } from "bun:test";
import { formatHypothesisLine, hypothesisLinkLabel } from "../../src/timeline/TimelineView";
import { demoToolCalls } from "../../src/timeline/demoFixture";

describe("hypothesisLinkLabel", () => {
  test("supporting -> \"Supports\"", () => {
    expect(hypothesisLinkLabel("supporting")).toBe("Supports");
  });

  test("contradicting -> \"Refutes\"", () => {
    expect(hypothesisLinkLabel("contradicting")).toBe("Refutes");
  });

  test("null -> \"Supports\" (only reached from a non-null-hypothesisId caller)", () => {
    expect(hypothesisLinkLabel(null)).toBe("Supports");
  });
});

describe("formatHypothesisLine", () => {
  test("exploratory step (hypothesisId: null) renders the explicit not-linked label", () => {
    expect(
      formatHypothesisLine({ hypothesisId: null, supports: null, meaning: null }),
    ).toBe("Exploratory — not linked to a hypothesis");
  });

  test("supporting step: no duplicated hypothesis id, no parenthetical qualifier", () => {
    expect(
      formatHypothesisLine({
        hypothesisId: "H1",
        supports: "supporting",
        meaning: "scheduler-related workflow blockage",
      }),
    ).toBe("Supports: H1 — scheduler-related workflow blockage");
  });

  test("contradicting step uses the \"Refutes\" label", () => {
    expect(
      formatHypothesisLine({
        hypothesisId: "H1",
        supports: "contradicting",
        meaning: "downstream consumer is healthy",
      }),
    ).toBe("Refutes: H1 — downstream consumer is healthy");
  });

  test("demoFixture's canonical step matches specs/04-evidence-timeline.md's example verbatim", () => {
    const step1 = demoToolCalls.find((call) => call.id === "step-1");
    expect(step1).toBeDefined();
    expect(formatHypothesisLine(step1!)).toBe(
      "Supports: H1 — scheduler-related workflow blockage",
    );
  });

  test("every demoFixture step with a supports value formats without a duplicated hypothesis id", () => {
    for (const call of demoToolCalls) {
      if (call.hypothesisId === null) {
        continue;
      }
      const line = formatHypothesisLine(call);
      // The hypothesis id should appear exactly once in the formatted line.
      const occurrences = line.split(call.hypothesisId).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});
