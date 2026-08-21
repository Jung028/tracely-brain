// Demo scenario 1/3 (spec's "three demo scenarios" — authored fresh, no
// source material existed; see design doc Scope Decision #3). Seeds a
// scheduler entity + a task stuck in WAIT_JUDGE plus a real code file,
// scripts turns that call query_brain AND search_code (spec requires
// "evidence via at least two different tool types") before confirming.
import { afterEach, describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedRealCodeFileEntity, seedSchedulerDisabledScenario } from "../fixtures/seedBrain";
import { truncateAll } from "../../db-helpers";

// Same isolation pattern every other Brain-writing test file in this repo
// uses (tests/query.test.ts, tests/entities.test.ts, etc.) — without it,
// the Runtime-domain entities this scenario seeds leak into the shared test
// DB and pollute unrelated test files' domain-scoped assertions.
afterEach(async () => {
  await truncateAll();
});

describe("demo scenario: scheduler disabled", () => {
  test("reaches CONFIRMED using evidence from at least two different tool types", async () => {
    const { task } = await seedSchedulerDisabledScenario();
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
              input: { statement: "Liability assignment scheduler is disabled" },
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
              id: "toolu_query_brain",
              name: "query_brain",
              input: {
                mode: "traverse",
                startEntityId: task.id,
                relationshipTypes: ["TRANSITIONS_TO"],
                maxDepth: 2,
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
              id: "toolu_evidence_1",
              name: "update_hypothesis",
              input: {
                hypothesisId,
                direction: "supporting",
                description: "Task stuck in WAIT_JUDGE, scheduler transition observed via Brain",
                toolSource: "query_brain",
              },
            },
          ],
        };
      }
      if (callIndex === 4) {
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
      "Order liability assignment task is stuck in WAIT_JUDGE and never progresses.",
      { client },
    );

    expect(result.outcome).toBe("CONFIRMED");
    if (result.outcome !== "CONFIRMED") throw new Error("unreachable");
    const toolSources = new Set(result.evidenceTrail.map((e) => e.toolSource));
    expect(toolSources.size).toBeGreaterThanOrEqual(2);
  });
});
