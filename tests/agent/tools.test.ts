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
    });

    expect(() => JSON.parse(result as string)).not.toThrow();
  });

  test("traverse mode without startEntityId returns a guidance string instead of throwing", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_brain");

    const result = await tool.run({ mode: "traverse", maxDepth: 2 });

    expect(result).toContain("requires startEntityId");
  });
});

describe("queryDatabase / searchLogs stubs", () => {
  test("queryDatabase returns a NOT_IMPLEMENTED marker, not fabricated data", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_database");

    const result = await tool.run({ query: "SELECT 1" });

    expect(result).toContain("NOT_IMPLEMENTED");
  });

  test("searchLogs returns a NOT_IMPLEMENTED marker, not fabricated data", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "search_logs");

    const result = await tool.run({ query: "error" });

    expect(result).toContain("NOT_IMPLEMENTED");
  });
});

describe("stepNumber tracking", () => {
  test("starts at 0 and increments by exactly 1 per tool call, across different tools", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const propose = getTool(tools, "propose_hypothesis");
    const queryDatabase = getTool(tools, "query_database");

    expect(state.stepNumber).toBe(0);

    await propose.run({ statement: "Scheduler is disabled" });
    expect(state.stepNumber).toBe(1);

    await queryDatabase.run({ query: "SELECT 1" });
    expect(state.stepNumber).toBe(2);

    const hypothesisId = state.hypotheses[0].id;
    const update = getTool(tools, "update_hypothesis");
    await update.run({
      hypothesisId,
      direction: "supporting",
      description: "n/a",
      toolSource: "query_database",
    });
    expect(state.stepNumber).toBe(3);
  });
});
