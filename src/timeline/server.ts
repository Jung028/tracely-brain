// Bun.serve() entrypoint for Module 04's web UI (task-3-brief.md). Follows
// the project's mandated frontend pattern (root CLAUDE.md): Bun.serve()
// with HTML imports and the `routes` config only — no vite, no express, no
// hand-rolled router.
//
// `createServer` is exported (rather than only starting a server as a
// side effect) so tests/timeline/server.test.ts can start an isolated,
// ephemeral-port instance per test via `createServer(0)` and hit it with a
// real fetch() against `server.url`, without needing a separately running
// process.
import index from "./index.html";
import { investigate } from "../agent";
import { buildTimeline } from "./build";
import { demoToolCalls } from "./demoFixture";
import { verifySlackSignature } from "../slack/verify";
import { handleAppMention } from "../slack/handler";
import type { AppMentionEvent } from "../slack/handler";
import { getInvestigation } from "../investigations";

export const DEFAULT_PORT = 4300;

export function createServer(port: number = DEFAULT_PORT) {
  return Bun.serve({
    port,
    routes: {
      "/": index,

      "/api/timeline/demo": {
        GET: () => Response.json(buildTimeline(demoToolCalls)),
      },

      "/api/investigate": {
        POST: async (req: Request) => {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
          }

          const problemDescription =
            typeof body === "object" && body !== null
              ? (body as Record<string, unknown>).problemDescription
              : undefined;

          if (typeof problemDescription !== "string" || problemDescription.trim() === "") {
            return Response.json(
              { error: "problemDescription (a non-empty string) is required." },
              { status: 400 },
            );
          }

          // Real investigate() call, real Anthropic client (no injected
          // mock) — requires ANTHROPIC_API_KEY in the environment to
          // actually complete. This is expected: server.test.ts only
          // exercises the validation-failure path for this route.
          const result = await investigate(problemDescription);
          return Response.json({ result, timeline: buildTimeline(result.toolCalls) });
        },
      },

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
              // .catch() is required: an unhandled rejection here (e.g.
              // createInvestigation's Postgres call failing) would crash
              // the whole Bun process — externally reachable from this
              // signature-gated but still externally-triggerable route.
              void handleAppMention(event as unknown as AppMentionEvent).catch((err) => {
                console.error(
                  `slack /events: handleAppMention failed: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
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
    },
  });
}

if (import.meta.main) {
  const server = createServer();
  console.log(`Tracely investigation timeline server listening at ${server.url}`);
}
