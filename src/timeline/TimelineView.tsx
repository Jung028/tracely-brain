// Core rendering component for Module 04 (FR-23/FR-24/NFR-18). Pure
// presentation over the TimelineStep[] handed in via props, plus an
// optional investigation-level summary (problemDescription/status/summary)
// — see src/timeline/summary.ts for how that's built. No fetching, no state
// beyond per-step expand/collapse and the summary/step data handed in via
// props (see frontend.tsx for wiring).
import { useState } from "react";
import type { TimelineStep } from "./types";
import type { HypothesisSummary, InvestigationSummary } from "./summary";
import "./timeline.css";

export interface TimelineViewProps {
  steps: readonly TimelineStep[];
  problemDescription?: string;
  status?: string;
  summary?: InvestigationSummary;
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

// A human-scannable one-liner for what a step returned. Never fabricates —
// it either surfaces the agent's own stated meaning (set when
// update_hypothesis cites this step) or mechanically summarizes the raw
// result shape (count/empty/JSON), never inventing an interpretation the
// agent didn't state. Exported and kept pure so it's unit-testable without
// rendering — see tests/timeline/TimelineView.test.ts.
export function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) {
    return "No result";
  }
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return "No matches found";
    }
    return `Found ${result.length} result${result.length === 1 ? "" : "s"}`;
  }
  if (typeof result === "object") {
    const json = JSON.stringify(result);
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  }
  return String(result);
}

export function findingLine(step: Pick<TimelineStep, "meaning" | "result">): string {
  return step.meaning ?? summarizeResult(step.result);
}

// The agent's tool-call "reason" argument is what becomes step.why — when a
// query object still carries that same text under a "reason" key, showing
// it a second time inside the raw JSON is pure duplication of the "Why:"
// line already rendered next to it. This strips only that exact
// duplicate key; every other field in the query is shown as-is.
function formatQuery(query: unknown, why: string): string {
  if (query && typeof query === "object" && !Array.isArray(query)) {
    const obj = query as Record<string, unknown>;
    if (obj.reason === why) {
      const { reason: _reason, ...rest } = obj;
      return formatValue(rest);
    }
  }
  return formatValue(query);
}

// Carries the supporting/contradicting direction in the label word itself
// (rather than a parenthetical) so the formatted line can read exactly
// like specs/04-evidence-timeline.md's literal example
// ("Supports: H1 — scheduler-related workflow blockage") for a supporting
// step, with no duplicated hypothesis id and no extra qualifier the spec's
// example doesn't show. Exported (and kept as a small pure function) so it
// can be unit-tested directly without rendering the component — see
// tests/timeline/TimelineView.test.ts.
export function hypothesisLinkLabel(supports: TimelineStep["supports"]): "Supports" | "Refutes" {
  return supports === "contradicting" ? "Refutes" : "Supports";
}

export function formatHypothesisLine(
  step: Pick<TimelineStep, "hypothesisId" | "supports" | "meaning">,
): string {
  if (step.hypothesisId === null) {
    // NFR-18 / spec test case: exploratory steps must render an explicit,
    // visible "not linked" state — never a blank or omitted line.
    return "Exploratory — not linked to a hypothesis";
  }
  return `${hypothesisLinkLabel(step.supports)}: ${step.hypothesisId} — ${step.meaning}`;
}

function HypothesisLinkage({ step }: { step: TimelineStep }) {
  if (step.hypothesisId === null) {
    return (
      <div className="timeline-step__hypothesis timeline-step__exploratory">
        {formatHypothesisLine(step)}
      </div>
    );
  }

  const supportsClass =
    step.supports === "contradicting"
      ? "timeline-step__hypothesis--contradicting"
      : "timeline-step__hypothesis--supporting";

  return <div className={`timeline-step__hypothesis ${supportsClass}`}>{formatHypothesisLine(step)}</div>;
}

function StepRow({ step, stepNumber, total }: { step: TimelineStep; stepNumber: number; total: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="timeline-step">
      <button
        type="button"
        className="timeline-step__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="timeline-step__chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <div className="timeline-step__summary">
          <div className="timeline-step__headline">
            <span className="timeline-step__number">
              Step {stepNumber} of {total}
            </span>
            <span className="timeline-step__tool">{step.toolName}</span>
          </div>
          <div className="timeline-step__why">{step.why}</div>
          <div className="timeline-step__finding">→ {findingLine(step)}</div>
        </div>
      </button>
      {expanded && (
        <div className="timeline-step__details">
          <div>
            <span className="label">Query:</span>
            <pre>{formatQuery(step.query, step.why)}</pre>
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

function OutcomeBanner({ summary }: { summary: InvestigationSummary }) {
  if (summary.outcome === "CONFIRMED") {
    return (
      <div className="timeline-summary__outcome timeline-summary__outcome--confirmed">
        <span className="timeline-summary__outcome-label">Root cause confirmed</span>
        <p>{summary.rca}</p>
      </div>
    );
  }
  return (
    <div className="timeline-summary__outcome timeline-summary__outcome--unconfirmed">
      <span className="timeline-summary__outcome-label">Not confirmed</span>
      <p>{summary.reason}</p>
    </div>
  );
}

function HypothesisList({ hypotheses }: { hypotheses: readonly HypothesisSummary[] }) {
  if (hypotheses.length === 0) {
    return <p className="timeline-summary__no-hypotheses">No hypotheses were proposed.</p>;
  }
  return (
    <ul className="timeline-summary__hypotheses">
      {hypotheses.map((hypothesis) => (
        <li
          key={hypothesis.id}
          className={`timeline-summary__hypothesis timeline-summary__hypothesis--${hypothesis.status.toLowerCase()}`}
        >
          <span className="timeline-summary__hypothesis-id">{hypothesis.id}</span>
          <span className="timeline-summary__hypothesis-status">{hypothesis.status}</span>
          <span className="timeline-summary__hypothesis-statement">{hypothesis.statement}</span>
        </li>
      ))}
    </ul>
  );
}

function InvestigationSummaryHeader({
  problemDescription,
  status,
  summary,
  stepCount,
}: {
  problemDescription?: string;
  status?: string;
  summary?: InvestigationSummary;
  stepCount: number;
}) {
  if (!summary) {
    return null;
  }
  return (
    <div className="timeline-summary">
      {problemDescription && <p className="timeline-summary__question">{problemDescription}</p>}
      <div className="timeline-summary__meta">
        {status && <span className="timeline-summary__status">Status: {status}</span>}
        <span className="timeline-summary__step-count">
          {stepCount} step{stepCount === 1 ? "" : "s"}
        </span>
      </div>
      <OutcomeBanner summary={summary} />
      <HypothesisList hypotheses={summary.hypotheses} />
    </div>
  );
}

export function TimelineView({ steps, problemDescription, status, summary }: TimelineViewProps) {
  const groups = groupConsecutiveSteps(steps);
  const stepNumbers = new Map(steps.map((step, index) => [step.id, index + 1]));

  return (
    <div className="timeline">
      <h1>Investigation Timeline</h1>
      <InvestigationSummaryHeader
        problemDescription={problemDescription}
        status={status}
        summary={summary}
        stepCount={steps.length}
      />
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
                  <StepRow
                    key={step.id}
                    step={step}
                    stepNumber={stepNumbers.get(step.id)!}
                    total={steps.length}
                  />
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
