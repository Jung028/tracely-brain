// Unit tests for buildTimeline (src/timeline/build.ts) against hand-built
// ToolCallRecord fixtures — pure-function testing, no DB/Anthropic client
// needed. See tests/timeline/agent-integration.test.ts for the
// real-investigation-run counterpart required by
// specs/04-evidence-timeline.md's test cases.
import { describe, expect, test } from "bun:test";
import { buildTimeline } from "../../src/timeline/build";
import type { ToolCallRecord } from "../../src/agent/types";

function makeRecord(overrides: Partial<ToolCallRecord> & { id: string }): ToolCallRecord {
  return {
    toolName: "query_brain",
    input: { mode: "search" },
    why: "default reason",
    result: { ok: true },
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    concurrencyGroup: "batch-1",
    hypothesisId: null,
    supports: null,
    meaning: null,
    ...overrides,
  };
}

describe("buildTimeline", () => {
  test("carries over every FR-21 field for a step cited by update_hypothesis", () => {
    const record = makeRecord({
      id: "step-1",
      toolName: "query_brain",
      input: { mode: "traverse", startEntityId: "e1" },
      why: "checking scheduler reachability",
      result: { entities: [{ id: "e1" }] },
      meaning: "Task stuck in WAIT_JUDGE, scheduler transition observed",
      hypothesisId: "hyp-1",
      supports: "supporting",
      timestamp: new Date("2026-01-01T00:00:01.000Z"),
      concurrencyGroup: "batch-1",
    });

    const timeline = buildTimeline([record]);

    expect(timeline.steps).toHaveLength(1);
    const [step] = timeline.steps;
    expect(step.id).toBe("step-1");
    expect(step.toolName).toBe("query_brain");
    expect(step.query).toEqual({ mode: "traverse", startEntityId: "e1" });
    expect(step.why).toBe("checking scheduler reachability");
    expect(step.result).toEqual({ entities: [{ id: "e1" }] });
    expect(step.meaning).toBe("Task stuck in WAIT_JUDGE, scheduler transition observed");
    expect(step.hypothesisId).toBe("hyp-1");
    expect(step.supports).toBe("supporting");
    expect(step.timestamp).toEqual(new Date("2026-01-01T00:00:01.000Z"));
    expect(step.concurrencyGroup).toBe("batch-1");
  });

  test("an exploratory step with null hypothesisId still appears, with null fields intact", () => {
    const record = makeRecord({
      id: "step-exploratory",
      hypothesisId: null,
      supports: null,
      meaning: null,
    });

    const timeline = buildTimeline([record]);

    expect(timeline.steps).toHaveLength(1);
    const [step] = timeline.steps;
    expect(step.id).toBe("step-exploratory");
    expect(step.hypothesisId).toBeNull();
    expect(step.supports).toBeNull();
    expect(step.meaning).toBeNull();
  });

  test("sorts steps by timestamp ascending regardless of input array order", () => {
    const third = makeRecord({ id: "third", timestamp: new Date("2026-01-01T00:00:03.000Z") });
    const first = makeRecord({ id: "first", timestamp: new Date("2026-01-01T00:00:01.000Z") });
    const second = makeRecord({ id: "second", timestamp: new Date("2026-01-01T00:00:02.000Z") });

    const timeline = buildTimeline([third, first, second]);

    expect(timeline.steps.map((s) => s.id)).toEqual(["first", "second", "third"]);
  });

  test("preserves concurrencyGroup for parallel steps interleaved with sequential ones", () => {
    const parallelA = makeRecord({
      id: "parallel-a",
      concurrencyGroup: "batch-2",
      timestamp: new Date("2026-01-01T00:00:02.000Z"),
    });
    const sequential = makeRecord({
      id: "sequential",
      concurrencyGroup: "batch-1",
      timestamp: new Date("2026-01-01T00:00:01.000Z"),
    });
    const parallelB = makeRecord({
      id: "parallel-b",
      concurrencyGroup: "batch-2",
      timestamp: new Date("2026-01-01T00:00:02.000Z"),
    });

    const timeline = buildTimeline([parallelA, sequential, parallelB]);

    const byId = Object.fromEntries(timeline.steps.map((s) => [s.id, s]));
    expect(byId["sequential"]?.concurrencyGroup).toBe("batch-1");
    expect(byId["parallel-a"]?.concurrencyGroup).toBe("batch-2");
    expect(byId["parallel-b"]?.concurrencyGroup).toBe("batch-2");
  });

  test("does not mutate the input array", () => {
    const third = makeRecord({ id: "third", timestamp: new Date("2026-01-01T00:00:03.000Z") });
    const first = makeRecord({ id: "first", timestamp: new Date("2026-01-01T00:00:01.000Z") });
    const input: ToolCallRecord[] = [third, first];
    const inputCopy = [...input];

    buildTimeline(input);

    expect(input).toEqual(inputCopy);
    expect(input[0]?.id).toBe("third");
    expect(input[1]?.id).toBe("first");
  });
});
