# Module 03 — Investigation Agent: Design

Status: approved for planning
Spec: `specs/03-investigation-agent.md`
Depends on: `specs/01-company-brain.md` (merged, main), `specs/02-source-integrations.md` (merged, main — GitHub-only scope, see Scope Decisions below)

## Purpose

Implements FR-17 through FR-20, FR-29 through FR-31: the reasoning layer that turns a
Company Brain + connected sources into an actual investigation — retrieves context, forms
and tests named hypotheses, decides which tools to call and when, and produces either a
confirmed root cause or an honest "insufficient evidence" report.

## Scope decisions (resolved before design)

These were open questions raised while reading the spec against actual repo state, resolved
with the project owner before proposing an architecture:

1. **Module 02 is closed for MVP at GitHub-only scope.** `specs/02-source-integrations.md`'s
   Definition of Done lists five integrations (GitHub, PostgreSQL, Datadog, PagerDuty, Slack);
   only GitHub is built. Decision: treat Module 02 as done for now; Module 03 proceeds against
   the tools that exist today, stubbing the ones that don't (see #2). PostgreSQL / Datadog /
   PagerDuty / Slack integrations are a later pass, not this module's blocker.
2. **FR-31's PostgreSQL-query and log-search tools are stubbed, not skipped.** They're declared
   as real Tool Runner tools with the correct name/schema/contract, but their handlers return a
   typed `NOT_IMPLEMENTED` result instead of live data. This keeps FR-31's tool-calling contract
   intact — swapping in real integrations later changes only the handler body, not the agent's
   tool surface or any test that exercises the contract.
3. **The three "demo scenarios" referenced by the spec (scheduler disabled / missing config /
   race condition) have no source material in this repo** (no `FUTURE-IDEAS.md`, no spec PDF).
   They are authored fresh for this module as synthetic-but-realistic test fixtures, described
   in detail under Testing below.
4. **Model is configurable, not hardcoded.** New requirement added during design: an
   `INVESTIGATION_AGENT_MODEL` env var selects the model, defaulting to `claude-opus-5`,
   validated at module init.

## Non-goals (owned by other modules, per CLAUDE.md's "don't implement a later spec")

- Evidence display/rendering — `specs/04-evidence-timeline.md`.
- Assigning the `NOT CONFIRMED` / `MANUAL_REVIEW_REQUIRED` state — `specs/05-failure-handling.md`.
  This module only needs to report insufficient evidence honestly; it does not own that state
  name or its transition.
- Remediation / DML / PR generation and the human-approval gate — `specs/09-remediation.md`,
  `specs/06-human-collaboration.md`.
- Real PostgreSQL/Datadog/PagerDuty/Slack integrations — deferred per Scope Decision #1.

## Architecture

**Anthropic API directly, via the SDK's Tool Runner** (`client.beta.messages.toolRunner()`),
not the Claude Agent SDK and not Managed Agents — this module owns its own tool surface and
needs to run inside this repo's existing Bun process, not a hosted sandbox. Tool Runner was
chosen over a hand-written manual loop because it already gives us parallel tool execution
(FR-18) and turn management for free — our actual point of control is at the tool-handler
level, not the loop level, so there's no benefit to reimplementing the loop.

