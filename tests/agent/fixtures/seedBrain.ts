// Seeds a minimal Brain state for a demo scenario. Uses module 01's real
// write-path (upsertEntity / recordRelationshipObservation) against the
// test database configured in .env.test — same DB the rest of the suite
// already uses (see tests/setup.ts), so no separate fixture DB is needed.
import { recordRelationshipObservation, upsertEntity } from "../../../src/brain";

export async function seedSchedulerDisabledScenario() {
  const scheduler = await upsertEntity({
    domain: "Runtime",
    entityType: "Scheduler",
    name: "LiabilityAssignmentScheduler",
    sourceSystem: "test-fixture",
    sourceRef: "fixture:scheduler-disabled:scheduler",
    attributes: { enabled: false },
  });

  const task = await upsertEntity({
    domain: "Runtime",
    entityType: "WorkflowTask",
    name: "AssignLiabilityTask",
    sourceSystem: "test-fixture",
    sourceRef: "fixture:scheduler-disabled:task",
    attributes: { state: "WAIT_JUDGE" },
  });

  await recordRelationshipObservation({
    fromEntityId: task.id,
    toEntityId: scheduler.id,
    relationshipType: "TRANSITIONS_TO",
    sourceSystem: "test-fixture",
    sourceRef: "fixture:scheduler-disabled:transition",
  });

  return { scheduler, task };
}

export async function seedHistoricalIncident(statement: string) {
  return upsertEntity({
    domain: "Operational Knowledge",
    entityType: "IncidentRCA",
    name: statement,
    sourceSystem: "test-fixture",
    sourceRef: `fixture:historical:${crypto.randomUUID()}`,
    attributes: { rca: statement },
  });
}

/**
 * Seeds a fixture File entity for search_code to exercise for real —
 * hermetic (no live GitHub API calls). Earlier this made three live calls
 * (getRepo/getTreeRecursive/getFileContent) purely to obtain a real blob
 * sha, but none of the scenario tests that use this fixture ever assert on
 * actual file content: they only need search_code's tool call to complete
 * without throwing so the scripted investigation can proceed. search_code
 * (src/agent/tools.ts) already has a documented graceful-failure branch for
 * when getFileContent doesn't return `ok: true` — it pushes a
 * "--- {path} --- (read failed: ...)" string into its results instead of
 * throwing. So a fixture sha that doesn't correspond to a real GitHub blob
 * is sufficient here: search_code's real getFileContent call will run
 * against it and hit that graceful-failure path (either `not_connected` if
 * GITHUB_TOKEN is unset, or `query_failed`/404 if a token is present),
 * which is expected and fine. The point of exercising search_code in these
 * scenarios is to prove the tool-call path executes for real (parses
 * sourceRef, extracts sha, calls getFileContent, handles whatever comes
 * back) — not to prove specific file content is retrievable, which is
 * already covered by tests/integrations/github/client.test.ts's own
 * getFileContent tests. Returns the entity's `name` (file path) so scenario
 * tests can script a matching search_code call.
 */
export async function seedRealCodeFileEntity() {
  await upsertEntity({
    domain: "Code",
    entityType: "File",
    name: "package.json",
    sourceSystem: "github",
    sourceRef: "github:Jung028/tracely-brain:package.json",
    attributes: { sha: "0000000000000000000000000000000000000000" },
  });

  return { path: "package.json" };
}
