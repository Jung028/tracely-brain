// Hand-authored demo fixture for the "/api/timeline/demo" route
// (src/timeline/server.ts). Per this task's binding ruling, production code
// must never import test doubles from `tests/` (mockAnthropicClient,
// seedBrain, etc.) — those are for tests only. Instead this file hard-codes
// a small ToolCallRecord[] that tells the spec's own WAIT_JUDGE demo story
// (specs/04-evidence-timeline.md "Suggested first Claude Code session"),
// so the UI can be built and demoed without a live Anthropic call or a
// seeded Company Brain.
//
// Array order is deliberately NOT chronological (see timestamps below) so
// the demo route also exercises buildTimeline's sort-by-timestamp step, not
// just its field mapping.
import type { ToolCallRecord } from "../agent";

const BASE = new Date("2026-08-22T09:14:00.000Z");
const at = (offsetSeconds: number): Date => new Date(BASE.getTime() + offsetSeconds * 1000);

export const demoToolCalls: ToolCallRecord[] = [
  // Reproduces specs/04-evidence-timeline.md's example step verbatim
  // (toolName/why/hypothesisId/supports/meaning match the spec's rendered
  // example exactly).
  {
    id: "step-1",
    toolName: "query_brain",
    input: { mode: "traverse", startEntityId: "task-123", relationTypes: ["DEPENDS_ON"] },
    why: "Determine current task state and related workflow.",
    result: { status: "WAIT_JUDGE", relation_id: "wf-456" },
    timestamp: at(5),
    concurrencyGroup: "batch-1",
    hypothesisId: "H1",
    supports: "supporting",
    // Deliberately does NOT repeat "H1 — " here: TimelineView's
    // formatHypothesisLine() supplies the hypothesis id once, from
    // hypothesisId, so this reads as "Supports: H1 — scheduler-related
    // workflow blockage" — matching specs/04-evidence-timeline.md's
    // literal example character-for-character (see review fix: an earlier
    // version had this field lead with "H1 — " too, which duplicated the
    // id in the rendered line).
    meaning: "scheduler-related workflow blockage",
  },
  // Second sequential step, later in the investigation: contradicting
  // evidence against a downstream-consumer hypothesis, to show a
  // "contradicting" link rendered distinctly from "supporting".
  {
    id: "step-5",
    toolName: "query_brain",
    input: { mode: "get", entityId: "svc-payment-consumer" },
    why: "Rule out the downstream consumer service as the blockage source.",
    result: { status: "HEALTHY", lastHeartbeat: "2026-08-22T09:13:50.000Z" },
    timestamp: at(7),
    concurrencyGroup: "batch-4",
    hypothesisId: "H1",
    supports: "contradicting",
    meaning: "Downstream consumer is healthy, so the blockage is not there",
  },
  // Exploratory step with no hypothesis linkage at all — must still render,
  // with an explicit visible "not linked to a hypothesis" state rather than
  // a blank field.
  {
    id: "step-4",
    toolName: "search_logs",
    input: { service: "scheduler", query: "ERROR", sinceMinutes: 30 },
    why: "Check for recent errors that might explain the timing of the stall.",
    result: { matches: [] },
    timestamp: at(1),
    concurrencyGroup: "batch-3",
    hypothesisId: null,
    supports: null,
    meaning: null,
  },
  // Two steps sharing a concurrencyGroup — ran in parallel within the same
  // tool-runner iteration, both feeding the same hypothesis.
  {
    id: "step-2",
    toolName: "search_code",
    input: { path: "services/scheduler", query: "judge_queue" },
    why: "Confirm the scheduler service still polls the judge queue.",
    result: { file: "services/scheduler/poller.ts", line: 42, snippet: "pollJudgeQueue()" },
    timestamp: at(2),
    concurrencyGroup: "batch-2",
    hypothesisId: "H1",
    supports: "supporting",
    meaning: "Scheduler handler still calls pollJudgeQueue(), so polling logic itself is intact",
  },
  {
    id: "step-3",
    toolName: "query_database",
    input: { table: "CB_TASK", where: { status: "WAIT_JUDGE" } },
    why: "Count how many other tasks are stuck in the same wait state.",
    result: { count: 14 },
    timestamp: at(2),
    concurrencyGroup: "batch-2",
    hypothesisId: "H1",
    supports: "supporting",
    meaning: "14 other tasks share this wait state, consistent with a scheduler-wide blockage",
  },
];
