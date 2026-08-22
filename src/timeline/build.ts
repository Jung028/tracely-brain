// Pure transform: ToolCallRecord[] (Module 03/04-Task-1's evidence capture,
// src/agent/types.ts) -> InvestigationTimeline (this module's display data
// model). No I/O, no mutation of the input array, and no dependency on
// src/agent/ internals beyond the ToolCallRecord type itself — this file
// must stay a pure function of the data it's handed so it can be tested
// against hand-built fixtures without any agent/DB/network machinery (see
// specs/04-evidence-timeline.md "Out of scope").
import type { ToolCallRecord } from "../agent/types";
import type { InvestigationTimeline, TimelineStep } from "./types";

function toTimelineStep(record: ToolCallRecord): TimelineStep {
  return {
    id: record.id,
    toolName: record.toolName,
    query: record.input,
    why: record.why,
    result: record.result,
    meaning: record.meaning,
    hypothesisId: record.hypothesisId,
    supports: record.supports,
    timestamp: record.timestamp,
    concurrencyGroup: record.concurrencyGroup,
  };
}

export function buildTimeline(toolCalls: readonly ToolCallRecord[]): InvestigationTimeline {
  const steps = toolCalls
    .map(toTimelineStep)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return { steps };
}
