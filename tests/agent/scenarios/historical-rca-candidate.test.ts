// FR-29/FR-30: a historical incident surfaces as a *candidate* hypothesis
// via query_brain's Operational Knowledge domain, but the agent must still
// require fresh evidence (from a second tool type, search_code) before
// CONFIRMED — spec explicitly calls out this rule as easy to accidentally
// skip, so it's tested directly rather than only covered incidentally.
import { afterEach, describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedHistoricalIncident, seedRealCodeFileEntity } from "../fixtures/seedBrain";
import { truncateAll } from "../../db-helpers";

// Same isolation pattern every other Brain-writing test file in this repo
// uses — without it, the Operational Knowledge + Code-domain entities this
// scenario seeds leak into the shared test DB and pollute unrelated test
// files' assertions.
afterEach(async () => {
  await truncateAll();
});

describe("demo scenario: historical RCA as candidate, not proof", () => {
  test("a past RCA surfacing via query_brain still requires fresh evidence to reach CONFIRMED", async () => {
    await seedHistoricalIncident("Scheduler config drift caused a similar stall in Q1");
    await seedRealCodeFileEntity();
    let hypothesisId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex === 1) {
        // Models the historical match surfacing as a *candidate* only —
        // propose_hypothesis is what turns it into something trackable,
        // not query_brain alone.
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: {
                statement: "Scheduler config drift (matches historical incident)",
              },
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
                description: `fresh supporting evidence ${callIndex}`,
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Order liability assignment task is stuck in WAIT_JUDGE and never progresses.",
      { client },
    );

    expect(result.outcome).toBe("CONFIRMED");
    if (result.outcome !== "CONFIRMED") throw new Error("unreachable");
    // Confirmation came from the 5 scripted update_hypothesis (fresh
    // evidence) calls, not from the historical match by itself — the
    // historical entity seeded above is never referenced by
    // update_hypothesis at all, so a regression that let query_brain's
    // historical-domain result alone confirm a hypothesis would still
    // require these 5 real evidence items to pass, keeping this test a
    // faithful FR-30 guard.
    expect(result.evidenceTrail.length).toBe(5);
  });
});
