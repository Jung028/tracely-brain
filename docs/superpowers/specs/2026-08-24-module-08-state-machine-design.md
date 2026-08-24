# Module 08 — Investigation State Machine: Design

Spec: `specs/08-state-machine.md` (FR-35). Depends on module 03 (investigation-agent) and module 05
(failure-handling), both merged to `main`. Also touches module 06 (human-collaboration) and module
07 (slack-interface), both merged.

## Purpose

FR-35 requires a formally defined investigation lifecycle — states, legal transitions, failure
transitions, retry behavior, and terminal states — so every module transitions state the same,
predictable way instead of inventing its own status strings. The spec explicitly says the six
states it lists are not assumed complete, and requires the full transition diagram to be proposed
and reviewed before implementation. This document is that review.

This module also migrates module 07's placeholder 3-value `Investigation.status`
(`IN_PROGRESS | CONFIRMED | INSUFFICIENT_EVIDENCE`) to the real lifecycle — module 07's own design
doc anticipated this hand-off explicitly ("module 08 can migrate this column later without this
module having built a competing, half-guessed state graph first").

## The state diagram

Seven states. `RESOLVED` is the only true terminal state (no outgoing transitions at all).

```
CREATED
   │ BEGIN_INVESTIGATING
   ▼
INVESTIGATING ──────────────────────┐
   │ RCA_CONFIRMED                  │ INSUFFICIENT_EVIDENCE
   ▼                                ▼
RCA_IDENTIFIED                MANUAL_REVIEW_REQUIRED ◄──┐
   │              │                 │        │          │
   │ PROPOSE_     │ CLOSE_          │ REOPEN │ CLOSE_   │ RESOLUTION_
   │ RESOLUTION   │ DIRECTLY        │ (≤3x)  │ DIRECTLY │ REJECTED
   ▼              ▼                 ▼        ▼          │
RESOLUTION_PROPOSAL          INVESTIGATING  RESOLVED    │
   │              │                                     │
   │ RESOLUTION_  │                                     │
   │ APPROVED     └─────────────────────────────────────┘
   ▼
RESOLVED
```

Edges (9 total):

| From | Event | To |
|---|---|---|
| `CREATED` | `BEGIN_INVESTIGATING` | `INVESTIGATING` |
| `INVESTIGATING` | `RCA_CONFIRMED` | `RCA_IDENTIFIED` |
| `INVESTIGATING` | `INSUFFICIENT_EVIDENCE` | `MANUAL_REVIEW_REQUIRED` |
| `RCA_IDENTIFIED` | `PROPOSE_RESOLUTION` | `RESOLUTION_PROPOSAL` |
| `RCA_IDENTIFIED` | `CLOSE_DIRECTLY` | `RESOLVED` |
| `MANUAL_REVIEW_REQUIRED` | `REOPEN` (retryCount < 3) | `INVESTIGATING` |
| `MANUAL_REVIEW_REQUIRED` | `CLOSE_DIRECTLY` | `RESOLVED` |
| `RESOLUTION_PROPOSAL` | `RESOLUTION_APPROVED` | `RESOLVED` |
| `RESOLUTION_PROPOSAL` | `RESOLUTION_REJECTED` | `MANUAL_REVIEW_REQUIRED` |

Every other (state, event) pair is illegal and `transition()` rejects it with a typed error.
`RESOLVED` accepts no events at all — the terminal-state test asserts this directly.

## The spec's four open questions, answered

1. **Can `INVESTIGATING` go directly to `MANUAL_REVIEW_REQUIRED`, or only via a failed
   `RCA_IDENTIFIED` attempt?** Direct. Module 03's `investigate()` (as merged) produces exactly two
   outcomes — `CONFIRMED` or `INSUFFICIENT_EVIDENCE` — there is no intermediate "RCA attempted and
   failed" concept anywhere in the real code. `RCA_IDENTIFIED` *is* the success outcome, so the
   mapping is 1:1: `CONFIRMED → RCA_IDENTIFIED`, `INSUFFICIENT_EVIDENCE → MANUAL_REVIEW_REQUIRED`,
   both direct from `INVESTIGATING`.

2. **Is `MANUAL_REVIEW_REQUIRED` terminal, or can a human action move it back to
   `INVESTIGATING`?** Not terminal — the `REOPEN` edge exists and is enforced by this module. The
   actual *trigger* (a human providing new information mid-review) is module 06's FR-27, a SHOULD
   that is explicitly deferred and unbuilt as of this module. Per this repo's "don't build ahead of
   an unbuilt module" convention, `transition()` makes `REOPEN` legal and testable now; nothing
   calls it from a real Slack/UI action yet. That wiring is FR-27's job when it's built.

3. **What happens if `RESOLUTION_PROPOSAL` is rejected — back to `INVESTIGATING`, a new terminal
   `REJECTED` state, or something else?** Back to `MANUAL_REVIEW_REQUIRED`. A rejected proposal
   means "a human needs to decide what happens next" — exactly what `MANUAL_REVIEW_REQUIRED`
   already represents. A new `REJECTED` state would be scope creep: module 09 (remediation, not yet
   built) owns the actual approve/reject sub-workflow *inside* `RESOLUTION_PROPOSAL` per this
   module's own out-of-scope note below; the outer machine only needs to know that a rejection
   routes back to human review, not the details of why.

4. **Are there retry limits on hypothesis cycling before forcing `MANUAL_REVIEW_REQUIRED`?** Not at
   this layer — module 03's own tool-runner loop already has its own internal iteration cap,
   unrelated to this state machine. At the state-machine layer, "retry limits" means: how many
   times can an investigation be reopened (`MANUAL_REVIEW_REQUIRED → INVESTIGATING`) before the
   system refuses further reopens? **3 reopens**, tracked via a `retryCount` field on the
   `Investigation` record, incremented on each successful `REOPEN`. The 4th attempt is rejected
   with a typed error explaining the cap was hit; the investigation stays in `MANUAL_REVIEW_REQUIRED`
   (still reachable via `CLOSE_DIRECTLY`, just no longer reopenable).

## Gap found during design review: direct closure

The diagram above includes two edges (`CLOSE_DIRECTLY` from both `RCA_IDENTIFIED` and
`MANUAL_REVIEW_REQUIRED`) that are not explicitly named in the spec's six states but are structurally
necessary: without them, (a) an investigation stuck at `MANUAL_REVIEW_REQUIRED` after its 3 reopens
are exhausted has no path to `RESOLVED` at all, and (b) a `CONFIRMED` root cause that needs no
code/DML remediation (e.g. a config fix already made manually outside Tracely) is forced through
`RESOLUTION_PROPOSAL` even though there's nothing to propose. `CLOSE_DIRECTLY` is a human-initiated
"mark resolved outside the automated remediation workflow" action — no DML/PR logic, no proposal
generation, so it doesn't encroach on module 09's territory.

## Out of scope (per the spec)

- The remediation-specific sub-states inside `RESOLUTION_PROPOSAL` (DML test/approve/execute, PR
  generate/review) — module 09's own state machine, which this module's `RESOLUTION_PROPOSAL` state
  only hands off to.
- Building the actual trigger for `REOPEN` (module 06 FR-27's human-input mechanism) or for
  `PROPOSE_RESOLUTION`/`RESOLUTION_APPROVED`/`RESOLUTION_REJECTED` (module 09's approval workflow,
  not yet built) — this module makes those transitions legal and testable, not wires up their real
  callers.

## Architecture

### New module: `src/state-machine/`

Pure, no database dependency — the transition graph and its validator.

```ts
// src/state-machine/types.ts
export type InvestigationState =
  | "CREATED"
  | "INVESTIGATING"
  | "RCA_IDENTIFIED"
  | "MANUAL_REVIEW_REQUIRED"
  | "RESOLUTION_PROPOSAL"
  | "RESOLVED";

export type TransitionEvent =
  | { type: "BEGIN_INVESTIGATING" }
  | { type: "RCA_CONFIRMED" }
  | { type: "INSUFFICIENT_EVIDENCE" }
  | { type: "PROPOSE_RESOLUTION" }
  | { type: "CLOSE_DIRECTLY" }
  | { type: "REOPEN" }
  | { type: "RESOLUTION_APPROVED" }
  | { type: "RESOLUTION_REJECTED" };

export type TransitionResult =
  | { ok: true; state: InvestigationState }
  | { ok: false; error: string };
```

```ts
// src/state-machine/transition.ts
export function transition(
  current: InvestigationState,
  event: TransitionEvent,
  context: { retryCount: number },
): TransitionResult;
```

Typed-failure-surface convention (matches `src/slack/verify.ts`/`client.ts`): an illegal transition
is an expected, normal condition this function exists to reject cleanly — never a throw. `REOPEN`
specifically checks `context.retryCount < 3` before allowing `MANUAL_REVIEW_REQUIRED →
INVESTIGATING`; at the cap it returns a typed rejection naming the limit.

### `src/investigations/` changes

New wrapper functions, each calling `transition()` first — on `ok:false`, they return the typed
rejection without touching the database; only a legal transition reaches a real `UPDATE`:

```ts
export type InvestigationTransitionResult =
  | { ok: true; investigation: Investigation }
  | { ok: false; error: string };

export function beginInvestigating(id: string): Promise<InvestigationTransitionResult>;
export function completeInvestigation(
  id: string,
  outcome: { result: InvestigationResult; timeline: InvestigationTimeline },
): Promise<InvestigationTransitionResult>; // reworked: derives state via transition(), not ad-hoc mapping
export function reopenInvestigation(id: string): Promise<InvestigationTransitionResult>;
export function closeInvestigation(id: string): Promise<InvestigationTransitionResult>;
```

`RESOLUTION_PROPOSAL`'s own wrapper functions (`proposeResolution`, `rejectResolution`,
`resolveFromProposal`) are **not** built in this module — module 09 doesn't exist yet and nothing
would call them. The transition rules for those edges still live in `transition()`'s table (so the
graph is complete and testable now); the DB-wrapper functions get built when module 09 needs them.

