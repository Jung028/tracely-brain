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
