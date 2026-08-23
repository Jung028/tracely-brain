import { describe, expect, test } from "bun:test";
import { buildFailureReport, renderFailureReport } from "../../src/failure";
import type { Evidence, Hypothesis, InvestigationResult } from "../../src/agent/types";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: crypto.randomUUID(),
    toolSource: "query_brain",
    description: "test evidence",
    timestamp: new Date(),
    raw: null,
    ...overrides,
  };
}

function hypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: crypto.randomUUID(),
    statement: "test hypothesis",
    supportingEvidence: [],
    contradictingEvidence: [],
    status: "INVESTIGATING",
    confidence: 0,
    ...overrides,
  };
}

function insufficientEvidence(
  hypothesesConsidered: Hypothesis[],
  reason = "no hypothesis reached the confirmation threshold",
): Extract<InvestigationResult, { outcome: "INSUFFICIENT_EVIDENCE" }> {
  return { outcome: "INSUFFICIENT_EVIDENCE", hypothesesConsidered, reason };
}

describe("buildFailureReport", () => {
  // Spec test case: zero confirmed hypotheses at the end of the agent loop.
  test("no hypothesis proposed at all: NOT CONFIRMED, falls back to module 03's reason, no invented Missing text", () => {
    const report = buildFailureReport(insufficientEvidence([], "no hypothesis was proposed"));

    expect(report.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(report.rootCause).toBe("NOT CONFIRMED");
    expect(report.investigated).toEqual([]);
    expect(report.missing).toBe("no hypothesis was proposed");
    expect(report.recommendedNextStep).toBe(
      "Escalate to a human investigator for manual review — no automated path to more evidence.",
    );
  });

  // Spec test case: highest-confidence hypothesis below threshold, even
  // though some real evidence exists.
  test("some evidence gathered but below confirmation threshold: still NOT CONFIRMED, investigated lists sources actually cited", () => {
    const h = hypothesis({
      confidence: 0.6,
      supportingEvidence: [
        evidence({ toolSource: "query_brain" }),
        evidence({ toolSource: "search_code" }),
      ],
    });
    const report = buildFailureReport(insufficientEvidence([h]));

    expect(report.rootCause).toBe("NOT CONFIRMED");
    expect([...report.investigated].sort()).toEqual(["Code", "Company Brain"]);
    expect(report.missing).toBe("no hypothesis reached the confirmation threshold");
  });

  // Spec test case: investigation blocked by a missing required source
  // (module 02's failure cases) — must route here, not crash or guess.
  // Only detectable when the failed call was actually cited as evidence —
  // see the "known limitation" note in report.ts.
  test("evidence citing a permanently-stubbed source (Database/Logs) surfaces as a missing-source signal, not a clean empty result", () => {
    const h = hypothesis({
      supportingEvidence: [
        evidence({ toolSource: "query_brain" }),
        evidence({
          toolSource: "query_database",
          raw: { status: "NOT_IMPLEMENTED", tool: "query_database" },
        }),
        evidence({
          toolSource: "search_logs",
          raw: { status: "NOT_IMPLEMENTED", tool: "search_logs" },
        }),
      ],
    });
    const report = buildFailureReport(insufficientEvidence([h]));

    expect([...report.investigated].sort()).toEqual(["Company Brain", "Database", "Logs"]);
    expect(report.missing).toBe(
      "Database unavailable (not yet implemented); Logs unavailable (not yet implemented)",
    );
    expect(report.recommendedNextStep).toBe(
      "Connect the Database integration; it is not yet implemented.",
    );
  });

  test("a real connection failure (e.g. expired auth) is detected generically via evidence.raw's status/detail fields", () => {
    const h = hypothesis({
      supportingEvidence: [
        evidence({
          toolSource: "search_code",
          raw: { status: "auth_expired", detail: "GitHub token expired" },
        }),
      ],
    });
    const report = buildFailureReport(insufficientEvidence([h]));

    expect(report.missing).toBe("Code unavailable (GitHub token expired)");
    expect(report.recommendedNextStep).toBe("Refresh credentials for Code and retry.");
  });

  test("evidence with no failure/NOT_IMPLEMENTED status in its raw result is not treated as missing", () => {
    const h = hypothesis({
      supportingEvidence: [evidence({ toolSource: "query_brain", raw: { entities: [] } })],
    });
    const report = buildFailureReport(insufficientEvidence([h], "no hypothesis was proposed"));

    expect(report.missing).toBe("no hypothesis was proposed");
  });

  test("an unrecognized toolSource string passes through as-is rather than being dropped or fabricated", () => {
    const h = hypothesis({
      supportingEvidence: [evidence({ toolSource: "some_future_tool" })],
    });
    const report = buildFailureReport(insufficientEvidence([h]));

    expect(report.investigated).toEqual(["some_future_tool"]);
  });
});

describe("renderFailureReport", () => {
  test("matches the spec's example layout", () => {
    const rendered = renderFailureReport({
      status: "MANUAL_REVIEW_REQUIRED",
      rootCause: "NOT CONFIRMED",
      investigated: ["Database", "Logs", "Code"],
      missing: "Trace expired",
      recommendedNextStep: "Retry once the trace source is reachable.",
    });

    expect(rendered).toBe(
      [
        "Investigation completed",
        "Root cause: NOT CONFIRMED",
        "Investigated: ✓ Database  ✓ Logs  ✓ Code",
        "Missing: Trace expired",
        "Recommended next investigation: Retry once the trace source is reachable.",
      ].join("\n"),
    );
  });

  test("renders an empty investigated list without crashing", () => {
    const rendered = renderFailureReport({
      status: "MANUAL_REVIEW_REQUIRED",
      rootCause: "NOT CONFIRMED",
      investigated: [],
      missing: "no hypothesis was proposed",
      recommendedNextStep: "Escalate to a human investigator for manual review.",
    });

    expect(rendered).toContain("Investigated: \n");
  });
});
