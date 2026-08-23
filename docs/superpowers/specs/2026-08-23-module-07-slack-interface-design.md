# Module 07 — Slack Interface: Design

Spec: `specs/07-slack-interface.md`. Depends on module 03 (investigation-agent), module 04
(evidence-timeline), module 06 (human-collaboration) — all merged to `main`. This module is
"nearly all integration glue" per its own spec: it introduces no new investigation logic, only a
Slack surface, a persistent Investigation record, and wiring between the two and modules
03/04/06's existing capabilities.

## Purpose

Let an engineer start and follow an investigation entirely from Slack: FR-32 (natural-language
trigger), FR-33 (a real Investigation record, with progress posted to the thread as the
investigation proceeds — not just a final message), FR-34 (a link to the exact same timeline/
evidence view the web UI shows, no divergence).

## Why a new persistent record, and why Postgres

Nothing in the codebase today survives past a single `investigate()` call: `InvestigationState`
is a local variable, and module 06's session registry (`src/session/registry.ts`) is explicitly
in-memory and removed the moment `investigate()` resolves. FR-33 needs an id that exists *before*
the investigation starts (to reference in the immediate Slack ack) and a status/result that's
still retrievable long after it finishes (for FR-34's link, which a user may click hours later).
That's a genuinely new, persistent concept this module has to introduce.

The Company Brain (`src/brain`, Postgres via `Bun.sql`, already the project's established
persistence layer) is not the right home for it: an Investigation is Tracely's own operational
record (a job with a status and a result), not company knowledge about how systems relate to each
other — the Brain's own design note is explicit that it stores derived representations of
*source systems*, not Tracely's internal state. A new table, in the same Postgres database via
the same `sql` connection (`src/brain/db.ts`'s re-export), keeps one connection/one database for
the whole app while keeping the concept cleanly separate from the entities/relationships graph.

## Why status is a 3-value set, not module 08's full graph

Module 08 (not built, and not a declared dependency of this module) owns the real state machine
(`CREATED → INVESTIGATING → RCA_IDENTIFIED → MANUAL_REVIEW_REQUIRED → ...`). Adopting those names
now would mean guessing at transition semantics that aren't this module's spec to define — the
same "don't build ahead of a later module" discipline this repo has followed for modules 05 and
06's forward references. `IN_PROGRESS | CONFIRMED | INSUFFICIENT_EVIDENCE` mirrors module 03's own
`InvestigationResult.outcome` values exactly, so there's nothing invented — module 08 can migrate
this column later without this module having built a competing, half-guessed state graph first.

## Architecture

### New module: `src/investigations/`

The persistent Investigation record.

```sql
-- migrations/0002_investigations.sql
CREATE TABLE investigations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status               text NOT NULL DEFAULT 'IN_PROGRESS'
                         CHECK (status IN ('IN_PROGRESS', 'CONFIRMED', 'INSUFFICIENT_EVIDENCE')),
  problem_description  text NOT NULL,
  slack_channel_id     text,
  slack_thread_ts      text,
  result               jsonb,              -- { result: InvestigationResult, timeline: Timeline } once complete; NULL while IN_PROGRESS
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigations_status_idx ON investigations (status);
```

```ts
// src/investigations/types.ts
export interface Investigation {
  readonly id: string;
  readonly status: "IN_PROGRESS" | "CONFIRMED" | "INSUFFICIENT_EVIDENCE";
  readonly problemDescription: string;
  readonly slackChannelId: string | null;
  readonly slackThreadTs: string | null;
  readonly result: { result: InvestigationResult; timeline: Timeline } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
```

```ts
// src/investigations/db.ts
export function createInvestigation(input: {
  problemDescription: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}): Promise<Investigation>;

export function completeInvestigation(
  id: string,
  outcome: { result: InvestigationResult; timeline: Timeline },
): Promise<Investigation>;

export function getInvestigation(id: string): Promise<Investigation | undefined>;
```

`completeInvestigation` derives `status` from `outcome.result.outcome` (`"CONFIRMED"` →
`CONFIRMED`, `"INSUFFICIENT_EVIDENCE"` → `INSUFFICIENT_EVIDENCE`) — never a separately-tracked
value that could drift from the real result.

### New module: `src/slack/`

Everything Slack-protocol-specific. No investigation logic.

```ts
// src/slack/verify.ts
export function verifySlackSignature(
  headers: { timestamp: string; signature: string },
  rawBody: string,
  signingSecret: string,
): boolean;
```
Implements Slack's documented request-signing scheme: `v0:{timestamp}:{rawBody}` HMAC-SHA256'd
with the signing secret, compared to `X-Slack-Signature` using constant-time comparison. Also
rejects requests with a timestamp more than 5 minutes old (replay protection), per Slack's own
guidance.

```ts
// src/slack/client.ts
export interface PostMessageInput {
  channel: string;
  text: string;
  thread_ts?: string;
}
export function postMessage(
  input: PostMessageInput,
  opts?: { fetchImpl?: typeof fetch },
): Promise<{ ok: true; ts: string } | { ok: false; error: string }>;
```
Plain `fetch()` to `https://slack.com/api/chat.postMessage` with `SLACK_BOT_TOKEN`. Injectable
`fetchImpl`, matching `src/integrations/github/client.ts`'s existing test-injection pattern —
never a thrown exception for an "expected" Slack API failure (invalid channel, rate limit), same
"typed failure surface, not a throw" convention module 02 established.

```ts
// src/slack/handler.ts
export async function handleAppMention(
  event: { channel: string; thread_ts?: string; ts: string; text: string; user: string },
  botUserId: string,
): Promise<void>;
```
Strips the `<@{botUserId}>` mention prefix to get the natural-language problem text (FR-32).
Calls `createInvestigation()`, immediately `postMessage()`s an ack ("Investigating — I'll post
updates here. Full view: `<link>`"), then calls `investigate({ sessionId })` **without
awaiting it** and hands the returned promise plus the investigation id to the poller — the
handler itself returns as soon as the ack is posted, well under Slack's 3-second webhook
timeout.

```ts
// src/slack/poller.ts
export function pollAndPost(
  sessionId: string,
  investigationId: string,
  resultPromise: Promise<InvestigationResult>,
  slackTarget: { channel: string; thread_ts: string },
  opts?: { intervalMs?: number; setIntervalImpl?: typeof setInterval; clearIntervalImpl?: typeof clearInterval },
): Promise<void>;
```
Polls `getInvestigationState(sessionId)` on the injectable interval (default a small real value;
tests inject a fake timer or call the tick logic directly — mirrors module 06's testing approach
of driving state transitions deterministically rather than depending on real elapsed time).
Posts a thread message only when `stepNumber` has advanced since the last post (no duplicate
"nothing new happened" spam). When `resultPromise` resolves, stops polling, calls
`completeInvestigation()`, and posts the final message: the RCA statement if `CONFIRMED`, or
`renderFailureReport(buildFailureReport(result))`'s text if `INSUFFICIENT_EVIDENCE` — plus the
timeline link either way. If a progress-update `postMessage` call itself fails (Slack API error,
already a typed `{ok: false}` per `client.ts` above, never a throw), the poller logs it and keeps
polling on the next tick rather than stopping — a single missed progress post shouldn't abort the
investigation or the final result post.

### Extending `src/timeline/server.ts` (not a second server)

Two new routes added to the existing `Bun.serve()` `routes` config — this is what makes FR-34's
"no divergence between what Slack shows and what the full UI shows" a structural guarantee, not a
promise: the Slack-surfaced link hits the exact same `buildTimeline()` call the web UI's own
routes already use.

- `POST /slack/events` — verifies the signature via `verifySlackSignature`; handles Slack's
  `url_verification` challenge (required once, when the app is first configured) by echoing the
  `challenge` field; for a real `event_callback` with `event.type === "app_mention"`, calls
  `handleAppMention` and responds `200` immediately (Slack requires an ack regardless of how long
  the underlying work takes — this route never awaits the investigation itself).
- `GET /api/timeline/:id` — `getInvestigation(id)`; `404` if not found; if `status ===
  "IN_PROGRESS"`, returns `{ status: "IN_PROGRESS" }` (no timeline yet — the record exists but
  the result doesn't); otherwise returns the stored `{ result, timeline }` exactly as
  `completeInvestigation` saved it.

## Environment variables

`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` — added to `.env.example` following the existing
`GITHUB_TOKEN`/`ANTHROPIC_API_KEY` convention. `not_connected`-style behavior (a clear failure,
not a crash) when `SLACK_SIGNING_SECRET` is unset: `verifySlackSignature` returns `false`
unconditionally, so `/slack/events` rejects everything with `401` until it's configured — same
"typed failure over crash" pattern as module 02's `ConnectionFailure`.

## Out of scope (unchanged from spec)

- Any investigation logic — this module only orchestrates calls into modules 03/04/06.
- Module 08's real state machine.
- Module 12's actor identity/OAuth — per module 12's own spec, Slack workspace membership is
  already treated as sufficient authorization for FR-32; this module adds no new auth barrier and
  does not implement account linking (that's module 12's FR-44, a SHOULD, explicitly deferred).
- NFR-14's uptime target — not invented; out of scope per the spec.

## Testing

- `src/investigations/db.ts` — real-DB tests (same pattern as `src/brain`'s test suite):
  create → get round-trip, `completeInvestigation` derives the correct status from each outcome
  type, `getInvestigation` on an unknown id returns `undefined`.
- `src/slack/verify.ts` — unit tests with a fixed signing secret and hand-computed signature:
  valid signature accepted, tampered body rejected, stale timestamp rejected.
- `src/slack/client.ts` — injectable-fetch tests, same shape as the GitHub client's tests: success
  response, Slack API error response (`{ok: false}`), network failure — all typed, never thrown.
- `src/slack/handler.ts` — an app_mention event with a mocked `investigate()` (injectable, same
  pattern as `InvestigateOptions.client`) and mocked `postMessage` proves: an Investigation record
  is created before the ack posts, the ack posts before `investigate()` resolves (proving the
  handler doesn't block on it), and the mention prefix is correctly stripped from the problem
  text.
- `src/slack/poller.ts` — an injected fake interval (a manually-triggerable tick function instead
  of real `setInterval`) plus a scripted `getInvestigationState` sequence proves: a thread update
  posts only when `stepNumber` advances, no duplicate posts on an unchanged read, and the final
  message + `completeInvestigation` call happen exactly once, after the result promise resolves.
- `src/timeline/server.ts`'s two new routes — real HTTP tests via `createServer(0)` (existing
  pattern from `tests/timeline/server.test.ts`): `/slack/events` rejects an unsigned/badly-signed
  request with `401`, accepts a `url_verification` challenge, and dispatches a valid
  `app_mention` event; `/api/timeline/:id` returns `404` for an unknown id, `IN_PROGRESS` status
  for a real in-progress investigation, and the exact stored timeline for a completed one.
