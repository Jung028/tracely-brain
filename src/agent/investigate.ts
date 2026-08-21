// FR-17's lifecycle entrypoint. Tool Runner drives the request/execute/loop
// cycle (see design doc "Architecture"); this file's job is composing the
// system prompt, tool set, and model, then interpreting the final
// InvestigationState into an InvestigationResult that never fabricates a
// conclusion (CLAUDE.md).
import Anthropic from "@anthropic-ai/sdk";
import { resolveModel } from "./model";
import { createInvestigationState, createTools } from "./tools";
import type { InvestigationResult } from "./types";

const SYSTEM_PROMPT = `You are investigating a production incident for Tracely.
Follow this lifecycle: understand the problem, retrieve Company Brain context via
query_brain, form named hypotheses via propose_hypothesis, gather evidence with
search_code / query_brain / query_database / search_logs, and attach that evidence to
a hypothesis via update_hypothesis as either supporting or contradicting.

You never set a hypothesis's status or confidence directly — update_hypothesis's result
tells you the current status after our system recomputes it from accumulated evidence.
If a hypothesis becomes REFUTED, propose a new hypothesis from the evidence already
gathered rather than abandoning the investigation.

If you cannot gather enough evidence to confirm a hypothesis, say so plainly and stop —
do not guess or state a root cause you have not confirmed via update_hypothesis.`;

export interface InvestigateOptions {
  /** Injectable for tests — see tests/agent/helpers/mockAnthropicClient.ts. */
  client?: Anthropic;
  maxIterations?: number;
}

export async function investigate(
  problemDescription: string,
  options: InvestigateOptions = {},
): Promise<InvestigationResult> {
  const client = options.client ?? new Anthropic();
  const model = resolveModel();
  const state = createInvestigationState();
  const tools = createTools(state);

  await client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    max_iterations: options.maxIterations ?? 20,
    system: SYSTEM_PROMPT,
    tools,
    messages: [{ role: "user", content: problemDescription }],
  });

  const confirmed = state.hypotheses.find((h) => h.status === "CONFIRMED");
  if (confirmed) {
    return {
      outcome: "CONFIRMED",
      hypothesis: confirmed,
      rca: confirmed.statement,
      evidenceTrail: [...confirmed.supportingEvidence],
    };
  }

  return {
    outcome: "INSUFFICIENT_EVIDENCE",
    hypothesesConsidered: state.hypotheses,
    reason:
      state.hypotheses.length === 0
        ? "no hypothesis was proposed"
        : "no hypothesis reached the confirmation threshold",
  };
}
