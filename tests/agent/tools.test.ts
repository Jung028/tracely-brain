// Exercises the tool handlers directly (calling betaZodTool's underlying
// `run` function), not through the Anthropic API — these are unit tests of
// our own logic, independent of Task 5's LLM-loop wiring.
import { describe, expect, test } from "bun:test";
import { createInvestigationState, createTools } from "../../src/agent/tools";

function getTool(tools: ReturnType<typeof createTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe("proposeHypothesis tool", () => {
  test("adds a new hypothesis to investigation state and returns its id", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "propose_hypothesis");

    const result = await tool.run({ statement: "Scheduler is disabled" });

    expect(state.hypotheses).toHaveLength(1);
    expect(state.hypotheses[0].statement).toBe("Scheduler is disabled");
    expect(typeof result).toBe("string");
    expect(result as string).toContain(state.hypotheses[0].id);
  });
});

describe("updateHypothesis tool", () => {
  test("supporting evidence raises confidence on the named hypothesis", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const propose = getTool(tools, "propose_hypothesis");
    const update = getTool(tools, "update_hypothesis");

    await propose.run({ statement: "Scheduler is disabled" });
    const hypothesisId = state.hypotheses[0].id;

    await update.run({
      hypothesisId,
      direction: "supporting",
      description: "Task stuck in WAIT_JUDGE",
      toolSource: "queryBrain",
    });

    expect(state.hypotheses[0].supportingEvidence).toHaveLength(1);
    expect(state.hypotheses[0].confidence).toBeGreaterThan(0);
  });

  test("unknown hypothesisId returns an error string instead of throwing", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const update = getTool(tools, "update_hypothesis");

    const result = await update.run({
      hypothesisId: "does-not-exist",
      direction: "supporting",
      description: "n/a",
      toolSource: "queryBrain",
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("not found");
  });
});

describe("queryBrain tool", () => {
  test("search mode calls findEntities and returns JSON-serializable results (no throw on an empty Brain)", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_brain");

    const result = await tool.run({
      mode: "search",
      domain: "Operational Knowledge",
      entityType: undefined,
      maxDepth: 2,
      reason: "checking for historical incidents in this domain",
    });

    // Result is prefixed `STEP_ID: <id>\n` (see tools.ts's withStepId) so
    // update_hypothesis can later cite this exact call — strip that line
    // before parsing the JSON body it precedes.
    expect(result as string).toMatch(/^STEP_ID: [^\n]+\n/);
    const jsonBody = (result as string).replace(/^STEP_ID: [^\n]+\n/, "");
    expect(() => JSON.parse(jsonBody)).not.toThrow();
  });

  test("traverse mode without startEntityId returns a guidance string instead of throwing", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_brain");

    const result = await tool.run({
      mode: "traverse",
      maxDepth: 2,
      reason: "walking relationships from a known entity",
    });

    expect(result).toContain("requires startEntityId");
  });
});

describe("queryDatabase / searchLogs stubs", () => {
  test("queryDatabase returns a NOT_IMPLEMENTED marker, not fabricated data", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_database");

    const result = await tool.run({ query: "SELECT 1", reason: "checking a suspicious row count" });

    expect(result).toContain("NOT_IMPLEMENTED");
  });

  test("searchLogs returns a NOT_IMPLEMENTED marker, not fabricated data", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "search_logs");

    const result = await tool.run({ query: "error", reason: "looking for related error logs" });

    expect(result).toContain("NOT_IMPLEMENTED");
  });
});

describe("concurrencyGroup batching", () => {
  test("two evidence-tool calls dispatched together (same synchronous burst) share a concurrencyGroup, and a later call gets a new one", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const queryBrainTool = getTool(tools, "query_brain");
    const searchCodeTool = getTool(tools, "search_code");
    const queryDatabaseTool = getTool(tools, "query_database");

    // Both .run() calls are made inside the same array literal, so both
    // start executing synchronously, back to back, before either can
    // suspend past its first `await` — the same dispatch pattern
    // BetaToolRunner uses for same-turn tool_use blocks
    // (Promise.all(toolUseBlocks.map(...)), see tools.ts's comment on
    // beginToolCall). This is what should land them in the same batch.
    const [brainResult, codeResult] = await Promise.all([
      queryBrainTool.run({
        mode: "search",
        domain: "Operational Knowledge",
        entityType: undefined,
        maxDepth: 2,
        reason: "parallel call 1",
      }),
      searchCodeTool.run({
        pathContains: "this-path-should-not-exist-anywhere",
        reason: "parallel call 2",
      }),
    ]);

    const stepIdOf = (result: unknown) => /^STEP_ID: ([^\n]+)\n/.exec(result as string)?.[1];
    const brainStepId = stepIdOf(brainResult);
    const codeStepId = stepIdOf(codeResult);
    expect(brainStepId).toBeTruthy();
    expect(codeStepId).toBeTruthy();

    const brainRecord = state.toolCalls.find((c) => c.id === brainStepId);
    const codeRecord = state.toolCalls.find((c) => c.id === codeStepId);
    expect(brainRecord).toBeDefined();
    expect(codeRecord).toBeDefined();
    expect(brainRecord?.concurrencyGroup).toBe(codeRecord?.concurrencyGroup);

    // A call made afterward — only once the parallel pair has fully
    // resolved — is a genuinely later turn and must land in a different
    // group, proving this isn't just a single group for the whole test.
    const dbResult = await queryDatabaseTool.run({
      query: "SELECT 1",
      reason: "sequential call after the parallel pair",
    });
    const dbStepId = stepIdOf(dbResult);
    const dbRecord = state.toolCalls.find((c) => c.id === dbStepId);
    expect(dbRecord).toBeDefined();
    expect(dbRecord?.concurrencyGroup).not.toBe(brainRecord?.concurrencyGroup);
  });
});