**The LLM reasons; our code enforces the rules.** The model can freely call `queryBrain`,
`searchCode`, `queryDatabase`, `searchLogs` to gather evidence, but it can only affect
hypothesis state through two control tools — `proposeHypothesis` and `updateHypothesis` —
whose handlers run our own validation (legal state transitions, evidence-threshold check)
before anything is recorded as fact. This is what makes NFR-3 ("no root-cause conclusion
without evidence meeting a confidence threshold") and CLAUDE.md's "never fabricate a root
cause" enforceable as code, not prompt-following.

## Module structure

New `src/agent/` directory, following the existing `src/brain/` / `src/integrations/github/`
pattern (types file, implementation files, barrel export):

| File | Responsibility |
|---|---|
| `types.ts` | `Hypothesis`, `Evidence`, `InvestigationResult` domain types |
| `hypotheses.ts` | State machine: propose/update, legal transitions, confidence scoring |
| `tools.ts` | Tool Runner tool definitions (real + stubbed + control tools) |
| `model.ts` | Resolves/validates `INVESTIGATION_AGENT_MODEL`, defaults to `claude-opus-5` |
| `investigate.ts` | FR-17 entrypoint: runs the lifecycle to completion, returns `InvestigationResult` |
| `index.ts` | Public barrel export |

### Types

```ts
type HypothesisStatus = "INVESTIGATING" | "CONFIRMED" | "REFUTED";

interface Evidence {
  id: string;
  toolSource: string;        // e.g. "queryBrain", "searchCode"
  description: string;
  timestamp: Date;
  raw: unknown;               // reference to the underlying tool result
}

interface Hypothesis {
  id: string;
  statement: string;
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];
  status: HypothesisStatus;
  confidence: number;         // 0-1, recomputed on every updateHypothesis call
}

type InvestigationResult =
  | { outcome: "CONFIRMED"; hypothesis: Hypothesis; rca: string; evidenceTrail: Evidence[] }
  | { outcome: "INSUFFICIENT_EVIDENCE"; hypothesesConsidered: Hypothesis[]; reason: string };
```

### Hypothesis state machine (`hypotheses.ts`)

- `proposeHypothesis(statement, initialEvidence?)` → new `Hypothesis`, status `INVESTIGATING`.
- `updateHypothesis(id, { addSupporting?, addContradicting? })` → recomputes `confidence`,
  then enforces:
  - `INVESTIGATING → CONFIRMED` only when `confidence >= CONFIRMATION_THRESHOLD` **and**
    `contradictingEvidence` is empty. Both conditions required — matches NFR-3's mechanism
    requirement plus CLAUDE.md's fabrication ban.
  - `INVESTIGATING → REFUTED` when accumulated contradicting evidence crosses a symmetric
    `REFUTATION_THRESHOLD` (same TBD-and-marked treatment as `CONFIRMATION_THRESHOLD`),
    computed by `hypotheses.ts` from the contradicting-evidence set — not a flag the model
    sets on its own tool call. A single weak contradiction shouldn't kill a hypothesis
    outright, and the model doesn't get to self-certify that its own evidence is decisive;
    that would undercut the same "code enforces the rules" principle NFR-3 exists for.
  - `REFUTED` is terminal for that hypothesis but triggers `proposeHypothesis` for a
    replacement built from the evidence already gathered (FR-20) — this happens in
    `investigate.ts`, which owns the lifecycle, not inside `updateHypothesis` itself, so the
    state machine function stays a pure transition and the lifecycle owns "what happens next."
- `CONFIRMATION_THRESHOLD` is an exported constant with an explicit
  `// TBD — calibrate against real incidents once specs/11-benchmark.md exists` comment. This
  satisfies CLAUDE.md's "no invented numbers" rule: the mechanism is real and tested, the
  number itself is honestly marked provisional.

### Tools (`tools.ts`)

| Tool | Backing | Notes |
|---|---|---|
| `queryBrain` | `src/brain` barrel (`queryRelationships`, `traverse`, `getProvenance`) | Includes historical-RCA retrieval scoped to the `Operational Knowledge` domain (FR-29) — no new integration needed, it's the same Brain query surface |
| `searchCode` | `src/integrations/github` — path/name search over synced File entities (via `src/brain`) plus a new `getFileContent(owner, repo, sha)` added to `src/integrations/github/client.ts` for actual blob content | Read-only. `getFileContent` is a small, natural addition to the already-reviewed GitHub client — Module 02 only ever synced path+sha metadata, never content, and FR-31 (Module 03's own requirement) needs real code text, not just paths |
| `queryDatabase` | stub | Returns `{ status: "NOT_IMPLEMENTED", tool: "queryDatabase" }`; real Postgres integration is a future module |
| `searchLogs` | stub | Same `NOT_IMPLEMENTED` contract, for Datadog |
| `proposeHypothesis` / `updateHypothesis` | `hypotheses.ts` | Control tools — the only way the model affects state |

A stubbed tool's `NOT_IMPLEMENTED` result is itself evidence the agent can reason about (e.g.
note the gap in its RCA narrative or in `INSUFFICIENT_EVIDENCE.reason`) — it must never be
silently treated as "source returned nothing meaningful," which would let the agent draw a
conclusion on an artificially narrowed evidence set. This is the honest-gap behavior FR-15
asks for at the integration layer, applied at the tool-contract layer here.

### Model configuration (`model.ts`)

```ts
const DEFAULT_MODEL = "claude-opus-5";
const KNOWN_MODELS = new Set(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", /* ... */]);

export function resolveModel(): string {
  const configured = process.env.INVESTIGATION_AGENT_MODEL ?? DEFAULT_MODEL;
  if (!KNOWN_MODELS.has(configured)) {
    throw new Error(`Unknown INVESTIGATION_AGENT_MODEL: "${configured}"`);
  }
  return configured;
}
```

Called once at `investigate.ts` module load, not per-call — fails fast on a bad config value
rather than deep inside a running investigation.

### Lifecycle entrypoint (`investigate.ts`)

`investigate(problemDescription, brainHandle): Promise<InvestigationResult>` — seeds Tool
Runner with the tool set above, a system prompt encoding the FR-17 lifecycle (understand →
retrieve Brain context → form hypotheses → select tools → collect evidence → update
hypotheses → validate → RCA), and `resolveModel()`'s result. Runs to completion (Tool Runner
handles the request/execute/loop cycle including parallel tool calls). On a `REFUTED`
transition, generates the replacement hypothesis and continues. Terminates either on a
`CONFIRMED` hypothesis (returns the RCA form) or when the model signals it has no further
hypotheses to test (returns `INSUFFICIENT_EVIDENCE` — never fabricates a conclusion to end
the loop).

