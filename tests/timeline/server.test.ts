// Lightweight fetch()-based smoke tests for src/timeline/server.ts. No
// DOM/React testing library (none exists in this repo, not needed for
// these assertions). Each test starts its own server on an ephemeral port
// (port: 0) via createServer() and hits it through a real fetch() against
// server.url, then stops it — no separately running process needed and no
// fixed-port collisions between tests or with a manually-run dev server.
//
// Per task-3-brief.md: do NOT test /api/investigate end-to-end against a
// live Anthropic API — this repo always injects a mock client for
// investigate() tests (see tests/agent/investigate.test.ts), and no API
// key is available in CI/test environments. Only the validation-failure
// path (missing/invalid problemDescription) is exercised here.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "../../src/timeline/server";
import {
  beginInvestigating,
  completeInvestigation,
  createInvestigation,
} from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { InvestigationTimeline } from "../../src/timeline/types";

let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

describe("timeline server", () => {
  afterEach(async () => {
    await truncateAll();
  });

  test("GET / returns 200 with an HTML content type", async () => {
    server = createServer(0);

    const res = await fetch(server.url);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("GET /api/timeline/demo returns a non-empty TimelineStep[] with FR-21 fields", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/api/timeline/demo", server.url));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as { steps: unknown[] };
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThan(0);

    for (const step of body.steps) {
      expect(step).toHaveProperty("toolName");
      expect(step).toHaveProperty("query");
      expect(step).toHaveProperty("why");
      expect(step).toHaveProperty("result");
      expect(step).toHaveProperty("hypothesisId");
      expect(step).toHaveProperty("supports");
      expect(step).toHaveProperty("meaning");
      expect(step).toHaveProperty("concurrencyGroup");
    }

    // At least one step should reproduce the spec's own WAIT_JUDGE example
    // (specs/04-evidence-timeline.md) — sanity-checks the fixture wiring,
    // not just the response shape.
    const example = body.steps.find(
      (step) =>
        (step as { why: unknown }).why === "Determine current task state and related workflow.",
    ) as { hypothesisId: string; supports: string } | undefined;
    expect(example?.hypothesisId).toBe("H1");
    expect(example?.supports).toBe("supporting");
  });

  test("timeline steps come back in chronological order regardless of fixture array order", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/api/timeline/demo", server.url));
    const body = (await res.json()) as { steps: { timestamp: string }[] };

    const timestamps = body.steps.map((step) => new Date(step.timestamp).getTime());
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });

  test("POST /api/investigate with a missing problemDescription returns 4xx", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/api/investigate", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("POST /api/investigate with an invalid JSON body returns 4xx", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/api/investigate", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("GET /api/timeline/:id returns problemDescription, status, summary, and steps", async () => {
    server = createServer(0);

    const created = await createInvestigation({ problemDescription: "why is CB-123456 stuck in WAIT_JUDGE?" });
    await beginInvestigating(created.id);

    const result: InvestigationResult = {
      outcome: "CONFIRMED",
      hypothesis: {
        id: "H1",
        statement: "Scheduler is disabled",
        supportingEvidence: [],
        contradictingEvidence: [],
        status: "CONFIRMED",
        confidence: 0.9,
      },
      rca: "The liability-assignment scheduler was disabled.",
      evidenceTrail: [],
      toolCalls: [],
    };
    const timeline: InvestigationTimeline = {
      steps: [
        {
          id: "step-1",
          toolName: "query_brain",
          query: { mode: "search" },
          why: "Find the relevant workflow.",
          result: { status: "WAIT_JUDGE" },
          meaning: "Confirms the task is stuck",
          hypothesisId: "H1",
          supports: "supporting",
          timestamp: new Date("2026-08-24T12:00:00.000Z"),
          concurrencyGroup: "batch-1",
        },
      ],
    };
    await completeInvestigation(created.id, { result, timeline });

    const res = await fetch(new URL(`/api/timeline/${created.id}`, server.url));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      problemDescription: string;
      status: string;
      summary: { outcome: string; rca: string | null; reason: string | null; hypotheses: unknown[] };
      steps: unknown[];
    };

    expect(body.problemDescription).toBe("why is CB-123456 stuck in WAIT_JUDGE?");
    expect(body.status).toBe("RCA_IDENTIFIED");
    expect(body.summary.outcome).toBe("CONFIRMED");
    expect(body.summary.rca).toBe("The liability-assignment scheduler was disabled.");
    expect(body.summary.hypotheses).toHaveLength(1);
    expect(body.steps).toHaveLength(1);
  });

  test("GET /api/timeline/:id still 404s for an investigation with no stored result", async () => {
    server = createServer(0);
    const created = await createInvestigation({ problemDescription: "in progress" });

    const res = await fetch(new URL(`/api/timeline/${created.id}`, server.url));
    expect(res.status).toBe(404);
  });

  test("GET /api/timeline/demo is unaffected — still returns only { steps }", async () => {
    server = createServer(0);

    const res = await fetch(new URL("/api/timeline/demo", server.url));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.steps).toBeDefined();
    expect(body.summary).toBeUndefined();
    expect(body.problemDescription).toBeUndefined();
  });
});
