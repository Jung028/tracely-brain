// Every tool the LLM can call. The four evidence tools (queryBrain,
// searchCode, queryDatabase, searchLogs) are read-only and never touch
// hypothesis state. The two control tools (propose_hypothesis,
// update_hypothesis) are the *only* way the model can affect
// InvestigationState — their handlers call straight into hypotheses.ts,
// which enforces the actual transition rules. See design doc "The LLM
// reasons; our code enforces the rules."
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { Domain, findEntities, RelationshipType, traverse } from "../brain";
import { getFileContent } from "../integrations/github";
import {
  addContradictingEvidence,
  addSupportingEvidence,
  proposeHypothesis as proposeHypothesisFn,
} from "./hypotheses";
import type { Evidence, Hypothesis, ToolCallRecord } from "./types";

export interface InvestigationState {
  hypotheses: Hypothesis[];
  toolCalls: ToolCallRecord[];
  // Groups same-turn parallel evidence-tool calls under one concurrencyGroup
  // value. The Tool Runner's `run(input, context)` handler (see
  // node_modules/@anthropic-ai/sdk/lib/tools/BetaRunnableTool.d.ts) exposes
  // no shared per-turn identifier — only `toolUse` (per-call id) and an
  // abort `signal` — so there's no real turn-boundary signal to read.
  // Instead this exploits how BetaToolRunner actually dispatches same-turn
  // tool_use blocks (see node_modules/@anthropic-ai/sdk/src/lib/tools/
  // BetaToolRunner.ts ~line 493: `Promise.all(toolUseBlocks.map(async
  // (toolUse) => { ... }))`): every call's `run()` body starts executing
  // synchronously, back to back, before any of them can complete — so a
  // "batch is open" flag that's only cleared on the next microtask tick
  // (via queueMicrotask) reliably spans exactly one synchronous dispatch
  // burst, i.e. one turn's worth of same-turn calls. See beginToolCall
  // below for the actual grouping logic.
  batchCounter: number;
  batchOpen: boolean;
}

export function createInvestigationState(): InvestigationState {
  return { hypotheses: [], toolCalls: [], batchCounter: 0, batchOpen: false };
}

interface ToolCallHandle {
  readonly id: string;
  readonly concurrencyGroup: string;
}

// Must be called synchronously, at the very top of an evidence tool's
// `run()` handler, BEFORE any `await` in that handler. See the comment on
// InvestigationState.batchOpen for why the timing matters: BetaToolRunner
// dispatches every same-turn tool_use block's run() synchronously via
// `Promise.all(toolUseBlocks.map(...))`, back to back, before any of them
// can suspend past their first await. Deciding the batch/id here — in that
// synchronous window — is what makes concurrencyGroup track real same-turn
// concurrency; deciding it after an internal await (e.g. after `await
// findEntities(...)`) would instead group calls by unrelated completion
// timing, which is exactly the bug this function fixes.
//
// The first call in a synchronous dispatch burst finds `batchOpen ===
// false`, increments `batchCounter`, opens the batch, and schedules a
// microtask to close it again — that scheduling happens only on this
// transition, not on every call, so it doesn't re-close the batch early
// relative to later synchronous calls in the same burst. Every subsequent
// call that runs before that microtask fires (i.e. every other same-turn
// call) finds `batchOpen === true` and reuses the current `batchCounter`
// value. A call from a genuinely later turn runs after that microtask has
// fired, finds `batchOpen === false` again, and starts a new group.
function beginToolCall(state: InvestigationState): ToolCallHandle {
  if (!state.batchOpen) {
    state.batchCounter += 1;
    state.batchOpen = true;
    queueMicrotask(() => {
      state.batchOpen = false;
    });
  }
  return { id: crypto.randomUUID(), concurrencyGroup: `batch-${state.batchCounter}` };
}

// Pushes the ToolCallRecord for one of the four evidence tools, using the
// id/concurrencyGroup a prior `beginToolCall` call (made synchronously,
// before this tool's internal awaits) already decided. `result` is stored
// as the real computed value (not a string) so update_hypothesis can later
// attach it verbatim to Evidence.raw — see design note in tools.ts header
// and docs/DATA-MODEL.md "Reading the two halves together".
function finishToolCall(
  state: InvestigationState,
  handle: ToolCallHandle,
  toolName: string,
  input: { reason: string } & Record<string, unknown>,
  result: unknown,
): void {
  state.toolCalls.push({
    id: handle.id,
    toolName,
    input,
    why: input.reason,
    result,
    timestamp: new Date(),
    concurrencyGroup: handle.concurrencyGroup,
    hypothesisId: null,
    supports: null,
    meaning: null,
  });
}

// Every evidence tool's return value (the text the model actually sees) is
// prefixed `STEP_ID: <id>\n` ahead of its normal content, so the model can
// parse the id back out and cite it in a later update_hypothesis call's
// optional `stepId` param. This is the one place that convention is
// defined — anything parsing a tool result for its step id (this codebase
// or a later module) must match this exact format.
function withStepId(id: string, body: string): string {
  return `STEP_ID: ${id}\n${body}`;
}