## Testing

Three synthetic demo-scenario fixtures (authored fresh, no source material existed for these
— see Scope Decision #3), each as seeded in-memory Brain state + mocked tool responses +
expected terminal `InvestigationResult`:

1. **Scheduler disabled** — Brain seeded with a scheduler entity and a `TRANSITIONS_TO`
   relationship showing a task stuck in `WAIT_JUDGE`; mocked `searchCode`/`queryDatabase`
   responses show the scheduler config disabled. Expected: `CONFIRMED`.
2. **Missing config** — a required config entity absent from Brain query results; mocked log
   search shows a startup failure referencing the missing key. Expected: `CONFIRMED`.
3. **Race condition** — two concurrent-write entities linked by `DEPENDS_ON` with no ordering
   guarantee; evidence is deliberately ambiguous so the first hypothesis is expected to reach
   `REFUTED` and a second, correct one generated — this is the test that exercises FR-20 end
   to end, not just as a unit test on `hypotheses.ts`.

Plus the two explicit test cases from `specs/03-investigation-agent.md`:

- A hypothesis moves `INVESTIGATING → REFUTED` on decisive contradicting evidence and a
  replacement hypothesis is generated from the evidence already gathered.
- A historical-incident RCA surfaces as a *candidate* hypothesis (via `queryBrain`'s
  `Operational Knowledge` scope) and the agent still requires fresh evidence before
  `CONFIRMED` — tested explicitly per FR-30's note that this rule is easy to accidentally skip.

All three demo scenarios and the two state-machine cases run against mocked tool responses,
not live GitHub/Postgres — Module 03's Definition of Done is "runs end-to-end against a
seeded test Brain + mocked tool responses," matching `specs/03-investigation-agent.md`.

**The Anthropic client itself is dependency-injected and mocked in tests**, not called live —
unlike the GitHub-integration tests' live-by-default pattern. Reason: `.claude/settings.json`'s
PostToolUse hook runs the full test suite after every single Write/Edit; real LLM calls on
every save would be slow, cost real tokens per keystroke of agent work, and introduce
nondeterministic failures into the autonomous-correction loop that hook exists to support. A
small number of real-API smoke tests can be added later, explicitly excluded from the
save-triggered run. `investigate.ts` takes an injectable Anthropic client (or a thin
`ToolRunnerClient` seam) the same way `client.ts` in the GitHub integration takes an
injectable `fetchImpl`.

## Error handling

- Stubbed tools (`queryDatabase`, `searchLogs`) never throw and never fake data — they return
  the typed `NOT_IMPLEMENTED` contract described above.
- Real tool failures (GitHub API errors, Brain query errors) propagate as Tool Runner's
  standard per-turn tool-error handling (`is_error: true` tool results) — the agent sees the
  failure and can factor it into evidence-sufficiency, rather than the process crashing.
- `resolveModel()` throws synchronously and early on an invalid `INVESTIGATION_AGENT_MODEL`,
  before any Anthropic API call is attempted.

## Out of scope (explicit, not silently dropped)

Per Scope Decision #1, real PostgreSQL/Datadog/PagerDuty/Slack integrations are not part of
this module. If, during implementation, wiring them in turns out to be required to actually
satisfy a Module 03 test case (rather than just "would be nice"), stop and flag it rather than
silently building a Module 02 integration while inside Module 03 — per CLAUDE.md.
