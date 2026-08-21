// Demo scenario 2/3. query_brain returning nothing for a required config
// entity is the evidence itself; search_code corroborates by showing the
// code path that reads the (absent) config key — satisfies "evidence via
// at least two different tool types."
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

describe("demo scenario: missing config", () => {
  test("reaches CONFIRMED using query_brain (absence) plus search_code (corroboration)", async () => {
    await seedRealCodeFileEntity();
    let hypothesisId: string | undefined;

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
              input: { statement: "Required config key is missing at startup" },
            },
          ],
        };
      }
      if (callIndex === 2) {
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
      if (callIndex <= 7) {
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
                description: `supporting evidence ${callIndex}`,
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Service fails to start with an unresolved config reference.",
      { client },
    );

    expect(result.outcome).toBe("CONFIRMED");
  });
});
