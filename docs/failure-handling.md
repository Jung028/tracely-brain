# Failure Handling — the "never fabricate" gate

This documents module 05: the layer that turns module 03's raw `INSUFFICIENT_EVIDENCE` outcome
into the explicit `NOT CONFIRMED` / `MANUAL_REVIEW_REQUIRED` report FR-25/FR-26 require. Module 03
already enforces the confidence math (`CONFIRMATION_THRESHOLD` in `src/agent/hypotheses.ts`) and
stops at a plain `{ outcome: "INSUFFICIENT_EVIDENCE", hypothesesConsidered, reason }` — this module
formats that into something a human (or a future UI/Slack consumer) can act on, without ever
inventing a specific-sounding cause the investigation didn't actually establish.

Signatures below are copied from `src/failure/report.ts` and `src/failure/types.ts` — keep this
file in sync with those if the signatures change.

## Import

```ts
import { buildFailureReport, renderFailureReport } from "../failure"; // src/failure/index.ts
```

## `buildFailureReport`

```ts
function buildFailureReport(
  result: Extract<InvestigationResult, { outcome: "INSUFFICIENT_EVIDENCE" }>,
): FailureReport;
```

```ts
interface FailureReport {
  status: "MANUAL_REVIEW_REQUIRED";
  rootCause: "NOT CONFIRMED";
  investigated: readonly string[];
  missing: string;
  recommendedNextStep: string;
}
```

- **`investigated`** — the distinct evidence sources (`Evidence.toolSource`, friendly-labeled:
  `query_brain` → "Company Brain", `search_code` → "Code", `query_database` → "Database",
  `search_logs` → "Logs"; anything else passes through as the raw string rather than being
  dropped) across every hypothesis considered. Only reflects evidence actually *cited* to a
  hypothesis via `update_hypothesis` — see "Known limitation" below.
- **`missing`** — describes any cited evidence whose underlying tool result reported a failure
  (GitHub's `ConnectionFailure` shape) or the permanent `NOT_IMPLEMENTED` marker (`query_database`/
  `search_logs` — module 02 closed at GitHub-only scope). When no such signal exists anywhere in
  the cited evidence, this falls back verbatim to module 03's own `reason` string (e.g. "no
  hypothesis reached the confirmation threshold") — never a fabricated specific like "trace
  expired" when nothing in the data actually says that.
- **`recommendedNextStep`** — templated off the same signal: e.g. "Connect the Database
  integration; it is not yet implemented." / "Refresh credentials for Company Brain and retry."
  With no signal: a fixed fallback, "Escalate to a human investigator for manual review — no
  automated path to more evidence."

## `renderFailureReport`

```ts
function renderFailureReport(report: FailureReport): string;
```

Renders the spec's example layout verbatim:

```
Investigation completed
Root cause: NOT CONFIRMED
Investigated: ✓ Database  ✓ Logs  ✓ Code
Missing: <report.missing>
Recommended next investigation: <report.recommendedNextStep>
```

---

## Known limitation: cited evidence only, not every tool call

Module 03 (as merged) only records `Evidence` when the model actually cites a tool result to a
hypothesis via `update_hypothesis` — a tool call that failed and was never cited (because the
model didn't find it useful, or gave up before citing anything) leaves no trace in
`hypothesesConsidered`. So `buildFailureReport` can only be as complete as what was cited; it
cannot see a full log of every attempt the agent made.

A second, sharper edge of the same limitation: `update_hypothesis`'s handler
(`src/agent/tools.ts`) currently hardcodes every `Evidence.raw` to `null` regardless of what the
underlying tool actually returned. That means `buildFailureReport`'s missing-source signal
detection (scanning `evidence.raw` for a `ConnectionFailure`/`NOT_IMPLEMENTED` shape) has nothing
real to find in **any** live `investigate()` run today — the `reason` fallback is the path that
actually fires in production right now. The detection logic still exists, and is unit-tested
against hand-built fixtures, because it's the correct, forward-compatible behavior for the moment
`raw` starts carrying the real tool result — not dead code.

Closing this gap fully needs the full tool-call log (`ToolCallRecord[]`, tracking every call, cited
or not) that module 04 (Evidence Timeline) adds on top of module 03. Module 05's spec dependency is
declared as module 03 only, so this module deliberately does not reach across to that unmerged
sibling branch for the richer data — see the module's `CLAUDE.md` rule against implementing
functionality that belongs to a later spec.

## Test cases (`tests/failure/`)

- `report.test.ts` — the spec's required cases against hand-built fixtures: zero hypotheses
  proposed, some evidence below threshold, a cited `NOT_IMPLEMENTED`/`ConnectionFailure` signal,
  an unrecognized `toolSource` passed through unmodified, and the exact render-layout match.
- `adversarial.test.ts` — the spec's required adversarial case: a red-herring correlation (a
  deploy that coincided with the incident, cited three times) that sounds convincing but only
  reaches 0.6 confidence — below the 0.75 threshold. Runs the real `investigate()` pipeline
  end-to-end (not a hand-built fixture) to confirm the full stack — hypothesis gate plus this
  module's formatting — never reports it as a confirmed cause.
