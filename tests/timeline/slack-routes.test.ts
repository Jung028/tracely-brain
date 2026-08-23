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
