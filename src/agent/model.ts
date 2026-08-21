//
// Model selection is deployment-time config, not hardcoded — deliberately
// added as a requirement during design so swapping models means changing
// INVESTIGATION_AGENT_MODEL and restarting, not editing source. Resolved
// once (see investigate.ts) rather than per-call.
const DEFAULT_MODEL = "claude-opus-5";

// Kept intentionally small — every model this module has actually been
// exercised against. Extend when a new model is adopted, not speculatively.
const KNOWN_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);

export function resolveModel(): string {
  const configured = process.env.INVESTIGATION_AGENT_MODEL ?? DEFAULT_MODEL;
  if (!KNOWN_MODELS.has(configured)) {
    throw new Error(
      `Unknown INVESTIGATION_AGENT_MODEL: ${JSON.stringify(configured)}`,
    );
  }
  return configured;
}
