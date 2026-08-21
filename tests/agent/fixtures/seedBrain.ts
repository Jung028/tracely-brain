// Seeds a minimal Brain state for a demo scenario. Uses module 01's real
// write-path (upsertEntity / recordRelationshipObservation) against the
// test database configured in .env.test — same DB the rest of the suite
// already uses (see tests/setup.ts), so no separate fixture DB is needed.
import { recordRelationshipObservation, upsertEntity } from "../../../src/brain";
import { getFileContent, getRepo, getTreeRecursive } from "../../../src/integrations/github/client";

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
 * Seeds a real, live-fetched File entity for search_code to exercise for
 * real — reuses the same live Jung028/tracely-brain repo the GitHub client
 * tests already call (module 02's live-by-default convention still applies
 * to GitHub/Brain calls; only the Anthropic client is mocked in this
 * module — see design doc Testing section). Returns the entity's `name`
 * (file path) so scenario tests can script a matching search_code call.
 */
export async function seedRealCodeFileEntity() {
  const repoResult = await getRepo("Jung028", "tracely-brain");
  if (!("ok" in repoResult) || !repoResult.ok) {
    throw new Error("live getRepo failed while seeding a code file fixture");
  }
  const repoData = repoResult.data as { default_branch: string };

  const treeResult = await getTreeRecursive(
    "Jung028",
    "tracely-brain",
    repoData.default_branch,
  );
  if (!("ok" in treeResult) || !treeResult.ok) {
    throw new Error("live getTreeRecursive failed while seeding a code file fixture");
  }

  const packageJson = treeResult.data.find((e) => e.path === "package.json");
  if (!packageJson) throw new Error("package.json not found in live tree");

  // Sanity-check content is actually fetchable before the test relies on
  // it (fails fast with a clear message rather than a confusing assertion
  // failure deep in a scenario test).
  const content = await getFileContent("Jung028", "tracely-brain", packageJson.sha);
  if (!("ok" in content) || !content.ok) {
    throw new Error("live getFileContent failed while seeding a code file fixture");
  }

  await upsertEntity({
    domain: "Code",
    entityType: "File",
    name: "package.json",
    sourceSystem: "github",
    sourceRef: "github:Jung028/tracely-brain:package.json",
    attributes: { sha: packageJson.sha },
  });

  return { path: "package.json" };
}