### Migration: `migrations/0003_investigation_state_machine.sql`

- Replace the `status` CHECK constraint with the 6 new values.
- Add `retry_count integer NOT NULL DEFAULT 0`.
- Change the column default from `'IN_PROGRESS'` to `'CREATED'`.
- Data migration for existing dev rows (no real production data exists yet):
  `IN_PROGRESS → INVESTIGATING`, `CONFIRMED → RCA_IDENTIFIED`, `INSUFFICIENT_EVIDENCE →
  MANUAL_REVIEW_REQUIRED`.

### Slack visibility (added during design review, not in the original spec)

`src/slack/handler.ts`'s ack message and `src/slack/poller.ts`'s final message each append the
current lifecycle state (e.g. `"Status: INVESTIGATING"`, `"Status: RCA_IDENTIFIED"`) so the state
machine's transitions are observable live in the Slack thread, not just via tests/DB queries.
Progress-update messages (mid-investigation) are unchanged — the state doesn't change during
`INVESTIGATING` itself, only at the boundaries.

## Testing

- `tests/state-machine/transition.test.ts` — pure unit tests, no DB: all 9 legal edges tested
  individually; illegal pairs including the spec's explicit example (`CREATED → RESOLVED` directly);
  `RESOLVED` rejecting every possible event (terminal-state enforcement); the retry cap (3
  successful `REOPEN`s, 4th rejected with the cap explained).
- `tests/investigations/db.test.ts` (extended) — real-DB tests: each wrapper function persists the
  correct `status`/`retry_count` on a legal transition, and refuses to touch the row on an illegal
  one.
- `tests/slack/handler.test.ts` / `tests/slack/poller.test.ts` (extended) — the ack and final
  messages include the expected status line, using the same injected-mock pattern already
  established (no real Anthropic call).

## Documentation

`docs/state-machine.md` — the diagram above (satisfies the DoD's "diagram/table in this repo, not
just in code"), the four open-questions-answered section, the retry-cap rationale, and the
migration's data-remapping table for existing rows.
