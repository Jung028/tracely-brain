# Module 06 — Human Collaboration: Design

Spec: `specs/06-human-collaboration.md`. Depends on module 03 (investigation-agent, merged to
main). This design covers **FR-28 only** (MUST — live investigation-state visibility); FR-27
(SHOULD — mid-investigation human hint injection) is explicitly deferred, per the spec's own
"do not let this block later modules if it slips; flag it and move on" instruction.

## Purpose

Let an engineer observe an in-progress investigation's current hypotheses as it happens, instead
of only receiving a final report once `investigate()` resolves.

## Why FR-27 is deferred, not built

FR-27 needs a way to inject a new message into the Anthropic tool-runner's request/execute loop
*while it's already running* — the loop is driven internally by `client.beta.messages.toolRunner`
inside `investigate()`, and there's no documented hook for injecting an out-of-band user message
mid-loop today. Solving that is a genuinely open design question (a pending-hints queue that a
tool surfaces to the model on its next turn is one candidate, but needs its own investigation into
how the model would reliably notice and act on it) — not something to bolt on as a side effect of
building the state-visibility mechanism below. Building FR-28's session model first gives FR-27 a
foundation (a registered per-investigation session) to build on as a focused follow-up.

## Current state (what exists today, module 03)

- `investigate()` (`src/agent/investigate.ts`) is a single `async function` that creates local
  `InvestigationState` (`src/agent/tools.ts`: `{ hypotheses: Hypothesis[] }`), passes it into the
  tools the model calls, `await`s `client.beta.messages.toolRunner(...)` to completion, and only
  then returns an `InvestigationResult`. `state` is a plain closure variable — nothing outside
  `investigate()`'s own call can read it while the loop is running.
- Nothing tracks a notion of "current step" — `InvestigationState` has no counter or log of what's
  happened so far, just the current hypotheses array (each hypothesis carries its own evidence,
  but there's no run-level progress indicator).

## Architecture

### New module: `src/session/`

An in-memory, poll-based session registry — the interface a future caller (a web/Slack layer, not
built by this module — that's `07-slack-interface.md`) uses to observe a running investigation.

```ts
// src/session/types.ts
export interface LiveInvestigationState {
  readonly sessionId: string;
  readonly status: "IN_PROGRESS";
  readonly stepNumber: number;
  readonly hypotheses: readonly Hypothesis[];
}
```

```ts
// src/session/registry.ts
export function registerSession(sessionId: string, state: InvestigationState): void;
export function unregisterSession(sessionId: string): void;
export function getInvestigationState(sessionId: string): LiveInvestigationState | undefined;
```

- `registerSession` throws if `sessionId` is already registered — catches accidental id reuse
  (e.g. two investigations started with the same caller-supplied id) rather than silently letting
  one investigation's state overwrite/cross-talk with another's in the registry.
- `getInvestigationState` returns a **defensive snapshot copy** — `hypotheses: [...state.hypotheses]`
  — not a live reference into the mutable `InvestigationState` object. A caller reading this
  cannot accidentally mutate an in-progress investigation's real state; every call returns a fresh
  copy of whatever is true *at that instant*.
- Entries live only while the investigation is running. Once `investigate()` resolves (success or
  throw), its entry is removed. `getInvestigationState` returning `undefined` is the documented
  signal "this session isn't running — check the `InvestigationResult` you're awaiting instead,"
  not an error state a caller needs to distinguish from "never existed."

### `src/agent/tools.ts` changes

`InvestigationState` gains one field:

```ts
export interface InvestigationState {
  hypotheses: Hypothesis[];
  stepNumber: number; // new
}
```

`createInvestigationState()` initializes it to `0`. A small wrapper, `withStep(state, run)`,
wraps each of the six tools' `run` functions so `stepNumber` increments exactly once per tool
execution, regardless of which tool — one shared helper instead of repeating
`state.stepNumber++` at the top of all six handlers.

### `src/agent/investigate.ts` changes

```ts
export interface InvestigateOptions {
  client?: Anthropic;
  maxIterations?: number;
  sessionId?: string; // new
}
```

If `sessionId` is provided, `investigate()` calls `registerSession(sessionId, state)` immediately
after `createInvestigationState()`, and `unregisterSession(sessionId)` in a `finally` block
wrapping the `toolRunner` call and result construction — guaranteed cleanup whether the
investigation completes normally or throws. No `sessionId` → behavior is byte-for-byte identical
to today; every existing caller and test is unaffected.

## Data flow

1. Caller generates a `sessionId` (its own concern — e.g. `crypto.randomUUID()`, or an id tied to
   an existing incident ticket) and calls `investigate(problem, { sessionId })`.
2. `investigate()` registers `state` under that id, then starts the tool-runner loop.
3. As the model calls tools, `withStep` increments `stepNumber`; `propose_hypothesis`/
   `update_hypothesis` mutate `state.hypotheses` exactly as they do today (unchanged logic).
4. At any point before the promise resolves, any code with the `sessionId` can call
   `getInvestigationState(sessionId)` and get a current snapshot — this works because JS's
   single-threaded event loop yields at `toolRunner`'s internal `await` points (e.g. between
   model turns), so a separate call on the same event loop can run and read the registry in that
   gap.
5. On completion, the registry entry is removed; the caller's original `await investigate(...)`
   resolves with the final `InvestigationResult` as it always has.

## Testing

- `tests/session/registry.test.ts` — unit tests against the registry directly: register/get/
  unregister, double-registration throws, snapshot returned is not the same array reference as
  the live state (mutating the snapshot doesn't affect the registered state).
- `tests/session/live-state.test.ts` — runs `investigate()` end-to-end with a scripted mock
  Anthropic client (same `createStepFunctionClient` helper existing agent tests use). The mock's
  step-function callback fires between turns, *after* the previous turn's tool calls have already
  mutated `state` — calling `getInvestigationState(sessionId)` from inside that callback proves
  state is genuinely observable from outside `investigate()`'s own closure while it's still
  running, not just inspectable after the fact. Also asserts the entry is gone once the awaited
  call resolves.
- Existing `tests/agent/*` test files are unaffected — no `sessionId` passed, so nothing new fires
  for them; a full suite run confirms zero regressions.

## Out of scope (unchanged from spec)

- FR-27 (deferred — see above).
- The Slack/web surface that would actually call `getInvestigationState` in production
  (`07-slack-interface.md`).
