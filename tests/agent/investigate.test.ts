import { describe, expect, test } from "bun:test";
import { investigate } from "../../src/agent/investigate";
import {
  createDynamicScriptedClient,
  createScriptedAnthropicClient,
} from "./helpers/mockAnthropicClient";

describe("investigate", () => {
  test("CONFIRMED path: scripted turns propose a hypothesis, add enough supporting evidence, and end_turn", async () => {
    const client = createDynamicScriptedClient(5);
    const result = await investigate("Task stuck in WAIT_JUDGE", { client });
    expect(result.outcome).toBe("CONFIRMED");
  });

  test("INSUFFICIENT_EVIDENCE path: model ends the turn with no confirmed hypothesis", async () => {
    const client = createScriptedAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "propose_hypothesis",
            input: { statement: "Scheduler is disabled" },
          },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "No further evidence available; cannot confirm." },
        ],
      },
    ]);

    const result = await investigate("Task stuck in WAIT_JUDGE", { client });

    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  test("FR-18: a single turn with multiple tool_use blocks executes all of them (parallel tool execution)", async () => {
    let callIndex = 0;
    const fetchImpl = (async () => {
      callIndex++;
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            id: "msg_test_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "toolu_a",
                name: "propose_hypothesis",
                input: { statement: "Hypothesis A" },
              },
              {
                type: "tool_use",
                id: "toolu_b",
                name: "propose_hypothesis",
                input: { statement: "Hypothesis B" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "msg_test_2",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
    const result = await investigate("test problem", { client });

    // Both tool_use blocks from the single turn must have executed — proves
    // multiple tool calls in one assistant turn are both honored, not just
    // the first. state isn't directly exposed on InvestigationResult, so
    // assert indirectly via hypothesesConsidered on the INSUFFICIENT_EVIDENCE
    // path (neither hypothesis gets evidence, so this is the expected
    // outcome here).
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    if (result.outcome !== "INSUFFICIENT_EVIDENCE") throw new Error("unreachable");
    expect(result.hypothesesConsidered).toHaveLength(2);
    expect(result.hypothesesConsidered.map((h) => h.statement).sort()).toEqual([
      "Hypothesis A",
      "Hypothesis B",
    ]);
  });
});
