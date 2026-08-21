// Exercises FR-20 end-to-end: the first hypothesis is deliberately refuted
// by scripted contradicting evidence (from query_brain), and a second
// hypothesis is proposed and confirmed using evidence from both
// query_brain and search_code.
import { afterEach, describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedRealCodeFileEntity } from "../fixtures/seedBrain";
import { truncateAll } from "../../db-helpers";

// Same isolation pattern every other Brain-writing test file in this repo
// uses — without it, the Code-domain File entity this scenario seeds leaks
// into the shared test DB and pollutes unrelated test files' assertions.
afterEach(async () => {
  await truncateAll();
});

describe("demo scenario: race condition (FR-20 end-to-end)", () => {
  test("first hypothesis is REFUTED, a replacement is proposed and CONFIRMED via two tool types", async () => {
    await seedRealCodeFileEntity();
    let firstHypothesisId: string | undefined;
    let secondHypothesisId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "propose_hypothesis",
              input: { statement: "Both writers acquired the lock simultaneously" },
            },
          ],
        };
      }

      if (!firstHypothesisId) firstHypothesisId = extractHypothesisId(bodyText);

      // Turns 2-6: contradict the first hypothesis via query_brain until
      // REFUTED (REFUTATION_THRESHOLD 0.75 at 0.2/item -> 5 items).
      if (callIndex <= 6) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_contra_${callIndex}`,
              name: "update_hypothesis",
              input: {
                hypothesisId: firstHypothesisId,
                direction: "contradicting",
                description: `contradiction ${callIndex}`,
                toolSource: "query_brain",
              },
            },
          ],
        };
      }

      if (callIndex === 7) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_second",
              name: "propose_hypothesis",
              input: { statement: "Writer B's retry lacked the ordering guarantee" },
            },
          ],
        };
      }

      if (!secondHypothesisId) {
        secondHypothesisId = extractHypothesisId(bodyText, firstHypothesisId);
      }

      if (callIndex === 8) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_search_code",
              name: "search_code",
              input: { pathContains: "package.json" },
            },
          ],
        };
      }

      if (callIndex <= 13) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_support_${callIndex}`,
              name: "update_hypothesis",
              input: {
                hypothesisId: secondHypothesisId,
                direction: "supporting",
                description: `support ${callIndex}`,
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }

      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Two concurrent writers produced an inconsistent balance.",
      { client, maxIterations: 20 },
    );

    expect(result.outcome).toBe("CONFIRMED");
    if (result.outcome !== "CONFIRMED") throw new Error("unreachable");
    expect(result.hypothesis.statement).toBe("Writer B's retry lacked the ordering guarantee");
  });
});
