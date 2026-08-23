// Spec-required adversarial test case: feed the agent a scenario
// deliberately designed to tempt a plausible-but-wrong guess (a red-herring
// correlation), and confirm the full pipeline — module 03's confidence gate
// plus module 05's report formatting — never dresses that up as a
// confirmed root cause.
import { describe, expect, test } from "bun:test";
import { investigate } from "../../src/agent/investigate";
import { buildFailureReport } from "../../src/failure";
import { createStepFunctionClient, extractHypothesisId } from "../agent/helpers/mockAnthropicClient";

describe("adversarial: red-herring correlation", () => {
  test("a plausible-looking but numerically insufficient correlation is never reported as a confirmed root cause", async () => {
    let hypothesisId: string | undefined;

    // The model proposes a tempting-sounding hypothesis (a deploy that
    // happened to coincide with the incident) and cites three separate
    // "corroborating" observations for it — enough to sound convincing in
    // prose, but each increment is 0.2 (see hypotheses.ts), so 3 items only
    // reaches 0.6 confidence, below CONFIRMATION_THRESHOLD (0.75). The model
    // then gives up rather than fabricating a fourth. investigate() must
    // resolve to INSUFFICIENT_EVIDENCE, not CONFIRMED, purely on that count
    // — regardless of how convincing the evidence descriptions read.
    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: {
                statement: "A deploy at 14:02 caused the incident (timing correlation)",
              },
            },
          ],
        };
      }

      if (callIndex <= 4) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_evidence_${callIndex}`,
              name: "update_hypothesis",
              input: {
                hypothesisId,
                direction: "supporting",
                description: `Deploy timestamp is within 90 seconds of the first error (observation ${callIndex - 1})`,
                toolSource: "query_brain",
              },
            },
          ],
        };
      }

      return {
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: "The timing correlation is suggestive but I cannot confirm causation with the evidence gathered.",
          },
        ],
      };
    });

    const result = await investigate("Elevated error rate starting at 14:03", { client });

    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    if (result.outcome !== "INSUFFICIENT_EVIDENCE") throw new Error("unreachable");
    expect(result.hypothesesConsidered).toHaveLength(1);
    expect(result.hypothesesConsidered[0]!.confidence).toBeLessThan(0.75);
    expect(result.hypothesesConsidered[0]!.status).toBe("INVESTIGATING");

    const report = buildFailureReport(result);
    expect(report.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(report.rootCause).toBe("NOT CONFIRMED");
    // The report must never smuggle the red-herring statement in as if it
    // were a confirmed cause.
    expect(JSON.stringify(report)).not.toContain("caused the incident");
  });
});
