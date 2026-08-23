# Module 07 — Slack Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an engineer start and follow an investigation entirely from Slack (FR-32/33/34) by
introducing a persistent Investigation record and Slack-protocol glue on top of modules 03/04/06's
existing capabilities — no new investigation logic.

**Architecture:** A new `investigations` Postgres table (via the existing `Bun.sql` connection)
gives every investigation a durable id/status/result. A new `src/slack/` module verifies Slack's
request signatures, posts messages via `chat.postMessage`, and orchestrates: on an `app_mention`,
create the record, ack immediately, kick off `investigate({sessionId})` without blocking, then an
interval poller watches `getInvestigationState` and posts progress until the result resolves. Two
new routes on the existing `src/timeline/server.ts` `Bun.serve()` app (not a second server) wire
Slack into the same `buildTimeline()` path the web UI already uses.

**Tech Stack:** TypeScript, Bun (`Bun.sql`, `Bun.serve()`), `bun:test`, `node:crypto` (HMAC
verification), no new npm dependencies.

**Spec:** `specs/07-slack-interface.md`. Design: `docs/superpowers/specs/2026-08-23-module-07-slack-interface-design.md`.

## Global Constraints

- No investigation logic in this module — it only orchestrates calls into modules 03/04/06. If a
  task seems to require deciding something about hypothesis confidence, evidence, or the timeline
  data model, stop — that belongs to an earlier module.
- `investigations.status` is exactly `IN_PROGRESS | CONFIRMED | INSUFFICIENT_EVIDENCE` — module
  08's real state machine is out of scope; do not invent additional status values.
- Every Slack API interaction (`postMessage`) uses a typed failure surface
  (`{ok: false, error: string}`), never a thrown exception for an expected failure — matches
  `src/integrations/github/client.ts`'s established convention in this repo.
- `/slack/events` must reject any request that fails signature verification with `401` before
  touching the payload — signature verification runs on the raw request body, before JSON parsing.
- No invented numbers: `NFR-14` (Slack uptime target) is explicitly TBD and out of scope; do not
  add a fabricated SLA/uptime figure anywhere in code, docs, or comments.
- `/slack/events` must always return within Slack's ack window — never `await` the investigation
  itself in the request handler.

---

### Task 1: Investigations table + `src/investigations/`