function findHypothesis(
  state: InvestigationState,
  hypothesisId: string,
): Hypothesis | undefined {
  return state.hypotheses.find((h) => h.id === hypothesisId);
}

function replaceHypothesis(state: InvestigationState, updated: Hypothesis): void {
  const idx = state.hypotheses.findIndex((h) => h.id === updated.id);
  if (idx !== -1) {
    state.hypotheses[idx] = updated;
  }
}

export function createTools(state: InvestigationState): BetaRunnableTool<unknown>[] {
  const queryBrain = betaZodTool({
    name: "query_brain",
    description:
      "Query the Company Brain. Two modes: 'search' (find entities by domain/type — use this " +
      "first, when you don't yet know a specific entity id; this is how an investigation " +
      "bootstraps from a problem description into the Brain at all) and 'traverse' (walk " +
      "relationships outward from a known entity id, once search has found one). Set domain " +
      "to 'Operational Knowledge' in search mode to retrieve candidate historical " +
      "incidents/RCAs (FR-29) — these are candidates only, still require fresh evidence " +
      "before confirming (FR-30).",
    inputSchema: z.object({
      mode: z.enum(["search", "traverse"]),
      // search mode:
      domain: z.enum(Domain).optional().describe("Brain domain to search within, search mode only"),
      entityType: z.string().optional().describe("Entity type to search within, search mode only"),
      // traverse mode:
      startEntityId: z.string().optional().describe("Entity id to traverse from, traverse mode only"),
      relationshipTypes: z.array(z.enum(RelationshipType)).optional(),
      maxDepth: z.number().int().min(1).max(5).default(2),
      reason: z
        .string()
        .describe(
          "Why you're making this call right now, in relation to the current investigation or hypothesis.",
        ),
    }),
    run: async (input) => {
      // Must happen before any `await` below — see beginToolCall's comment.
      const call = beginToolCall(state);

      if (input.mode === "search") {
        const entities = await findEntities({
          domain: input.domain,
          entityType: input.entityType,
        });
        finishToolCall(state, call, "query_brain", input, entities);
        return withStepId(call.id, JSON.stringify(entities));
      }

      if (!input.startEntityId) {
        const guidance = "traverse mode requires startEntityId — run a search first to find one";
        finishToolCall(state, call, "query_brain", input, guidance);
        return withStepId(call.id, guidance);
      }
      const result = await traverse({
        startEntityId: input.startEntityId,
        relationshipTypes: input.relationshipTypes,
        maxDepth: input.maxDepth,
      });
      finishToolCall(state, call, "query_brain", input, result);
      return withStepId(call.id, JSON.stringify(result));
    },
  });

  const searchCode = betaZodTool({
    name: "search_code",
    description:
      "Search synced GitHub file paths for a substring match, then read the matching file's " +
      "content. Use this to inspect actual source code relevant to a hypothesis.",
    inputSchema: z.object({
      pathContains: z.string().describe("Substring to match against file paths"),
      reason: z
        .string()
        .describe(
          "Why you're making this call right now, in relation to the current investigation or hypothesis.",
        ),
    }),
    run: async (input) => {
      // Must happen before any `await` below — see beginToolCall's comment.
      const call = beginToolCall(state);

      const files = await findEntities({ domain: "Code", entityType: "File" });
      const matches = files.filter((f) => f.name.includes(input.pathContains));
      if (matches.length === 0) {
        const guidance = `no synced files match "${input.pathContains}"`;
        finishToolCall(state, call, "search_code", input, guidance);
        return withStepId(call.id, guidance);
      }

      const results: string[] = [];
      for (const file of matches.slice(0, 5)) {
        // sourceRef format: "github:{owner}/{repo}:{path}" (see
        // integrations/github/sync.ts) — parse rather than assume a single
        // configured repo, since multiple repos may be synced.
        const match = /^github:([^/]+)\/([^:]+):/.exec(file.sourceRef);
        if (!match) continue;
        const [, owner, repo] = match;
        const sha = (file.attributes as { sha?: string }).sha;
        if (!sha) continue;

        const content = await getFileContent(owner, repo, sha);
        if ("ok" in content && content.ok) {
          results.push(`--- ${file.name} ---\n${content.data.content}`);
        } else {
          results.push(`--- ${file.name} --- (read failed: ${JSON.stringify(content)})`);
        }
      }
      finishToolCall(state, call, "search_code", input, results);
      return withStepId(call.id, results.join("\n\n"));
    },
  });

  // Stubbed per Scope Decision #2 in the design doc: real PostgreSQL/Datadog
  // integrations don't exist yet (Module 02 was closed at GitHub-only
  // scope). These return a typed NOT_IMPLEMENTED marker rather than
  // fabricating data — the agent must treat this the same as "source
  // unavailable," never as "source returned nothing meaningful."
  const queryDatabase = betaZodTool({
    name: "query_database",
    description:
      "Execute a read-only PostgreSQL query. NOT YET IMPLEMENTED — always returns a " +
      "NOT_IMPLEMENTED marker; treat this the same as an unavailable source, not as an " +
      "empty result.",
    inputSchema: z.object({
      query: z.string(),
      reason: z
        .string()
        .describe(
          "Why you're making this call right now, in relation to the current investigation or hypothesis.",
        ),
    }),
    run: async (input) => {
      const call = beginToolCall(state);
      const result = { status: "NOT_IMPLEMENTED", tool: "query_database" };
      finishToolCall(state, call, "query_database", input, result);
      return withStepId(call.id, JSON.stringify(result));
    },
  });

  const searchLogs = betaZodTool({
    name: "search_logs",
    description:
      "Search Datadog logs. NOT YET IMPLEMENTED — always returns a NOT_IMPLEMENTED marker; " +
      "treat this the same as an unavailable source, not as an empty result.",
    inputSchema: z.object({
      query: z.string(),
      reason: z
        .string()
        .describe(
          "Why you're making this call right now, in relation to the current investigation or hypothesis.",
        ),
    }),
    run: async (input) => {
      const call = beginToolCall(state);
      const result = { status: "NOT_IMPLEMENTED", tool: "search_logs" };
      finishToolCall(state, call, "search_logs", input, result);
      return withStepId(call.id, JSON.stringify(result));
    },
  });

  const proposeHypothesisTool = betaZodTool({
    name: "propose_hypothesis",
    description:
      "Propose a new named hypothesis for what caused the problem under investigation. " +
      "Returns the hypothesis id — use it with update_hypothesis to attach evidence.",
    inputSchema: z.object({
      statement: z.string().describe("A specific, falsifiable statement of the hypothesis"),
    }),
    run: async (input) => {
      const hypothesis = proposeHypothesisFn(input.statement);
      state.hypotheses.push(hypothesis);
      return `created hypothesis ${hypothesis.id}: ${hypothesis.statement}`;
    },
  });

  const updateHypothesisTool = betaZodTool({
    name: "update_hypothesis",
    description:
      "Attach a piece of evidence to an existing hypothesis, as either supporting or " +
      "contradicting. The hypothesis's status and confidence are recomputed by our own " +
      "code from accumulated evidence — you do not set status or confidence directly, and " +
      "you cannot mark evidence as 'decisive' yourself. Pass stepId to cite the exact prior " +
      "query_brain / search_code / query_database / search_logs call this evidence came from " +
      "— this attaches that call's real result to the evidence record instead of leaving it " +
      "empty. Each of those tools' results starts with a line like 'STEP_ID: <id>'; use that " +
      "id here.",
    inputSchema: z.object({
      hypothesisId: z.string(),
      direction: z.enum(["supporting", "contradicting"]),
      description: z.string(),
      toolSource: z.string().describe("Which tool produced this evidence, e.g. query_brain"),
      stepId: z
        .string()
        .optional()
        .describe("Id of the prior evidence-tool call this evidence cites, if any"),
    }),
    run: async (input) => {
      const hypothesis = findHypothesis(state, input.hypothesisId);
      if (!hypothesis) {
        return `hypothesis not found: ${input.hypothesisId}`;
      }

      const citedStepIdx = input.stepId
        ? state.toolCalls.findIndex((call) => call.id === input.stepId)
        : -1;
      const citedStep = citedStepIdx === -1 ? undefined : state.toolCalls[citedStepIdx];

      if (citedStep) {
        state.toolCalls[citedStepIdx] = {
          ...citedStep,
          hypothesisId: input.hypothesisId,
          supports: input.direction,
          meaning: input.description,
        };
      }

      const evidence: Evidence = {
        id: crypto.randomUUID(),
        toolSource: input.toolSource,
        description: input.description,
        timestamp: new Date(),
        raw: citedStep ? citedStep.result : null,
      };

      const updated =
        input.direction === "supporting"
          ? addSupportingEvidence(hypothesis, evidence)
          : addContradictingEvidence(hypothesis, evidence);

      replaceHypothesis(state, updated);
      return `hypothesis ${updated.id} is now ${updated.status} (confidence ${updated.confidence.toFixed(2)})`;
    },
  });

  // Each tool above is a `BetaRunnableTool<Specific>` for its own Zod input
  // schema. Widening the array's element type to `BetaRunnableTool<unknown>`
  // (per the module boundary in the plan) requires an explicit cast here:
  // TS's strictFunctionTypes makes `run`'s parameter contravariant, so a
  // handler that only accepts its own narrow input type is not structurally
  // assignable to "accepts unknown" without an assertion, even though the
  // Tool Runner is the only caller and always supplies exactly the schema
  // each tool declared.
  return [
    queryBrain,
    searchCode,
    queryDatabase,
    searchLogs,
    proposeHypothesisTool,
    updateHypothesisTool,
  ].map((tool) => tool as BetaRunnableTool<unknown>);
}
