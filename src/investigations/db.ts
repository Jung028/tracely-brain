// Persistence for the Investigation record (FR-33, FR-35). Mirrors
// src/brain/entities.ts's exact query/row-mapping style — same sql
// tagged-template connection, same "jsonb comes back as raw text,
// JSON.parse it yourself" handling.
import { sql } from "../brain/db";
import type { Investigation, InvestigationTransitionResult } from "./types";
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";
import { transition } from "../state-machine";
import type { TransitionEvent } from "../state-machine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvestigationRow {
  id: string;
  status: string;
  retry_count: number;
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
    retryCount: row.retry_count,
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

export async function getInvestigation(id: string): Promise<Investigation | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await sql<InvestigationRow[]>`SELECT * FROM investigations WHERE id = ${id}`;
  return row ? rowToInvestigation(row) : undefined;
}

export async function beginInvestigating(id: string): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const result = transition(current.status, { type: "BEGIN_INVESTIGATING" }, {
    retryCount: current.retryCount,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations SET status = ${result.state}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) {
    return { ok: false, error: `investigation update failed unexpectedly for: ${id}` };
  }
  return { ok: true, investigation: rowToInvestigation(row) };
}

export async function completeInvestigation(
  id: string,
  outcome: { result: InvestigationResult; timeline: InvestigationTimeline },
): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const event: TransitionEvent =
    outcome.result.outcome === "CONFIRMED"
      ? { type: "RCA_CONFIRMED" }
      : { type: "INSUFFICIENT_EVIDENCE" };
  const result = transition(current.status, event, { retryCount: current.retryCount });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const resultJson = JSON.stringify(outcome);
  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations
    SET status = ${result.state}, result = ${resultJson}::jsonb, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) {
    return { ok: false, error: `investigation update failed unexpectedly for: ${id}` };
  }
  return { ok: true, investigation: rowToInvestigation(row) };
}

// Known limitation: this reads the current row, computes the next state,
// then issues a separate UPDATE — not atomic. Two near-simultaneous
// reopen calls on the same investigation could both read retryCount=2 and
// both succeed, pushing the real count to 4 rather than the 3 this module
// enforces. Accepted for now: this is single-operator-scale software with
// no concurrent-caller scenario in real usage (a human does not click
// "reopen" twice in the same instant), and no other function in this
// codebase uses row-locking/transactions for this kind of update. Revisit
// if a real concurrent-write scenario ever appears.
export async function reopenInvestigation(id: string): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const result = transition(current.status, { type: "REOPEN" }, { retryCount: current.retryCount });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations
    SET status = ${result.state}, retry_count = ${current.retryCount + 1}, result = NULL, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) {
    return { ok: false, error: `investigation update failed unexpectedly for: ${id}` };
  }
  return { ok: true, investigation: rowToInvestigation(row) };
}

export async function closeInvestigation(id: string): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const result = transition(current.status, { type: "CLOSE_DIRECTLY" }, {
    retryCount: current.retryCount,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations SET status = ${result.state}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) {
    return { ok: false, error: `investigation update failed unexpectedly for: ${id}` };
  }
  return { ok: true, investigation: rowToInvestigation(row) };
}
