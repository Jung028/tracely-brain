# Investigation Agent (Module 03)

## Public surface

```ts
import { investigate } from "../src/agent";

const result = await investigate("Task stuck in WAIT_JUDGE for order #123");

if (result.outcome === "CONFIRMED") {
  console.log(result.rca, result.evidenceTrail);
} else {
  console.log("insufficient evidence:", result.reason, result.hypothesesConsidered);
}
```

## Configuration

- `INVESTIGATION_AGENT_MODEL` — selects the Claude model, default `claude-opus-5`. Throws at
  first call if set to an unrecognized model id.

## Known gaps (tracked, not silent)

- `query_database` and `search_logs` tools always return a `NOT_IMPLEMENTED` marker — real
  PostgreSQL/Datadog integrations are a later pass (Module 02 was closed at GitHub-only scope
  for the MVP; see `docs/superpowers/specs/2026-08-21-investigation-agent-design.md`, Scope
  Decision #1/#2).
- `CONFIRMATION_THRESHOLD` / `REFUTATION_THRESHOLD` (`src/agent/hypotheses.ts`) are explicit
  provisional values — not yet calibrated against real incidents (needs Module 11's benchmark
  data).
