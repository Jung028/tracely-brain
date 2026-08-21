// The hypothesis state machine — the enforcement point for NFR-3 ("no
// root-cause conclusion without evidence meeting a confidence threshold")
// and CLAUDE.md's "never fabricate a root cause." The LLM proposes
// evidence via tool calls (see tools.ts); this file is the only code path
// that can move a hypothesis's status, and it never trusts the model's own
// characterization of its evidence (e.g. no "isDecisive" flag set by the
// model) — confidence/refutation weight is computed here from evidence
// *counts*, not model self-assessment.
import type { Evidence, Hypothesis } from "./types";

// TBD — calibrate against real incidents once specs/11-benchmark.md
// produces actual measurement data. Until then this is a deliberately
// conservative placeholder value, not a fabricated "real" number — see
// CLAUDE.md's "no invented numbers" rule. Simple evidence-count-based
// scoring (see confidenceFrom below) rather than a weighted model, because
// there's no calibration data yet to justify weights.
export const CONFIRMATION_THRESHOLD = 0.75;
export const REFUTATION_THRESHOLD = 0.75;

// Each piece of evidence contributes a fixed increment, diminishing
// slightly per additional item so a single tool call can't alone confirm a
// hypothesis (four items of a kind cross 0.75 at increment 0.2: 4 * 0.2 = 0.8 >= 0.75).
function confidenceFrom(evidenceCount: number): number {
  const INCREMENT = 0.2;
  return Math.min(1, evidenceCount * INCREMENT);
}

export function proposeHypothesis(
  statement: string,
  initialEvidence: Evidence[] = [],
): Hypothesis {
  let hypothesis: Hypothesis = {
    id: crypto.randomUUID(),
    statement,
    supportingEvidence: [],
    contradictingEvidence: [],
    status: "INVESTIGATING",
    confidence: 0,
  };
  for (const evidence of initialEvidence) {
    hypothesis = addSupportingEvidence(hypothesis, evidence);
  }
  return hypothesis;
}

export function addSupportingEvidence(
  hypothesis: Hypothesis,
  evidence: Evidence,
): Hypothesis {
  if (hypothesis.status === "REFUTED") {
    // Terminal — a refuted hypothesis never resurrects from new evidence.
    // The lifecycle (investigate.ts) is responsible for proposing a
    // *replacement* hypothesis (FR-20); this function only guards its own
    // invariant.
    return hypothesis;
  }

  const supportingEvidence = [...hypothesis.supportingEvidence, evidence];
  const confidence = confidenceFrom(supportingEvidence.length);
  const status: Hypothesis["status"] =
    confidence >= CONFIRMATION_THRESHOLD &&
    hypothesis.contradictingEvidence.length === 0
      ? "CONFIRMED"
      : "INVESTIGATING";

  return { ...hypothesis, supportingEvidence, confidence, status };
}

export function addContradictingEvidence(
  hypothesis: Hypothesis,
  evidence: Evidence,
): Hypothesis {
  if (hypothesis.status === "REFUTED") {
    return hypothesis;
  }

  const contradictingEvidence = [...hypothesis.contradictingEvidence, evidence];
  const contradictionWeight = confidenceFrom(contradictingEvidence.length);

  if (contradictionWeight >= REFUTATION_THRESHOLD) {
    return {
      ...hypothesis,
      contradictingEvidence,
      status: "REFUTED",
    };
  }

  // Still INVESTIGATING — a hypothesis can never be CONFIRMED while it has
  // any contradicting evidence at all (see addSupportingEvidence), so
  // confidence stays whatever it already was; only status participates
  // here.
  return {
    ...hypothesis,
    contradictingEvidence,
    status: "INVESTIGATING",
  };
}
