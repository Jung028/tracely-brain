// End-to-end proof of FR-28: getInvestigationState reflects hypotheses
// added mid-run, read from inside the mock client's own callback — which
// runs while investigate() is still suspended awaiting the "network" call,
// proving the state is observable before investigate() resolves, not only
// after.
import { describe, expect, test } from "bun:test";
import { investigate } from "../../src/agent/investigate";
import { getInvestigationState } from "../../src/session";
import { createStepFunctionClient, extractHypothesisId } from "../agent/helpers/mockAnthropicClient";

describe("live investigation state (FR-28)", () => {
  test("getInvestigationState reflects hypotheses added mid-run, and the session is gone after completion", async () => {
    const sessionId = crypto.randomUUID();
    let hypothesisId: string | undefined;
    let sawHypothesisMidRun = false;
    let sawStepNumberAdvance = false;
    let lastStepNumberSeen = -1;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex > 1) {
        const snapshot = getInvestigationState(sessionId);
        expect(snapshot).toBeDefined();
        if (snapshot!.hypotheses.length > 0) sawHypothesisMidRun = true;
        if (lastStepNumberSeen >= 0 && snapshot!.stepNumber > lastStepNumberSeen) sawStepNumberAdvance = true;
        lastStepNumberSeen = snapshot!.stepNumber;
      }

      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: { statement: "Scheduler is disabled" },
            },
          ],
        };
      }

      if (callIndex <= 3) {
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
                toolSource: "query_brain",
              },
            },
          ],
        };
      }

      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "stopping here" }],
      };
    });

    expect(getInvestigationState(sessionId)).toBeUndefined();

    const result = await investigate("Task stuck in WAIT_JUDGE", { client, sessionId });

    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(sawHypothesisMidRun).toBe(true);
    expect(sawStepNumberAdvance).toBe(true);
    expect(getInvestigationState(sessionId)).toBeUndefined();
  });

  test("a sessionId is unregistered even when the tool-runner call throws", async () => {
    const sessionId = crypto.randomUUID();
    const throwingClient = {
      beta: {
        messages: {
          toolRunner: () => {
            throw new Error("simulated failure");
          },
        },
      },
    } as unknown as NonNullable<Parameters<typeof investigate>[1]>["client"];

    await expect(
      investigate("test problem", { client: throwingClient, sessionId }),
    ).rejects.toThrow("simulated failure");

    expect(getInvestigationState(sessionId)).toBeUndefined();
  });

  test("investigate() without a sessionId behaves exactly as before — no registration, no error", async () => {
    const client = createStepFunctionClient(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
    }));

    const result = await investigate("test problem", { client });
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});
