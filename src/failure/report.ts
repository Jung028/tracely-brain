// Formats module 03's raw INSUFFICIENT_EVIDENCE outcome into FR-25's
// explicit NOT CONFIRMED report. Every field here is derived from what the
// investigation actually did — never a guess dressed up as a
// specific-sounding cause (CLAUDE.md's "no invented numbers" rule, applied
// to prose too).
//
// Known limitation (see docs/failure-handling.md): module 03 (as merged)
// only tracks evidence actually *cited* to a hypothesis via
// update_hypothesis — a tool call that failed or returned nothing useful
// and was never cited leaves no trace here. So "investigated"/"missing"
// can only reflect cited evidence, not every tool call the agent made.
// Closing that gap needs the full tool-call log module 04 adds; module 05
// depends only on module 03 (its declared spec dependency), so it doesn't
// reach across to an unmerged sibling branch for that data. When
// no failure signal is found in cited evidence, `missing` falls back to
// module 03's own `reason` string rather than inventing one.
//
// A second, sharper edge of the same limitation: update_hypothesis's own
// handler (tools.ts) currently hardcodes every Evidence's `raw` field to
// `null` regardless of what the underlying tool actually returned, so
// detectMissingSignals below has no real signal to find in *any* live
// investigate() run today — the `reason` fallback is the path that
// actually fires in production right now. detectMissingSignals still
// exists (and is unit-tested against hand-built fixtures) because it's
// the correct, forward-compatible behavior the moment `raw` starts being
// populated with the real tool result — not dead code to be deleted.
import type { Evidence, Hypothesis, InvestigationResult } from "../agent/types";
import type { FailureReport } from "./types";

type InsufficientEvidenceResult = Extract<
  InvestigationResult,
  { outcome: "INSUFFICIENT_EVIDENCE" }
>;

// The agent's evidence-gathering tools (tools.ts) — excludes the control
// tools propose_hypothesis/update_hypothesis, which don't query a source.
// `Evidence.toolSource` is model-supplied free text (tools.ts's schema:
// "Which tool produced this evidence, e.g. query_brain"), not a validated
// enum, so unrecognized values pass through as-is rather than being
// dropped or relabeled to something not actually said.
const SOURCE_LABELS: Record<string, string> = {
  query_brain: "Company Brain",
  search_code: "Code",
  query_database: "Database",
  search_logs: "Logs",
};

// Evidence whose raw underlying tool result reports one of these `status`
// values means that source produced no usable evidence — either a real
// connection failure (GitHub's ConnectionFailure shape, see
// src/integrations/github/types.ts) or the permanent NOT_IMPLEMENTED stub
// for the not-yet-built Database/Logs sources.
const MISSING_SOURCE_STATUSES = new Set([
  "NOT_IMPLEMENTED",
  "not_connected",
  "auth_expired",
  "insufficient_permissions",
  "unavailable",
  "query_failed",
]);

interface MissingSignal {
  label: string;
  status: string;
  detail?: string;
}

function friendlyLabel(toolSource: string): string {
  return SOURCE_LABELS[toolSource] ?? toolSource;
}

function allEvidence(hypotheses: readonly Hypothesis[]): Evidence[] {
  return hypotheses.flatMap((h) => [...h.supportingEvidence, ...h.contradictingEvidence]);
}

function resultField(raw: unknown, field: string): string | undefined {
  if (raw && typeof raw === "object" && field in raw) {
    const value = (raw as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function investigatedList(hypotheses: readonly Hypothesis[]): string[] {
  const seen = new Set<string>();
  for (const evidence of allEvidence(hypotheses)) {
    seen.add(friendlyLabel(evidence.toolSource));
  }
  return [...seen];
}

function detectMissingSignals(hypotheses: readonly Hypothesis[]): MissingSignal[] {
  const seen = new Map<string, MissingSignal>();
  for (const evidence of allEvidence(hypotheses)) {
    const status = resultField(evidence.raw, "status");
    if (!status || !MISSING_SOURCE_STATUSES.has(status)) continue;

    const label = friendlyLabel(evidence.toolSource);
    if (!seen.has(label)) {
      seen.set(label, { label, status, detail: resultField(evidence.raw, "detail") });
    }
  }
  return [...seen.values()];
}

function describeMissing(signals: MissingSignal[], fallbackReason: string): string {
  if (signals.length === 0) return fallbackReason;
  return signals
    .map((signal) => {
      if (signal.status === "NOT_IMPLEMENTED") {
        return `${signal.label} unavailable (not yet implemented)`;
      }
      return `${signal.label} unavailable (${signal.detail ?? signal.status})`;
    })
    .join("; ");
}

function recommendNextStep(signals: MissingSignal[]): string {
  if (signals.length === 0) {
    return "Escalate to a human investigator for manual review — no automated path to more evidence.";
  }

  const [first] = signals;
  switch (first.status) {
    case "NOT_IMPLEMENTED":
      return `Connect the ${first.label} integration; it is not yet implemented.`;
    case "not_connected":
      return `Connect ${first.label} and retry.`;
    case "auth_expired":
      return `Refresh credentials for ${first.label} and retry.`;
    case "insufficient_permissions":
      return `Grant sufficient permissions on ${first.label} and retry.`;
    default:
      return `Retry once ${first.label} is reachable.`;
  }
}

export function buildFailureReport(result: InsufficientEvidenceResult): FailureReport {
  const signals = detectMissingSignals(result.hypothesesConsidered);
  return {
    status: "MANUAL_REVIEW_REQUIRED",
    rootCause: "NOT CONFIRMED",
    investigated: investigatedList(result.hypothesesConsidered),
    missing: describeMissing(signals, result.reason),
    recommendedNextStep: recommendNextStep(signals),
  };
}

/** Renders the spec's example layout (specs/05-failure-handling.md). */
export function renderFailureReport(report: FailureReport): string {
  const checks = report.investigated.map((source) => `✓ ${source}`).join("  ");
  return [
    "Investigation completed",
    `Root cause: ${report.rootCause}`,
    `Investigated: ${checks}`,
    `Missing: ${report.missing}`,
    `Recommended next investigation: ${report.recommendedNextStep}`,
  ].join("\n");
}
