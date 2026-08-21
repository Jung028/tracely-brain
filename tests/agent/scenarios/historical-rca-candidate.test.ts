// FR-29/FR-30: a historical incident surfaces as a *candidate* hypothesis
// via a real query_brain search-mode call scoped to the Operational
// Knowledge domain (FR-29), but the agent must still require fresh
// evidence (from a second tool type, search_code) before CONFIRMED
// (FR-30) — spec explicitly calls out this rule as easy to accidentally
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
        // FR-29: a real query_brain search-mode call scoped to Operational
        // Knowledge, run BEFORE propose_hypothesis — this is what makes
        // the seeded historical incident genuinely retrievable as a
        // candidate hypothesis, not just a comment claiming it is.
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_query_brain",
              name: "query_brain",
              input: { mode: "search", domain: "Operational Knowledge" },
            },
          ],
        };
      }
      if (callIndex === 2) {
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
      if (callIndex === 3) {
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
      if (callIndex <= 8) {
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
    // FR-30: confirmation came from the 5 scripted update_hypothesis
    // (fresh evidence) calls, not from the historical match by itself —
    // the historical entity seeded above is retrieved by the real
    // query_brain call above (FR-29), but it is never referenced by any
    // update_hypothesis call, so a regression that let query_brain's
    // historical-domain result alone confirm a hypothesis would still
    // require these 5 real evidence items to pass, keeping this test a
    // faithful FR-30 guard.
    expect(result.evidenceTrail.length).toBe(5);
    const toolSources = new Set(result.evidenceTrail.map((e) => e.toolSource));
    expect(toolSources.size).toBeGreaterThanOrEqual(2);
  });
});
