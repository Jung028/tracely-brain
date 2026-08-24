# Investigation State Machine (FR-35)

Formalizes the investigation lifecycle so every module transitions state the same, predictable
way. See `src/state-machine/` for the implementation and `docs/superpowers/specs/2026-08-24-module-08-state-machine-design.md`
for the full design rationale.

## The state diagram

Six states. `RESOLVED` is the only true terminal state — it accepts no events at all.

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

Every other `(state, event)` pair is illegal and `transition()` rejects it with a typed
`{ok:false, error}` result — never a throw.

## The spec's four open questions, answered

1. **Direct `INVESTIGATING → MANUAL_REVIEW_REQUIRED`, not only via a failed RCA attempt.** Module
   03's `investigate()` produces exactly two outcomes (`CONFIRMED`/`INSUFFICIENT_EVIDENCE`) — there
   is no intermediate "attempted RCA that failed" state in the real code.
2. **`MANUAL_REVIEW_REQUIRED` is not terminal.** The `REOPEN` edge exists and is enforced. Its real
   trigger (a human adding new information mid-review) is module 06's FR-27, a SHOULD that remains
   unbuilt — this module makes the transition legal and testable, not wired to a live trigger yet.
3. **A rejected `RESOLUTION_PROPOSAL` routes back to `MANUAL_REVIEW_REQUIRED`**, not a new
   `REJECTED` state — rejection means "a human needs to decide what happens next," which
   `MANUAL_REVIEW_REQUIRED` already represents. Module 09 (not built) owns the actual
   approve/reject sub-workflow inside `RESOLUTION_PROPOSAL`.
4. **Reopen retry cap: 3.** Tracked via `retryCount` on the `Investigation` record, incremented on
   each successful `REOPEN`. The 4th attempt is rejected with a typed error naming the cap; the
   investigation stays in `MANUAL_REVIEW_REQUIRED` (still reachable via `CLOSE_DIRECTLY`).

## Direct closure (`CLOSE_DIRECTLY`)

Added during design review, not named in the spec's original six states: a human-initiated "mark
resolved outside the automated remediation workflow" action, available from both `RCA_IDENTIFIED`
and `MANUAL_REVIEW_REQUIRED`. Without it, an investigation stuck at `MANUAL_REVIEW_REQUIRED` after
its 3 reopens are exhausted would have no path to `RESOLVED`, and a confirmed root cause needing no
code/DML remediation would be forced through `RESOLUTION_PROPOSAL` for no reason.

## Migration and existing data

`migrations/0003_investigation_state_machine.sql` remaps module 07's original 3-value status
(dev data only, no production users existed at the time) to the new lifecycle:

| Old value | New value |
|---|---|
| `IN_PROGRESS` | `INVESTIGATING` |
| `CONFIRMED` | `RCA_IDENTIFIED` |
| `INSUFFICIENT_EVIDENCE` | `MANUAL_REVIEW_REQUIRED` |

The column default also changed from `IN_PROGRESS` to `CREATED` — a freshly created `Investigation`
now genuinely starts in `CREATED` and only enters `INVESTIGATING` once `beginInvestigating()` is
called.

## Slack visibility

`src/slack/handler.ts`'s ack message and `src/slack/poller.ts`'s final message each include a
`Status: <state>` line, so the lifecycle's transitions are observable live in the Slack thread —
not just via tests or a direct database query. Mid-investigation progress updates are unchanged;
the state doesn't change during `INVESTIGATING` itself, only at its boundaries.

## What this module does not build

- `RESOLUTION_PROPOSAL`'s own DB wrapper functions (`proposeResolution`, `rejectResolution`,
  `resolveFromProposal`) — module 09 doesn't exist yet, so nothing calls them. The transition
  rules for those two edges exist and are tested in `src/state-machine/transition.ts`; the DB
  wrappers are module 09's job to add when it needs them.
- A live trigger for `REOPEN` — module 06's FR-27 (unbuilt) owns accepting human input
  mid-investigation; this module only makes the resulting transition legal.

## Testing

- `tests/state-machine/transition.test.ts` — pure unit tests, no database: every legal edge, the
  spec's explicit illegal example, `RESOLVED` rejecting every possible event, and the retry cap
  (allowed at 0/1/2, rejected at 3).
- `tests/investigations/db.test.ts` — real-database tests: each wrapper function persists the
  correct `status`/`retry_count` on a legal transition and refuses to touch the row on an illegal
  one.
- `tests/slack/handler.test.ts` / `tests/slack/poller.test.ts` — the ack and final messages
  include the expected `Status: ...` line, using this module's established injected-mock pattern
  (no test ever triggers a real `investigate()`/Anthropic API call).
