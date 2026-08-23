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
    },
  });
}

if (import.meta.main) {
  const server = createServer();
  console.log(`Tracely investigation timeline server listening at ${server.url}`);
}
