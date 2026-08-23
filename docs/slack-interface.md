# Slack Interface — Investigation Lifecycle (FR-32, FR-33, FR-34)

This documents module 07: the Slack-facing layer that connects production incidents (Slack mentions) to investigations, posts progress updates while investigation runs, and persists results for reference long after the investigation completes. Three user-facing requirements flow through this module:

- **FR-32** — Slack mention → Investigation starts
- **FR-33** — Progress posts as investigation proceeds (stepNumber advances), not just a final message
- **FR-34** — Persistent investigation link for asynchronous review

## Persistent Investigation Record

The `Investigation` record (created by FR-32, updated by FR-33/34) persists indefinitely in Postgres, unlike the ephemeral in-memory session registry (module 06). It contains:

```ts
interface Investigation {
  readonly id: string;
  readonly status: "IN_PROGRESS" | "CONFIRMED" | "INSUFFICIENT_EVIDENCE";
  readonly problemDescription: string;
  readonly slackChannelId: string | null;
  readonly slackThreadTs: string | null;
  readonly result: { result: InvestigationResult; timeline: InvestigationTimeline } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
```

Signatures below are copied from `src/investigations/db.ts` — keep this file in sync if those signatures change.

### `createInvestigation`

```ts
async function createInvestigation(input: {
  problemDescription: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}): Promise<Investigation>;
```

- Creates a new record with `status: "IN_PROGRESS"`, `result: null`.
- Returns the newly created `Investigation` with a generated UUID `id`.
- Called by `handleAppMention` (see below) as the first step of FR-32.

### `completeInvestigation`

```ts
async function completeInvestigation(
  id: string,
  outcome: { result: InvestigationResult; timeline: InvestigationTimeline },
): Promise<Investigation>;
```

- Persists the investigation's final result and timeline.
- Sets `status: "CONFIRMED"` if `result.outcome === "CONFIRMED"`, otherwise `"INSUFFICIENT_EVIDENCE"`.
- Called by `pollAndPost` after `investigate()` resolves (see "The Call Sequence" below).

### `getInvestigation`

```ts
async function getInvestigation(id: string): Promise<Investigation | undefined>;
```

- Retrieves a persisted investigation by UUID. Returns `undefined` if the ID doesn't exist or is malformed.
- Used by the `GET /api/timeline/:id` route to serve FR-34's persistent link.

---

## Slack Verification and Messaging

### `verifySlackSignature`

```ts
function verifySlackSignature(params: {
  timestamp: string;
  signature: string;
  rawBody: string;
  signingSecret: string;
}): boolean;
```

Signatures below are copied from `src/slack/verify.ts` — keep this file in sync if the signature changes.

- Verifies Slack's request-signing scheme: HMAC-SHA256 of `"v0:{timestamp}:{rawBody}"` using the app's signing secret, compared against the `X-Slack-Signature` header with constant-time comparison.
- Enforces a 5-minute timestamp window (replay protection), per Slack's own guidance.
- **Never throws** — every invalid input (bad secret, malformed timestamp, tampered body) resolves to `false`.

### `postMessage`

```ts
async function postMessage(
  input: PostMessageInput,
  opts?: SlackFetchOptions,
): Promise<PostMessageResult>;

interface PostMessageInput {
  channel: string;
  text: string;
  thread_ts?: string;
}

type PostMessageResult = { ok: true; ts: string } | { ok: false; error: string };
```

Signatures below are copied from `src/slack/client.ts` — keep this file in sync if those signatures change.

- Calls Slack's `chat.postMessage` API endpoint with the given `channel`, `text`, and optional `thread_ts` (for threaded replies).
- Returns `{ ok: true; ts: string }` on success (ts is the message timestamp).
- Returns `{ ok: false; error: string }` on failure — including the readable token-missing case (`error: "not_connected"`) when `SLACK_BOT_TOKEN` is not set or empty.
- Never throws for expected failures (HTTP errors, API errors, missing token); follows the same typed failure surface as `src/integrations/github/client.ts`.
- Optional `opts.fetchImpl` allows test injection.

