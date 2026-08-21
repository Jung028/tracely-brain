// Builds an Anthropic client whose `fetch` is replaced with a queue-backed
// fake — the same injection point client.ts uses for GitHub tests
// (`fetchImpl`), applied to the Anthropic SDK's own documented `fetch`
// client option. Tool Runner's real loop logic runs unmodified; only the
// network call is faked, so our real tool handlers (Task 4) execute for
// real against whatever seeded Brain/mocked GitHub state a test sets up.
// See design doc Testing section for why this replaces live API calls.
import Anthropic from "@anthropic-ai/sdk";

type BetaContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ScriptedTurn {
  content: BetaContentBlock[];
  stop_reason: "tool_use" | "end_turn";
}

/**
 * Returns an Anthropic client that responds to each successive
 * POST /v1/messages call with the next entry in `turns`, in order. Throws
 * if more calls happen than turns were scripted — a test that runs past
 * its script has a bug in the script, not a real infinite loop.
 */
export function createScriptedAnthropicClient(turns: ScriptedTurn[]): Anthropic {
  let callIndex = 0;

  const fetchImpl = (async () => {
    if (callIndex >= turns.length) {
      throw new Error(
        `mock Anthropic client received more calls (${callIndex + 1}) than scripted turns (${turns.length})`,
      );
    }
    const turn = turns[callIndex];
    callIndex++;

    const body = {
      id: `msg_test_${callIndex}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: turn.content,
      stop_reason: turn.stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
}

/**
 * Dynamic scripted client for the CONFIRMED-path test: the real hypothesis
 * id is only known after `propose_hypothesis` actually runs, and Tool
 * Runner sends the full message history (including the previous turn's
 * tool_result text) back on every subsequent call — so this reads the id
 * out of the request body instead of requiring it pre-scripted.
 */
export function createDynamicScriptedClient(remainingSupportingCalls = 5): Anthropic {
  let callIndex = 0;
  let hypothesisId: string | undefined;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    callIndex++;

    // Turn 1: always propose the hypothesis.
    if (callIndex === 1) {
      return jsonResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_propose",
            name: "propose_hypothesis",
            input: { statement: "Scheduler is disabled" },
          },
        ],
        stop_reason: "tool_use",
      });
    }

    // Every later turn: pull the hypothesis id out of the most recent
    // tool_result in the request body (Tool Runner sends the full
    // message history on each call), which contains the real id in its
    // text — e.g. "created hypothesis <uuid>: ...".
    if (!hypothesisId) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const match = /created hypothesis ([0-9a-f-]{36})/.exec(bodyText);
      if (match) hypothesisId = match[1];
    }

    if (callIndex <= 1 + remainingSupportingCalls) {
      return jsonResponse({
        content: [
          {
            type: "tool_use",
            id: `toolu_evidence_${callIndex}`,
            name: "update_hypothesis",
            input: {
              hypothesisId,
              direction: "supporting",
              description: `evidence ${callIndex}`,
              toolSource: "query_brain",
            },
          },
        ],
        stop_reason: "tool_use",
      });
    }

    return jsonResponse({
      content: [{ type: "text", text: "Investigation complete." }],
      stop_reason: "end_turn",
    });
  }) as unknown as typeof fetch;

  function jsonResponse(partial: { content: BetaContentBlock[]; stop_reason: string }) {
    return new Response(
      JSON.stringify({
        id: `msg_test_${callIndex}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        ...partial,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
}

/**
 * Generalized step-function client for scenario tests (Task 7) that need
 * to script real evidence-tool calls (query_brain, search_code) — not just
 * the two control tools — to satisfy the spec's "gathers evidence via at
 * least two different tool types" requirement. `step` receives the 1-based
 * call index and the raw previous-request body text (to regex out ids
 * discovered from earlier tool results, same technique as
 * createDynamicScriptedClient above) and returns the next turn.
 */
export function createStepFunctionClient(
  step: (callIndex: number, bodyText: string) => { content: BetaContentBlock[]; stop_reason: string },
): Anthropic {
  let callIndex = 0;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    callIndex++;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const turn = step(callIndex, bodyText);

    return new Response(
      JSON.stringify({
        id: `msg_test_${callIndex}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        ...turn,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
}

/** Regexes the hypothesis id out of a `created hypothesis <uuid>: ...` tool result in raw request body text — shared by scenario tests in Task 7. */
export function extractHypothesisId(bodyText: string, exclude?: string): string | undefined {
  const matches = [...bodyText.matchAll(/created hypothesis ([0-9a-f-]{36})/g)];
  const ids = matches.map((m) => m[1]).filter((id) => id !== exclude);
  return ids.at(-1);
}
