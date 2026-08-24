// Unit tests for TimelineView's pure hypothesis-linkage formatting helpers
// (src/timeline/TimelineView.tsx). No DOM/React testing library needed —
// these are plain functions extracted specifically so they're testable
// without rendering. Locks in the fix for the review finding that
// "Supports: {hypothesisId} ({supports}) — {meaning}" duplicated the
// hypothesis id and didn't match specs/04-evidence-timeline.md's literal
// example for the canonical demo step.
import { describe, expect, test } from "bun:test";
import { findingLine, formatHypothesisLine, hypothesisLinkLabel, summarizeResult } from "../../src/timeline/TimelineView";
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

describe("summarizeResult", () => {
  test("null/undefined -> \"No result\"", () => {
    expect(summarizeResult(null)).toBe("No result");
    expect(summarizeResult(undefined)).toBe("No result");
  });

  test("empty array -> \"No matches found\"", () => {
    expect(summarizeResult([])).toBe("No matches found");
  });

  test("non-empty array -> a count, pluralized correctly", () => {
    expect(summarizeResult([1])).toBe("Found 1 result");
    expect(summarizeResult([1, 2, 3])).toBe("Found 3 results");
  });

  test("plain object -> compact JSON, truncated past 80 chars", () => {
    expect(summarizeResult({ status: "WAIT_JUDGE" })).toBe('{"status":"WAIT_JUDGE"}');

    const big = { a: "x".repeat(100) };
    const out = summarizeResult(big);
    expect(out.length).toBe(81); // 80 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  test("primitive -> its string form", () => {
    expect(summarizeResult(42)).toBe("42");
    expect(summarizeResult("done")).toBe("done");
  });
});

describe("findingLine", () => {
  test("uses step.meaning when present, ignoring result entirely", () => {
    expect(
      findingLine({ meaning: "scheduler-related workflow blockage", result: { status: "WAIT_JUDGE" } }),
    ).toBe("scheduler-related workflow blockage");
  });

  test("falls back to summarizeResult(result) when meaning is null", () => {
    expect(findingLine({ meaning: null, result: [] })).toBe("No matches found");
    expect(findingLine({ meaning: null, result: { count: 14 } })).toBe('{"count":14}');
  });

  test("falls back to summarizeResult(result) when meaning is an empty string", () => {
    expect(findingLine({ meaning: "", result: { count: 14 } })).toBe('{"count":14}');
  });
});
