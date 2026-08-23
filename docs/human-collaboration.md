# Human Collaboration — Live Investigation State (FR-28)

This documents module 06's FR-28 implementation: making an in-progress investigation's current
step and hypotheses observable while `investigate()` (module 03) is still running, instead of
only after it resolves. **FR-27 (mid-investigation hint injection) is explicitly deferred** — see
"FR-27: deferred" below.

Signatures below are copied from `src/session/registry.ts`, `src/session/types.ts`, and
`src/agent/investigate.ts` — keep this file in sync with those if the signatures change.

## Import

```ts
import { getInvestigationState } from "../session"; // src/session/index.ts
```

## Usage

```ts
import { investigate } from "../agent/investigate";
import { getInvestigationState } from "../session";

const sessionId = crypto.randomUUID();

// Start the investigation without awaiting it yet, so it can be polled
// while running:
const resultPromise = investigate("Elevated error rate", { sessionId });

// Elsewhere (a separate request handler, a polling loop, etc.) — any code
// that has the sessionId can read the current state at any point before
// resultPromise resolves:
const snapshot = getInvestigationState(sessionId);
if (snapshot) {
  console.log(`step ${snapshot.stepNumber}, ${snapshot.hypotheses.length} hypotheses so far`);
}

const result = await resultPromise; // the authoritative final InvestigationResult
```

## `getInvestigationState`

```ts
function getInvestigationState(sessionId: string): LiveInvestigationState | undefined;

interface LiveInvestigationState {
  readonly sessionId: string;
  readonly status: "IN_PROGRESS";
  readonly stepNumber: number;
  readonly hypotheses: readonly Hypothesis[];
}
```

- Returns `undefined` if `sessionId` was never registered, **or** if the investigation it belonged
  to has already completed. These two cases are intentionally indistinguishable here — once you
  have a session's final answer (the `InvestigationResult` your `investigate()` call resolved
  with), the registry no longer has anything useful to add. `undefined` means "stop polling this
  id and use the result you're awaiting instead," not an error you need to handle specially.
- Every call returns a **fresh, defensive snapshot copy** — `hypotheses` is a new array on every
  call, not a live reference into the investigation's real internal state. Mutating a returned
  snapshot has no effect on the running investigation.
- `stepNumber` increments by exactly 1 each time any tool executes (`query_brain`, `search_code`,
  `query_database`, `search_logs`, `propose_hypothesis`, or `update_hypothesis`) — a coarse but
  real, non-fabricated progress indicator (`src/agent/tools.ts`'s `withStep` wrapper).

## Registering a session

```ts
investigate(problemDescription, { sessionId: "some-id", ...otherOptions });
```

- The **caller** generates and owns the `sessionId` (e.g. `crypto.randomUUID()`, or an id tied to
  an existing incident ticket) — `investigate()` never generates one itself. This is what lets a
  caller have the id in hand *before* `investigate()` resolves, so it has something to poll with.
- Passing no `sessionId` is a complete no-op for this feature: no registration happens, and
  `investigate()`'s behavior, return value, and performance are identical to module 03's original
  implementation. Every existing caller is unaffected.
- Registering the same `sessionId` twice (e.g. a bug that reuses an id, or two investigations
  racing on one id) throws immediately from `registerSession` — this is deliberate: silently
  letting two investigations share one registry slot would produce a snapshot that's a
  cross-talked mix of both, which is worse than a loud failure.
- The registry entry is always removed when `investigate()` finishes — success or throw — via a
  `finally` block. There is no persistence beyond the process's lifetime; this is in-memory only.

## FR-27: deferred

FR-27 (an engineer injecting a hint like "I think the config changed yesterday" mid-investigation,
with the agent incorporating it as evidence attributed to the human) is a SHOULD requirement the
spec explicitly allows deferring rather than blocking later modules. It needs a way to get a new
message into the Anthropic tool-runner's request/execute loop *while that loop is already
running* — there's no documented hook for that today, and designing one (e.g. a pending-hints
queue a tool surfaces to the model on its next turn) is a genuinely open question, not a
side-effect of the state-visibility work here. See
`docs/superpowers/specs/2026-08-23-module-06-human-collaboration-design.md` for the full
rationale. This module's session registry gives a future FR-27 implementation a foundation
(a registered per-investigation session) to build on.
