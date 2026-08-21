// src/agent/index.ts
//
// Public surface for Module 03. A later module (04, Evidence Timeline —
// not part of this plan) imports from here, matching the barrel-export
// pattern in src/brain/index.ts and src/integrations/github/index.ts.
export { investigate } from "./investigate";
export type { InvestigateOptions } from "./investigate";
export type {
  Evidence,
  Hypothesis,
  HypothesisStatus,
  InvestigationResult,
} from "./types";
export { CONFIRMATION_THRESHOLD, REFUTATION_THRESHOLD } from "./hypotheses";