---

## Slack Event Handling

### `handleAppMention`

```ts
async function handleAppMention(
  event: AppMentionEvent,
  opts: HandleAppMentionOptions = {},
): Promise<void>;

interface AppMentionEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

interface HandleAppMentionOptions {
  investigateImpl?: (problem: string, options?: InvestigateOptions) => Promise<InvestigationResult>;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}
```

Signatures below are copied from `src/slack/handler.ts` — keep this file in sync if those signatures change.

- Implements FR-32: receives a Slack `app_mention` event and starts an investigation.
- **Orchestrates, does not investigate** — no investigation logic here, only:
  1. Strip the leading `<@BOT_ID>` mention token from the event text.
  2. Call `createInvestigation({ problemDescription, slackChannelId: event.channel, slackThreadTs })` to persist the record.
  3. Post an immediate acknowledgment to the thread: `"Investigating — I'll post updates here. Full view: <link>"`
  4. Call `investigateImpl(problemDescription, { sessionId: investigation.id })` without awaiting it — starts the long-running investigation.
  5. Hand off to `pollAndPost` (see below) with the promise, so progress posts and final result are handled asynchronously.
- Returns immediately after the ack post; the investigation runs in the background.
- Thread target (`thread_ts`) defaults to the event's own timestamp if not a reply (so all discussion stays in one thread).
- Optional injection points for testing: `investigateImpl`, `postMessageImpl`, `baseUrl` (default `http://localhost:4300`).

---

## Progress and Completion Posting

### `pollAndPost`

```ts
async function pollAndPost(
  sessionId: string,
  investigationId: string,
  resultPromise: Promise<InvestigationResult>,
  slackTarget: { channel: string; thread_ts: string },
  opts: PollAndPostOptions = {},
): Promise<void>;

interface PollAndPostOptions {
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}
```

Signatures below are copied from `src/slack/poller.ts` — keep this file in sync if those signatures change.

Implements FR-33 (progress) and the result-posting half of FR-34:

1. **Polls for progress** — every `intervalMs` (default 4000ms), calls `getInvestigationState(sessionId)` from module 06's registry:
   - If it returns undefined (investigation already resolved), skip polling — the final post below handles it.
   - If `snapshot.stepNumber` has advanced, post a progress update: `"Still investigating… (N steps so far, M hypotheses under consideration)"`.
   - Logs polling failures (non-blocking; the investigation continues regardless).

2. **Awaits result** — waits for `resultPromise` to resolve (the `investigate()` call from `handleAppMention`).

3. **Persists** — calls `completeInvestigation(investigationId, { result, timeline })` to save the final investigation state.

4. **Posts final message** — constructs and posts the result:
   - If `result.outcome === "CONFIRMED"`: `"✅ Root cause confirmed: <result.rca>\nFull view: <link>"`
   - Otherwise: renders the failure report (see `docs/failure-handling.md`), appended with `"\nFull view: <link>"`.

- Optional injection points for testing: `intervalMs`, `setIntervalImpl`, `clearIntervalImpl`, `postMessageImpl`, `baseUrl`.

---

## New Routes on the Timeline Server

Signatures copied from `src/timeline/server.ts` — keep this file in sync if those routes change.

### `POST /slack/events`

```
POST /slack/events
Headers:
  x-slack-request-timestamp: <timestamp>
  x-slack-signature: v0=<hex>
Body: JSON payload from Slack
```

