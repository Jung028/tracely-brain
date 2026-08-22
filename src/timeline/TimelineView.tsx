// Core rendering component for Module 04 (FR-23/FR-24/NFR-18). Pure
// presentation over the TimelineStep[] handed in via props — no fetching,
// no state beyond per-step expand/collapse (see frontend.tsx for wiring).
import { useState } from "react";
import type { TimelineStep } from "./types";
import "./timeline.css";

export interface TimelineViewProps {
  steps: readonly TimelineStep[];
}

interface StepGroup {
  concurrencyGroup: string;
  steps: TimelineStep[];
}

// Steps sharing a concurrencyGroup ran in the same tool-runner iteration
// (see src/agent/types.ts's ToolCallRecord doc comment) — after
// buildTimeline's chronological sort, those steps land adjacent to each
// other, so grouping consecutive same-group steps is enough to recover the
// parallel/sequential structure without any extra bookkeeping.
function groupConsecutiveSteps(steps: readonly TimelineStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const current = groups[groups.length - 1];
    if (current && current.concurrencyGroup === step.concurrencyGroup) {
      current.steps.push(step);
    } else {
      groups.push({ concurrencyGroup: step.concurrencyGroup, steps: [step] });
    }
  }
  return groups;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function HypothesisLinkage({ step }: { step: TimelineStep }) {
  if (step.hypothesisId === null) {
    // NFR-18 / spec test case: exploratory steps must render an explicit,
    // visible "not linked" state — never a blank or omitted line.
    return <div className="timeline-step__hypothesis timeline-step__exploratory">Exploratory — not linked to a hypothesis</div>;
  }

  const supportsClass =
    step.supports === "contradicting"
      ? "timeline-step__hypothesis--contradicting"
      : "timeline-step__hypothesis--supporting";

  return (
    <div className={`timeline-step__hypothesis ${supportsClass}`}>
      <span className="label">Supports:</span> {step.hypothesisId} ({step.supports ?? "unknown"}) — {step.meaning}
    </div>
  );
}

function StepRow({ step }: { step: TimelineStep }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="timeline-step">
      <button
        type="button"
        className="timeline-step__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="timeline-step__tool">{step.toolName}</span>
        <span className="timeline-step__why">{step.why}</span>
      </button>
      {expanded && (
        <div className="timeline-step__details">
          <div>
            <span className="label">Step:</span> {step.toolName}
          </div>
          <div>
            <span className="label">Query:</span>
            <pre>{formatValue(step.query)}</pre>
          </div>
          <div>
            <span className="label">Why:</span> {step.why}
          </div>
          <div>
            <span className="label">Result:</span>
            <pre>{formatValue(step.result)}</pre>
          </div>
          <HypothesisLinkage step={step} />
        </div>
      )}
    </li>
  );
}

export function TimelineView({ steps }: TimelineViewProps) {
  const groups = groupConsecutiveSteps(steps);

  return (
    <div className="timeline">
      <h1>Investigation Timeline</h1>
      <ol className="timeline-list">
        {groups.map((group, index) => {
          const isParallel = group.steps.length > 1;
          return (
            <li
              key={`${group.concurrencyGroup}-${index}`}
              className={isParallel ? "timeline-group timeline-group--parallel" : "timeline-group"}
            >
              {isParallel && <div className="timeline-group__label">Ran in parallel</div>}
              <ol className="timeline-group__steps">
                {group.steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
