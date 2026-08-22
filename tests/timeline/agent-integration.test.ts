// End-to-end test: a real investigate() run (mocked Anthropic client, real
// tool handlers per tests/agent/helpers/mockAnthropicClient.ts's design
// note) piped through buildTimeline, asserting the FR-21 fields are
// actually populated for a real investigation — the spec's literal "every
// evidence field ... is present and non-empty for a real investigation
// run" test case, not just synthetic-data unit testing (see
// tests/timeline/build.test.ts for that half).
import { afterEach, describe, expect, test } from "bun:test";
import { investigate } from "../../src/agent/investigate";
import { buildTimeline } from "../../src/timeline";
import { createStepFunctionClient, extractHypothesisId } from "../agent/helpers/mockAnthropicClient";
import { seedRealCodeFileEntity, seedSchedulerDisabledScenario } from "../agent/fixtures/seedBrain";
import { truncateAll } from "../db-helpers";

// Same isolation pattern every other Brain-writing test file uses (see
// tests/agent/scenarios/scheduler-disabled.test.ts) — required so this
// scenario's seeded Runtime-domain entities don't leak into other test
// files' domain-scoped assertions.
afterEach(async () => {
  await truncateAll();
});

// Every evidence tool's real result text is prefixed `STEP_ID: <id>\n` by
// withStepId() in src/agent/tools.ts — confirmed by reading that file
// directly (not just this brief's paraphrase) before writing this parser.
// `matches.at(-1)` picks the most recently emitted STEP_ID out of the full
// message-history body text Tool Runner resends each call; callers here
// only read it once (into a variable that's set at most once), so a later
// call's STEP_ID never overwrites the one already captured.
function extractStepId(bodyText: string): string | undefined {
  const matches = [...bodyText.matchAll(/STEP_ID: ([0-9a-f-]{36})/g)];
  return matches.at(-1)?.[1];
}

describe("timeline built from a real investigation run", () => {
  test("FR-21 fields are populated on toolCalls and survive buildTimeline", async () => {
    const { task } = await seedSchedulerDisabledScenario();
    await seedRealCodeFileEntity();

    let hypothesisId: string | undefined;
    let queryBrainStepId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);
      if (!queryBrainStepId) {
        const found = extractStepId(bodyText);
        if (found) queryBrainStepId = found;
      }

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
                reason: "checking whether the scheduler transition is reachable from this task",
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
                stepId: queryBrainStepId,
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
              input: {
                pathContains: "package.json",
                reason: "inspecting the scheduler's dependency configuration",
              },
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
    expect(result.toolCalls.length).toBeGreaterThan(0);

    for (const call of result.toolCalls) {
      expect(call.why.length).toBeGreaterThan(0);
      expect(call.result).not.toBeNull();
    }

    const queryBrainCall = result.toolCalls.find((c) => c.id === queryBrainStepId);
    expect(queryBrainCall).toBeDefined();
    expect(queryBrainCall?.hypothesisId).not.toBeNull();
    expect(queryBrainCall?.supports).not.toBeNull();
    expect(queryBrainCall?.meaning).not.toBeNull();

    const timeline = buildTimeline(result.toolCalls);
    expect(timeline.steps).toHaveLength(result.toolCalls.length);

    const timelineStep = timeline.steps.find((s) => s.id === queryBrainStepId);
    expect(timelineStep).toBeDefined();
    expect(timelineStep?.why).toBe(queryBrainCall?.why);
    expect(timelineStep?.result).toEqual(queryBrainCall?.result);
    expect(timelineStep?.meaning).toBe(queryBrainCall?.meaning);
    expect(timelineStep?.hypothesisId).toBe(queryBrainCall?.hypothesisId);
  });
});