- Slack event subscription endpoint (FR-32's entry point).
- Verifies the request signature using `verifySlackSignature`.
- Returns `401 Unauthorized` if verification fails.
- Parses the JSON body; returns `400 Bad Request` if malformed.
- Handles `url_verification` challenge (Slack's one-time validation).
- For `event_callback` with `event.type === "app_mention"`, calls `handleAppMention` without awaiting (Slack requires a fast ack; investigation runs async).
- Returns `200 OK` immediately; the investigation and all posting happens asynchronously.

### `GET /api/timeline/:id`

```
GET /api/timeline/:id
Returns: InvestigationTimeline (or 404 if not found / still in progress)
```

- FR-34's persistent link endpoint.
- Retrieves the investigation by `:id` using `getInvestigation`.
- Returns `404 Not Found` if the investigation doesn't exist, is still `IN_PROGRESS`, or has no result.
- Returns `200 OK` with the `investigation.result.timeline` on success (an `InvestigationTimeline`; see `docs/DATA-MODEL.md`).

---

## Environment Variables

```
SLACK_SIGNING_SECRET=<32-char hex string or similar, from Slack app config>
SLACK_BOT_TOKEN=<xoxb-... token, from Slack app config>
```

- **`SLACK_SIGNING_SECRET`** — used by `verifySlackSignature` to validate incoming webhook payloads. If missing or empty, all webhook requests are rejected (`verifySlackSignature` returns `false`).
- **`SLACK_BOT_TOKEN`** — OAuth token used by `postMessage` to authenticate calls to Slack's `chat.postMessage` API. If missing or empty, posting returns `{ ok: false, error: "not_connected" }`.

---

## The Call Sequence: FR-32/33/34 Flow

A Slack mention (`@bot-name what is this error?`) triggers:

1. **Slack webhook delivery** → `POST /slack/events` with `x-slack-request-timestamp` and `x-slack-signature` headers and a JSON body.

2. **Route handler** verifies signature → calls `handleAppMention(event)` without awaiting.

3. **`handleAppMention`**:
   - Calls `createInvestigation({ problemDescription, slackChannelId, slackThreadTs })` → persists record with `status: "IN_PROGRESS"` and a new UUID.
   - Posts ack message to the thread: `"Investigating — I'll post updates here."`
   - Calls `investigate(problemDescription, { sessionId: investigation.id })` — starts the investigation (not awaited).
   - Calls `pollAndPost(investigation.id, investigation.id, resultPromise, { channel, thread_ts })` — hands off to async polling/posting loop (not awaited).
   - Returns immediately.

4. **`pollAndPost` (runs in background)**:
   - Polls `getInvestigationState(sessionId)` every 4 seconds.
   - Each time `stepNumber` advances, posts: `"Still investigating… (N steps, M hypotheses)"`
   - Awaits `resultPromise` (the `investigate()` call).
   - Calls `completeInvestigation(investigationId, { result, timeline })` to persist the result.
   - Posts the final message (confirmed RCA or failure report).

5. **User clicks FR-34 link** (`/?investigation=<id>`) — UI fetches `GET /api/timeline/:id`, which calls `getInvestigation(id)` and returns the persisted timeline for rendering.

---

## Known Limitations

- **Poller only reflects `stepNumber`, not current tool** — progress posts show step count and hypothesis count, but not *which* tool is currently running. A richer per-step Slack narration (e.g., "querying Database…" or "analyzing Code…") would need module 04's full `ToolCallRecord` detail surfaced live. Module 07 consumes only the existing `getInvestigationState` snapshot shape (which predates module 04), so this is a scope boundary, not a bug. A future iteration could extend the snapshot to include the current tool name if needed.

---

## Test Coverage

- `tests/slack/verify.test.ts` — signature verification against Slack's documented scheme, replay-attack window enforcement, constant-time comparison.
- `tests/slack/client.test.ts` — API calls with and without token, malformed responses, fetch implementation injection.
- `tests/slack/handler.test.ts` — app_mention event parsing, investigation creation, message posting, thread routing.
- `tests/slack/poller.test.ts` — polling intervals, progress posts on stepNumber advance, final result persistence, failure report rendering.
- `tests/timeline/slack-routes.test.ts` — `POST /slack/events` signature verification, challenge response, event routing; `GET /api/timeline/:id` retrieval and 404 cases.