**Files:**
- Create: `migrations/0002_investigations.sql`
- Create: `src/investigations/types.ts`
- Create: `src/investigations/db.ts`
- Create: `src/investigations/index.ts`
- Modify: `tests/db-helpers.ts` (add `investigations` to `truncateAll`'s TRUNCATE list)
- Test: `tests/investigations/db.test.ts`

**Interfaces:**
- Consumes: `sql` from `src/brain/db.ts` (existing `Bun.sql` re-export), `InvestigationResult`
  from `src/agent/types.ts`, `InvestigationTimeline` from `src/timeline/types.ts`.
- Produces: `Investigation` type, `createInvestigation(input)`, `completeInvestigation(id, outcome)`,
  `getInvestigation(id)` — all exported from `src/investigations/index.ts`. Tasks 4 and 5 import
  from this barrel.

- [ ] **Step 1: Write the failing test**

Create `tests/investigations/db.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { completeInvestigation, createInvestigation, getInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { InvestigationTimeline } from "../../src/timeline/types";

afterEach(async () => {
  await truncateAll();
});

describe("createInvestigation", () => {
  test("creates a record with status IN_PROGRESS and no result yet", async () => {
    const investigation = await createInvestigation({
      problemDescription: "Elevated error rate starting at 14:03",
      slackChannelId: "C123",
      slackThreadTs: "1700000000.000100",
    });

    expect(investigation.id).toBeTruthy();
    expect(investigation.status).toBe("IN_PROGRESS");
    expect(investigation.problemDescription).toBe("Elevated error rate starting at 14:03");
    expect(investigation.slackChannelId).toBe("C123");
    expect(investigation.slackThreadTs).toBe("1700000000.000100");
    expect(investigation.result).toBeNull();
  });

  test("slackChannelId/slackThreadTs are optional", async () => {
    const investigation = await createInvestigation({ problemDescription: "test problem" });

    expect(investigation.slackChannelId).toBeNull();
    expect(investigation.slackThreadTs).toBeNull();
  });
});

describe("getInvestigation", () => {
  test("round-trips a created investigation", async () => {
    const created = await createInvestigation({ problemDescription: "round trip test" });
    const fetched = await getInvestigation(created.id);

    expect(fetched).toEqual(created);
  });

  test("returns undefined for an id that doesn't exist", async () => {
    const fetched = await getInvestigation("00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeUndefined();
  });

  test("returns undefined for a malformed id, without throwing", async () => {
    const fetched = await getInvestigation("not-a-uuid");
    expect(fetched).toBeUndefined();
  });
});

describe("completeInvestigation", () => {
  const fakeTimeline: InvestigationTimeline = { steps: [] };

  test("CONFIRMED outcome sets status CONFIRMED and stores the result", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    const result: InvestigationResult = {
      outcome: "CONFIRMED",
      hypothesis: {
        id: "h1",
        statement: "Scheduler is disabled",
        supportingEvidence: [],
        contradictingEvidence: [],
        status: "CONFIRMED",
        confidence: 0.8,
      },
      rca: "Scheduler is disabled",
      evidenceTrail: [],
      toolCalls: [],
    };

    const completed = await completeInvestigation(created.id, { result, timeline: fakeTimeline });

    expect(completed.status).toBe("CONFIRMED");
    expect(completed.result).toEqual({ result, timeline: fakeTimeline });
  });

  test("INSUFFICIENT_EVIDENCE outcome sets status INSUFFICIENT_EVIDENCE", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    };

    const completed = await completeInvestigation(created.id, { result, timeline: fakeTimeline });

    expect(completed.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  test("throws for an id that doesn't exist", async () => {
    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    };

    await expect(
      completeInvestigation("00000000-0000-0000-0000-000000000000", { result, timeline: fakeTimeline }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/investigations/db.test.ts`
Expected: FAIL — `../../src/investigations` module does not exist (import error).

- [ ] **Step 3: Write minimal implementation**

Create `migrations/0002_investigations.sql`:

```sql
CREATE TABLE investigations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status               text NOT NULL DEFAULT 'IN_PROGRESS'
                         CHECK (status IN ('IN_PROGRESS', 'CONFIRMED', 'INSUFFICIENT_EVIDENCE')),
  problem_description  text NOT NULL,
  slack_channel_id     text,
  slack_thread_ts      text,
  result               jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigations_status_idx ON investigations (status);
```

Create `src/investigations/types.ts`:

```ts
// The persistent Investigation record (FR-33). Unlike src/session's
// in-memory registry (removed the moment investigate() resolves), this
// survives indefinitely — FR-34's link may be clicked long after the
// investigation finishes.
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";

export interface Investigation {
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

Create `src/investigations/db.ts`:

```ts
// Persistence for the Investigation record (FR-33). Mirrors src/brain/
// entities.ts's exact query/row-mapping style — same sql tagged-template
// connection, same "jsonb comes back as raw text, JSON.parse it yourself"
// handling (verified there against a live Postgres instance).
import { sql } from "../brain/db";
import type { Investigation } from "./types";
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvestigationRow {
  id: string;
  status: string;
  problem_description: string;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  result: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    status: row.status as Investigation["status"],
    problemDescription: row.problem_description,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    result: row.result ? (JSON.parse(row.result) as Investigation["result"]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createInvestigation(input: {
  problemDescription: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}): Promise<Investigation> {
  const [row] = await sql<InvestigationRow[]>`
    INSERT INTO investigations (problem_description, slack_channel_id, slack_thread_ts)
    VALUES (
      ${input.problemDescription},
      ${input.slackChannelId ?? null},
      ${input.slackThreadTs ?? null}
    )
    RETURNING *
  `;
  return rowToInvestigation(row);
}

export async function completeInvestigation(
  id: string,
  outcome: { result: InvestigationResult; timeline: InvestigationTimeline },
): Promise<Investigation> {
  const status = outcome.result.outcome === "CONFIRMED" ? "CONFIRMED" : "INSUFFICIENT_EVIDENCE";
  const resultJson = JSON.stringify(outcome);

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations
    SET status = ${status}, result = ${resultJson}::jsonb, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) {
    throw new Error(`investigation not found: ${id}`);
  }
  return rowToInvestigation(row);
}

export async function getInvestigation(id: string): Promise<Investigation | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await sql<InvestigationRow[]>`SELECT * FROM investigations WHERE id = ${id}`;
  return row ? rowToInvestigation(row) : undefined;
}
```

Create `src/investigations/index.ts`:

```ts
export type { Investigation } from "./types";
export { createInvestigation, completeInvestigation, getInvestigation } from "./db";
```

Modify `tests/db-helpers.ts` — add `investigations` to the TRUNCATE statement:

```ts
export async function truncateAll(): Promise<void> {
  await sql`TRUNCATE TABLE relationship_provenance, relationships, entities, investigations RESTART IDENTITY CASCADE`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/investigations/db.test.ts`
Expected: PASS, all 8 tests. (The migration runs automatically via `tests/setup.ts`'s preload —
no manual migration step needed.)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as before this task plus the 8 new tests passing, zero new
failures, zero type errors. (The only expected pre-existing failures are 8 live-GitHub-API tests
in `tests/integrations/github/client.test.ts`, unrelated to this task.)

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_investigations.sql src/investigations tests/investigations/db.test.ts tests/db-helpers.ts
git commit -m "Module 07 Task 1: investigations table + persistence module"
```

---

### Task 2: Slack request signature verification

**Files:**
- Create: `src/slack/verify.ts`
- Test: `tests/slack/verify.test.ts`

**Interfaces:**
- Consumes: `node:crypto`'s `createHmac`/`timingSafeEqual` only.
- Produces: `verifySlackSignature(params): boolean`. Task 5 (server routes) calls this directly.

- [ ] **Step 1: Write the failing test**

Create `tests/slack/verify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../../src/slack/verify";

const SIGNING_SECRET = "test-signing-secret";

function sign(timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  test("accepts a correctly-signed, fresh request", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T123";
    const signature = sign(timestamp, rawBody);

    expect(
      verifySlackSignature({ timestamp, signature, rawBody, signingSecret: SIGNING_SECRET }),
    ).toBe(true);
  });

  test("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(timestamp, "token=abc&team_id=T123");

    expect(
      verifySlackSignature({
        timestamp,
        signature,
        rawBody: "token=abc&team_id=T999",
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("rejects a signature computed with the wrong secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T123";
    const base = `v0:${timestamp}:${rawBody}`;
    const wrongSignature = `v0=${createHmac("sha256", "wrong-secret").update(base).digest("hex")}`;

    expect(
      verifySlackSignature({
        timestamp,
        signature: wrongSignature,
        rawBody,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("rejects a stale timestamp (older than 5 minutes)", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = "token=abc&team_id=T123";
    const signature = sign(staleTimestamp, rawBody);

    expect(
      verifySlackSignature({
        timestamp: staleTimestamp,
        signature,
        rawBody,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("rejects when signingSecret is empty (not configured)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T123";
    const signature = sign(timestamp, rawBody);

    expect(
      verifySlackSignature({ timestamp, signature, rawBody, signingSecret: "" }),
    ).toBe(false);
  });

  test("rejects a non-numeric timestamp instead of throwing", () => {
    const rawBody = "token=abc&team_id=T123";
    expect(
      verifySlackSignature({
        timestamp: "not-a-number",
        signature: "v0=whatever",
        rawBody,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/slack/verify.test.ts`
Expected: FAIL — `../../src/slack/verify` module does not exist (import error).

- [ ] **Step 3: Write minimal implementation**

Create `src/slack/verify.ts`:

```ts
// Slack's documented request-signing scheme: HMAC-SHA256 of
// "v0:{timestamp}:{rawBody}" using the app's signing secret, compared
// against the X-Slack-Signature header with constant-time comparison.
// Also enforces a 5-minute timestamp window (replay protection), per
// Slack's own guidance. Never throws — every invalid input (bad secret,
// malformed timestamp, tampered body) resolves to `false`.
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

export function verifySlackSignature(params: {
  timestamp: string;
  signature: string;
  rawBody: string;
  signingSecret: string;
}): boolean {
  const { timestamp, signature, rawBody, signingSecret } = params;
  if (!signingSecret) return false;

  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampNum);
  if (ageSeconds > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/slack/verify.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as after Task 1 plus these 6 new tests passing, zero new
failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/slack/verify.ts tests/slack/verify.test.ts
git commit -m "Module 07 Task 2: Slack request signature verification"
```

---

### Task 3: Slack client (`postMessage`)

**Files:**
- Create: `src/slack/client.ts`
- Test: `tests/slack/client.test.ts`

**Interfaces:**
- Consumes: nothing from this repo — `fetch` only (injectable).
- Produces: `postMessage(input, opts?): Promise<PostMessageResult>`, `PostMessageInput`,
  `PostMessageResult` types, all exported from `src/slack/client.ts`. Tasks 4 and 5 import
  `postMessage` directly.

- [ ] **Step 1: Write the failing test**

Create `tests/slack/client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { postMessage } from "../../src/slack/client";

describe("postMessage", () => {
  test("not connected: returns a typed failure with no network call when SLACK_BOT_TOKEN is unset", async () => {
    delete process.env.SLACK_BOT_TOKEN;

    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("fetchImpl should never be called when not connected");
    }) as unknown as typeof fetch;

    const result = await postMessage(
      { channel: "C123", text: "hello" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: false, error: "not_connected" });
    expect(called).toBe(false);
  });

  test("success: returns ok:true with the posted message's ts", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await postMessage(
      { channel: "C123", text: "hello", thread_ts: "1700000000.000000" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true, ts: "1700000000.000100" });
  });

  test("Slack API error response: returns the typed failure, not a throw", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await postMessage({ channel: "C_BAD", text: "hello" }, { fetchImpl });

    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  test("network failure: returns a typed failure, not a throw", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await postMessage({ channel: "C123", text: "hello" }, { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("connection refused");
  });

  test("malformed response body: returns a typed failure, not a throw", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const result = await postMessage({ channel: "C123", text: "hello" }, { fetchImpl });

    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/slack/client.test.ts`
Expected: FAIL — `../../src/slack/client` module does not exist (import error).

- [ ] **Step 3: Write minimal implementation**

Create `src/slack/client.ts`:

```ts
// Slack Web API client — currently just chat.postMessage, the only Slack
// write this module needs. Same "typed failure surface, never throw for
// an expected failure" convention as src/integrations/github/client.ts,
// including its injectable-fetchImpl test seam.
export interface SlackFetchOptions {
  fetchImpl?: typeof fetch;
}

function getSlackBotToken(): string | null {
  const token = process.env.SLACK_BOT_TOKEN;
  return token && token.length > 0 ? token : null;
}

export interface PostMessageInput {
  channel: string;
  text: string;
  thread_ts?: string;
}

export type PostMessageResult = { ok: true; ts: string } | { ok: false; error: string };

export async function postMessage(
  input: PostMessageInput,
  opts?: SlackFetchOptions,
): Promise<PostMessageResult> {
  const token = getSlackBotToken();
  if (!token) {
    return { ok: false, error: "not_connected" };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: `malformed response body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = body as { ok?: unknown; ts?: unknown; error?: unknown };
  if (parsed.ok === true && typeof parsed.ts === "string") {
    return { ok: true, ts: parsed.ts };
  }
  return {
    ok: false,
    error: typeof parsed.error === "string" ? parsed.error : "unknown_error",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/slack/client.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as after Task 2 plus these 5 new tests passing, zero new
failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/slack/client.ts tests/slack/client.test.ts
git commit -m "Module 07 Task 3: Slack client (postMessage)"
```

---

### Task 4: `handleAppMention` + `pollAndPost` — FR-32/33

`handler.ts` and `poller.ts` are built together in one task: `handler.ts` imports `pollAndPost`
directly, so `handler.ts`'s own tests cannot pass (or even resolve their imports) until
`poller.ts` exists — splitting them would leave a task whose tests are red through no fault of
its own code, which isn't a reviewable unit on its own.

**Files:**
- Create: `src/slack/handler.ts`
- Create: `src/slack/poller.ts`
- Test: `tests/slack/handler.test.ts`
- Test: `tests/slack/poller.test.ts`

**Interfaces:**
- Consumes: `investigate`, `InvestigateOptions` from `src/agent` (module 06, already merged);
  `InvestigationResult` from `src/agent/types`; `getInvestigationState` from `src/session`
  (module 06, already merged); `createInvestigation`, `completeInvestigation` from
  `src/investigations` (this plan's Task 1); `buildFailureReport`, `renderFailureReport` from
  `src/failure` (module 05, already merged); `buildTimeline` from `src/timeline/build` (module 04,
  already merged); `postMessage` from `src/slack/client` (this plan's Task 3).
- Produces: `handleAppMention(event, opts?): Promise<void>`, `AppMentionEvent`,
  `HandleAppMentionOptions` types (from `src/slack/handler.ts`); `pollAndPost(sessionId,
  investigationId, resultPromise, slackTarget, opts?): Promise<void>`, `PollAndPostOptions` (from
  `src/slack/poller.ts`). Task 5 (server routes) calls `handleAppMention` directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/slack/handler.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { handleAppMention } from "../../src/slack/handler";
import { getInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { PostMessageInput, PostMessageResult } from "../../src/slack/client";

afterEach(async () => {
  await truncateAll();
});

describe("handleAppMention", () => {
  test("strips the leading mention token to get the problem description, and persists it", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    let investigateCalled = false;
    const investigateImpl = async (): Promise<InvestigationResult> => {
      investigateCalled = true;
      return { outcome: "INSUFFICIENT_EVIDENCE", hypothesesConsidered: [], reason: "no hypothesis was proposed", toolCalls: [] };
    };

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123> the error rate spiked at 14:03, please investigate",
        ts: "1700000000.000000",
      },
      { postMessageImpl, investigateImpl },
    );

    // Exactly one post — the ack — proves handleAppMention returned without
    // waiting on investigateImpl's promise (it resolved instantly here, so
    // this alone doesn't prove non-blocking under a slow investigateImpl;
    // Step "posts the ack before investigate() resolves" below covers that).
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.channel).toBe("C123");
    expect(postCalls[0]!.thread_ts).toBe("1700000000.000000");
    expect(postCalls[0]!.text).toContain("Investigating");

    const idMatch = /investigation=([0-9a-f-]{36})/.exec(postCalls[0]!.text);
    expect(idMatch).toBeTruthy();
    const investigationId = idMatch![1]!;

    const investigation = await getInvestigation(investigationId);
    expect(investigation).toBeDefined();
    expect(investigation!.problemDescription).toBe(
      "the error rate spiked at 14:03, please investigate",
    );
    expect(investigation!.slackChannelId).toBe("C123");
    expect(investigation!.slackThreadTs).toBe("1700000000.000000");

    expect(investigateCalled).toBe(true);
  });

  test("uses thread_ts as the reply target when the mention is already inside a thread", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };
    const investigateImpl = async (): Promise<InvestigationResult> => ({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123> investigate this",
        ts: "1700000000.000050",
        thread_ts: "1700000000.000000",
      },
      { postMessageImpl, investigateImpl },
    );

    expect(postCalls[0]!.thread_ts).toBe("1700000000.000000");
  });

  test("posts the ack before investigate() resolves (does not block on it)", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    let resolveInvestigate!: (r: InvestigationResult) => void;
    const pending = new Promise<InvestigationResult>((resolve) => {
      resolveInvestigate = resolve;
    });
    const investigateImpl = async (): Promise<InvestigationResult> => pending;

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123> investigate this",
        ts: "1700000000.000000",
      },
      { postMessageImpl, investigateImpl },
    );

    // handleAppMention already returned even though investigateImpl's
    // promise is still pending — proves it isn't awaited inline.
    expect(postCalls).toHaveLength(1);

    // Clean up: resolve the pending promise so nothing dangles past the test.
    resolveInvestigate({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });
  });
});
```

Create `tests/slack/poller.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { pollAndPost } from "../../src/slack/poller";
import { registerSession, unregisterSession } from "../../src/session";
import { createInvestigationState } from "../../src/agent/tools";
import { proposeHypothesis } from "../../src/agent/hypotheses";
import { createInvestigation, getInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { PostMessageInput, PostMessageResult } from "../../src/slack/client";

afterEach(async () => {
  await truncateAll();
});

function manualInterval() {
  let callback: (() => void) | null = null;
  const setIntervalImpl = ((cb: () => void) => {
    callback = cb;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalImpl = (() => {
    callback = null;
  }) as typeof clearInterval;
  return { setIntervalImpl, clearIntervalImpl, tick: () => callback?.() };
}

describe("pollAndPost", () => {
  test("posts a progress update only when stepNumber has advanced, then posts the final CONFIRMED result", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const posts: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      posts.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    const { setIntervalImpl, clearIntervalImpl, tick } = manualInterval();

    let resolveResult!: (r: InvestigationResult) => void;
    const resultPromise = new Promise<InvestigationResult>((resolve) => {
      resolveResult = resolve;
    });

    const pollPromise = pollAndPost(
      sessionId,
      investigation.id,
      resultPromise,
      { channel: "C123", thread_ts: "1700000000.000000" },
      { setIntervalImpl, clearIntervalImpl, postMessageImpl },
    );

    // No steps yet — a tick should not post anything.
    tick();
    await Promise.resolve();
    expect(posts).toHaveLength(0);

    // Advance stepNumber and hypotheses — next tick should post exactly one update.
    state.stepNumber = 2;
    state.hypotheses.push(proposeHypothesis("Scheduler is disabled"));
    tick();
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("2 steps");

    // A tick with no further advancement should not post again.
    tick();
    await Promise.resolve();
    expect(posts).toHaveLength(1);

    // Resolve the investigation as CONFIRMED.
    const confirmedHypothesis = state.hypotheses[0]!;
    resolveResult({
      outcome: "CONFIRMED",
      hypothesis: confirmedHypothesis,
      rca: confirmedHypothesis.statement,
      evidenceTrail: [],
      toolCalls: [],
    });
    await pollPromise;
    unregisterSession(sessionId);

    expect(posts).toHaveLength(2);
    expect(posts[1]!.text).toContain(confirmedHypothesis.statement);
    expect(posts[1]!.text).toContain(`investigation=${investigation.id}`);

    const stored = await getInvestigation(investigation.id);
    expect(stored!.status).toBe("CONFIRMED");
    expect(stored!.result).not.toBeNull();
  });

  test("INSUFFICIENT_EVIDENCE result posts the NOT CONFIRMED report text", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const posts: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      posts.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };
    const { setIntervalImpl, clearIntervalImpl } = manualInterval();

    const resultPromise = Promise.resolve<InvestigationResult>({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });

    await pollAndPost(
      sessionId,
      investigation.id,
      resultPromise,
      { channel: "C123", thread_ts: "1700000000.000000" },
      { setIntervalImpl, clearIntervalImpl, postMessageImpl },
    );
    unregisterSession(sessionId);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("NOT CONFIRMED");

    const stored = await getInvestigation(investigation.id);
    expect(stored!.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  test("a failed progress-update postMessage call is logged and does not stop polling or crash", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    let callCount = 0;
    const postMessageImpl = async (): Promise<PostMessageResult> => {
      callCount++;
      return { ok: false, error: "simulated failure" };
    };
    const { setIntervalImpl, clearIntervalImpl, tick } = manualInterval();

    const resultPromise = Promise.resolve<InvestigationResult>({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });

    const pollPromise = pollAndPost(
      sessionId,
      investigation.id,
      resultPromise,
      { channel: "C123", thread_ts: "1700000000.000000" },
      { setIntervalImpl, clearIntervalImpl, postMessageImpl },
    );

    state.stepNumber = 1;
    tick();
    await Promise.resolve();

    await pollPromise;
    unregisterSession(sessionId);

    // One progress post attempt (failed) + one final post attempt (also
    // failed here, same postMessageImpl) — neither throws.
    expect(callCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/slack/handler.test.ts tests/slack/poller.test.ts`
Expected: FAIL — neither `../../src/slack/handler` nor `../../src/slack/poller` exists yet
(import errors).

- [ ] **Step 3: Write minimal implementation**

Create `src/slack/poller.ts` first (handler.ts depends on it):

```ts
// FR-33's "progress posted as the investigation proceeds, not just a
// final message" — polls module 06's live-state registry on an
// injectable interval and posts a thread update whenever stepNumber has
// advanced, until the investigation resolves, then persists the final
// result (via src/investigations) and posts it.
import { getInvestigationState } from "../session";
import { completeInvestigation } from "../investigations";
import { buildFailureReport, renderFailureReport } from "../failure";
import { buildTimeline } from "../timeline/build";
import type { InvestigationResult } from "../agent/types";
import { postMessage } from "./client";
import type { PostMessageInput, PostMessageResult } from "./client";

const DEFAULT_INTERVAL_MS = 4000;

export interface PollAndPostOptions {
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}

export async function pollAndPost(
  sessionId: string,
  investigationId: string,
  resultPromise: Promise<InvestigationResult>,
  slackTarget: { channel: string; thread_ts: string },
  opts: PollAndPostOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;
  const postMessageImpl = opts.postMessageImpl ?? postMessage;
  const baseUrl = opts.baseUrl ?? "http://localhost:4300";

  let lastStepNumber = 0;

  function logIfFailed(result: PostMessageResult, context: string): void {
    if (!result.ok) {
      console.error(`slack poller: ${context} post failed: ${result.error}`);
    }
  }

  const timer = setIntervalImpl(() => {
    const snapshot = getInvestigationState(sessionId);
    if (!snapshot) return; // already resolved; the final post below handles completion
    if (snapshot.stepNumber > lastStepNumber) {
      lastStepNumber = snapshot.stepNumber;
      const hypothesesWord = snapshot.hypotheses.length === 1 ? "hypothesis" : "hypotheses";
      void postMessageImpl({
        channel: slackTarget.channel,
        thread_ts: slackTarget.thread_ts,
        text: `Still investigating… (${snapshot.stepNumber} steps so far, ${snapshot.hypotheses.length} ${hypothesesWord} under consideration)`,
      }).then((result) => logIfFailed(result, "progress"));
    }
  }, intervalMs);

  const result = await resultPromise;
  clearIntervalImpl(timer);

  const timeline = buildTimeline(result.toolCalls);
  await completeInvestigation(investigationId, { result, timeline });

  const link = `${baseUrl}/?investigation=${investigationId}`;
  const finalText =
    result.outcome === "CONFIRMED"
      ? `✅ Root cause confirmed: ${result.rca}\nFull view: ${link}`
      : `${renderFailureReport(buildFailureReport(result))}\nFull view: ${link}`;

  const finalResult = await postMessageImpl({
    channel: slackTarget.channel,
    thread_ts: slackTarget.thread_ts,
    text: finalText,
  });
  logIfFailed(finalResult, "final result");
}
```

Then create `src/slack/handler.ts`:

```ts
// FR-32/33: the only place this module's Slack-specific code meets
// modules 03/06's investigation lifecycle. No investigation logic here —
// this only orchestrates: create the record, ack, kick off investigate()
// without blocking, hand off progress/completion to the poller.
import { investigate } from "../agent";
import type { InvestigateOptions } from "../agent";
import type { InvestigationResult } from "../agent/types";
import { createInvestigation } from "../investigations";
import { postMessage } from "./client";
import type { PostMessageResult, PostMessageInput } from "./client";
import { pollAndPost } from "./poller";

// app_mention events fire only when this app itself is mentioned, so the
// leading <@ANYID> token is always this bot — no need for a separately
// configured bot user id env var to know which id to strip.
const LEADING_MENTION_RE = /^<@[^>]+>\s*/;

export interface AppMentionEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export interface HandleAppMentionOptions {
  investigateImpl?: (problem: string, options?: InvestigateOptions) => Promise<InvestigationResult>;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}

export async function handleAppMention(
  event: AppMentionEvent,
  opts: HandleAppMentionOptions = {},
): Promise<void> {
  const investigateImpl = opts.investigateImpl ?? investigate;
  const postMessageImpl = opts.postMessageImpl ?? postMessage;
  const baseUrl = opts.baseUrl ?? "http://localhost:4300";

  const problemDescription = event.text.replace(LEADING_MENTION_RE, "").trim();
  const threadTs = event.thread_ts ?? event.ts;

  const investigation = await createInvestigation({
    problemDescription,
    slackChannelId: event.channel,
    slackThreadTs: threadTs,
  });

  const link = `${baseUrl}/?investigation=${investigation.id}`;
  await postMessageImpl({
    channel: event.channel,
    thread_ts: threadTs,
    text: `Investigating — I'll post updates here. Full view: ${link}`,
  });

  const resultPromise = investigateImpl(problemDescription, { sessionId: investigation.id });

  // Deliberately not awaited — the poller owns the rest of this
  // investigation's lifecycle, including posting the final result.
  void pollAndPost(
    investigation.id,
    investigation.id,
    resultPromise,
    { channel: event.channel, thread_ts: threadTs },
    { postMessageImpl },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/slack/handler.test.ts tests/slack/poller.test.ts`
Expected: PASS, all 6 tests (3 handler + 3 poller).

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as after Task 3 plus these 6 new tests passing, zero new
failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/slack/handler.ts src/slack/poller.ts tests/slack/handler.test.ts tests/slack/poller.test.ts
git commit -m "Module 07 Task 4: handleAppMention + pollAndPost (FR-32/33)"
```

---

### Task 5: Server routes + frontend investigation-id support (FR-34)

**Files:**
- Modify: `src/timeline/server.ts`
- Modify: `src/timeline/frontend.tsx`
- Test: `tests/timeline/slack-routes.test.ts`

**Interfaces:**
- Consumes: `verifySlackSignature` from `src/slack/verify` (this plan's Task 2), `handleAppMention`,
  `AppMentionEvent` from `src/slack/handler` (this plan's Task 4), `getInvestigation` from
  `src/investigations` (this plan's Task 1).
- Produces: two new routes on the existing `createServer()` — `POST /slack/events`,
  `GET /api/timeline/:id` — and a small `frontend.tsx` change reading `?investigation=<id>` from
  the URL. No new exports; this is the plan's last code task.

**Design refinement worth noting:** `GET /api/timeline/:id` returns the *same shape* as the
existing `/api/timeline/demo` (`{ steps: [...] }`), and `404`s both when the id doesn't exist and
when the investigation is still `IN_PROGRESS` (no timeline to show yet). This means
`frontend.tsx`'s existing error-handling path (`catch` → "Failed to load investigation timeline")
already covers "still running" with zero new UI logic — the only change needed is picking which
URL to fetch.

- [ ] **Step 1: Write the failing test**

Create `tests/timeline/slack-routes.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "../../src/timeline/server";
import { createInvestigation, completeInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { InvestigationTimeline } from "../../src/timeline/types";

let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await truncateAll();
});

function sign(secret: string, timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("POST /slack/events", () => {
  test("rejects an unsigned request with 401", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/slack/events", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback" }),
    });

    expect(res.status).toBe(401);
  });

  test("rejects a badly-signed request with 401", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-secret";
    server = createServer(0);

    const res = await fetch(new URL("/slack/events", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      body: JSON.stringify({ type: "event_callback" }),
    });

    expect(res.status).toBe(401);
  });

  test("responds to Slack's url_verification challenge", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-secret";
    server = createServer(0);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const signature = sign("test-secret", timestamp, rawBody);

    const res = await fetch(new URL("/slack/events", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string };
    expect(body.challenge).toBe("abc123");
  });

  // Deliberately NOT tested here: a valid app_mention event's full response.
  // The route's app_mention branch calls handleAppMention with no
  // injection point, which would call the REAL investigate() (real
  // Anthropic client) — this repo's established convention (see
  // tests/timeline/server.test.ts's comment on /api/investigate) is to
  // never trigger that from a test. The route-level signature/challenge
  // behavior above is what's specific to this route; the full
  // app_mention -> handleAppMention -> pollAndPost flow is already
  // covered with injected mocks in Task 4's unit tests.
  test("an event_callback with an unrecognized event type still returns 200 (ignored, not an error)", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-secret";
    server = createServer(0);

    const rawBody = JSON.stringify({
      type: "event_callback",
      event: { type: "message", channel: "C123", text: "not a mention" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("test-secret", timestamp, rawBody);

    const res = await fetch(new URL("/slack/events", server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);
  });
});

describe("GET /api/timeline/:id", () => {
  test("404s for an unknown id", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/api/timeline/00000000-0000-0000-0000-000000000000", server.url));

    expect(res.status).toBe(404);
  });

  test("404s while the investigation is still IN_PROGRESS", async () => {
    server = createServer(0);
    const investigation = await createInvestigation({ problemDescription: "test" });

    const res = await fetch(new URL(`/api/timeline/${investigation.id}`, server.url));

    expect(res.status).toBe(404);
  });

  test("returns the stored timeline, in the same shape as /api/timeline/demo, once complete", async () => {
    server = createServer(0);
    const investigation = await createInvestigation({ problemDescription: "test" });

    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    };
    const timeline: InvestigationTimeline = { steps: [] };
    await completeInvestigation(investigation.id, { result, timeline });

    const res = await fetch(new URL(`/api/timeline/${investigation.id}`, server.url));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { steps: unknown[] };
    expect(body).toEqual({ steps: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/timeline/slack-routes.test.ts`
Expected: FAIL — `/slack/events` and `/api/timeline/:id` return 404 (routes don't exist yet on
`createServer()`).

- [ ] **Step 3: Write minimal implementation**

Modify `src/timeline/server.ts` — add these imports near the top (alongside the existing ones):

```ts
import { verifySlackSignature } from "../slack/verify";
import { handleAppMention } from "../slack/handler";
import type { AppMentionEvent } from "../slack/handler";
import { getInvestigation } from "../investigations";
```

Add these two entries to the `routes` object inside `createServer`, alongside the existing
`"/"`, `"/api/timeline/demo"`, and `"/api/investigate"` entries:

```ts
      "/slack/events": {
        POST: async (req: Request) => {
          const rawBody = await req.text();
          const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
          const signature = req.headers.get("x-slack-signature") ?? "";
          const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";

          if (!verifySlackSignature({ timestamp, signature, rawBody, signingSecret })) {
            return new Response("invalid signature", { status: 401 });
          }

          let payload: unknown;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return new Response("invalid JSON", { status: 400 });
          }

          const body = payload as { type?: string; challenge?: string; event?: unknown };

          if (body.type === "url_verification") {
            return Response.json({ challenge: body.challenge });
          }

          if (body.type === "event_callback") {
            const event = body.event as ({ type?: string } & Record<string, unknown>) | undefined;
            if (event?.type === "app_mention") {
              // Not awaited — Slack requires a fast ack; the investigation
              // itself runs for minutes. handleAppMention is itself
              // internally non-blocking (see src/slack/handler.ts).
              void handleAppMention(event as unknown as AppMentionEvent);
            }
          }

          return new Response("ok", { status: 200 });
        },
      },

      "/api/timeline/:id": {
        GET: async (req) => {
          const investigation = await getInvestigation(req.params.id);
          if (!investigation || investigation.status === "IN_PROGRESS" || !investigation.result) {
            return new Response("not found", { status: 404 });
          }
          return Response.json(investigation.result.timeline);
        },
      },
```

Modify `src/timeline/frontend.tsx` — change only the `useEffect` body:

```ts
  useEffect(() => {
    const investigationId = new URLSearchParams(window.location.search).get("investigation");
    const url = investigationId ? `/api/timeline/${investigationId}` : "/api/timeline/demo";

    fetch(url)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Request failed with status ${res.status}`);
        }
        return res.json();
      })
      .then((data: { steps: TimelineStep[] }) => setSteps(data.steps))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/timeline/slack-routes.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as after Task 4 plus these 7 new tests passing, and confirm
`tests/timeline/server.test.ts`'s existing tests (unmodified) still pass — the frontend change is
additive (falls back to the exact previous behavior when no `?investigation=` param is present).
Zero new failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/timeline/server.ts src/timeline/frontend.tsx tests/timeline/slack-routes.test.ts
git commit -m "Module 07 Task 5: Slack webhook + timeline-by-id routes (FR-34)"
```

---

### Task 6: Documentation + environment variables

**Files:**
- Create: `docs/slack-interface.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: final shapes from Tasks 1-6. Purely descriptive — no code changes.
- Produces: nothing consumed by later tasks (last task in this plan).

- [ ] **Step 1: Add environment variables**

Read the current `.env.example` yourself first (its exact existing format/comments), then append
two new entries following the same style as the existing `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`
placeholders:

```
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
```

- [ ] **Step 2: Write the doc**

Create `docs/slack-interface.md` covering: the `investigations` table/module (Task 1's
`Investigation` type and functions), `src/slack/`'s four pieces (`verifySlackSignature`,
`postMessage`, `handleAppMention`, `pollAndPost`) with their real signatures copied from the
final source files, the two new `src/timeline/server.ts` routes, the `SLACK_SIGNING_SECRET`/
`SLACK_BOT_TOKEN` env vars, and a short "How a Slack mention becomes a posted result" walkthrough
tying FR-32/33/34 to the actual call sequence (`handleAppMention` → `createInvestigation` → ack
→ `investigate()` (not awaited) → `pollAndPost` → progress posts → `completeInvestigation` →
final post). Follow the style of `docs/human-collaboration.md` and `docs/failure-handling.md`
(intro + "signatures copied from X, keep in sync" note + per-function breakdown + a "known
limitations" section).

Note explicitly, as a known limitation (this module's own scope boundary, not a bug): the poller
only reflects `stepNumber`, not *which* tool is currently running — a richer per-step Slack
narration would need module 04's full `ToolCallRecord` detail surfaced live, which is out of this
module's scope (it only consumes `getInvestigationState`'s existing snapshot shape).

- [ ] **Step 3: Self-check against the actual code**

Re-open every file this doc describes (`src/investigations/*.ts`, `src/slack/*.ts`,
`src/timeline/server.ts`'s two new routes) as they exist after Task 5 and confirm every signature,
field name, and behavior claim matches exactly. Fix any drift inline.

- [ ] **Step 4: Commit**

```bash
git add docs/slack-interface.md .env.example
git commit -m "Module 07 Task 6: document Slack interface, add SLACK_* env vars"
```

---

## Final whole-branch check (after all 6 tasks)

- [ ] Run `bun test && bunx tsc --noEmit` once more from a clean state — confirm the only
      failures are the same 8 pre-existing live-GitHub-API tests, zero type errors.
- [ ] Push the branch and open a PR, per this repo's `CLAUDE.md` definition-of-done.
