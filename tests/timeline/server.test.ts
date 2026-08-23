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

let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
});

describe("timeline server", () => {
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
});
