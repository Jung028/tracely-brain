// Tests for GitHub repo -> Company Brain sync orchestration (module 02,
// Task 2). Mixes live calls against the real `Jung028/tracely-brain` repo
// (using the real PAT loaded from .env.test, same as Task 1's client.test.ts)
// with an injected-fetch test for the one failure mode that can't be
// reliably triggered against the live API: the tree fetch failing right
// after the repo lookup has already succeeded.
import { afterEach, describe, expect, test } from "bun:test";
import { findEntities, queryRelationships } from "../../../src/brain";
import { syncGitHubRepository } from "../../../src/integrations/github/sync";
import { truncateAll } from "../../db-helpers";

const OWNER = "Jung028";
const REPO = "tracely-brain";

// GITHUB_TOKEN is loaded from .env.test by Bun before this file runs. Save
// it once so the "continue without source" test can unset it and every
// other test still gets a working token, regardless of test order or how a
// test exits.
const REAL_TOKEN = process.env.GITHUB_TOKEN;

afterEach(async () => {
  if (REAL_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = REAL_TOKEN;
  }
  await truncateAll();
});

describe("syncGitHubRepository", () => {
  test("happy path: live sync writes a Repository entity, File entities, and CONTAINS relationships", async () => {
    const result = await syncGitHubRepository({ owner: OWNER, repo: REPO });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.filesWritten).toBeGreaterThan(0);

    const repoEntities = await findEntities({
      domain: "Code",
      entityType: "Repository",
    });
    expect(repoEntities).toHaveLength(1);
    expect(repoEntities[0].sourceSystem).toBe("github");
    expect(repoEntities[0].sourceRef).toBe(`github:${OWNER}/${REPO}`);
    expect(repoEntities[0].id).toBe(result.repositoryEntityId);

    const fileEntities = await findEntities({
      domain: "Code",
      entityType: "File",
    });
    expect(fileEntities).toHaveLength(result.filesWritten);
    const paths = fileEntities.map((e) => e.name);
    expect(paths).toContain("package.json");
    expect(paths).toContain("CLAUDE.md");
    for (const entity of fileEntities) {
      expect(entity.sourceSystem).toBe("github");
      expect(entity.sourceRef).toMatch(
        new RegExp(`^github:${OWNER}/${REPO}@[0-9a-f]+:`),
      );
    }

    const relationships = await queryRelationships({
      relationshipType: "CONTAINS",
      fromEntityId: result.repositoryEntityId,
    });
    expect(relationships).toHaveLength(result.filesWritten);
    for (const rel of relationships) {
      expect(fileEntities.map((e) => e.id)).toContain(rel.toEntityId);
    }
  });

  test("idempotency: running sync twice does not create duplicate entities or relationships", async () => {
    const first = await syncGitHubRepository({ owner: OWNER, repo: REPO });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unreachable");

    const second = await syncGitHubRepository({ owner: OWNER, repo: REPO });
    expect(second.status).toBe("ok");
    if (second.status !== "ok") throw new Error("unreachable");

    expect(second.repositoryEntityId).toBe(first.repositoryEntityId);
    expect(second.filesWritten).toBe(first.filesWritten);

    const repoEntities = await findEntities({
      domain: "Code",
      entityType: "Repository",
    });
    expect(repoEntities).toHaveLength(1);

    const fileEntities = await findEntities({
      domain: "Code",
      entityType: "File",
    });
    expect(fileEntities).toHaveLength(first.filesWritten);

    const relationships = await queryRelationships({
      relationshipType: "CONTAINS",
      fromEntityId: first.repositoryEntityId,
    });
    expect(relationships).toHaveLength(first.filesWritten);
  });

  test("never fabricates data on failure: tree fetch fails after repo lookup succeeds -> ConnectionFailure, zero Brain writes", async () => {
    // Real fetch for the repo lookup (so it genuinely succeeds against the
    // live API), but the tree-fetch URL is intercepted and made to throw —
    // this is the exact "fetch succeeded, then the next fetch failed"
    // scenario that a live-only test setup can't reliably reproduce, so we
    // reuse Task 1's fetchImpl injection point (threaded through sync.ts's
    // opts parameter) to simulate it deterministically.
    const fetchImpl = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/git/trees/")) {
        throw new Error("simulated tree-fetch network failure");
      }
      return fetch(url, init);
    }) as unknown as typeof fetch;

    const result = await syncGitHubRepository(
      { owner: OWNER, repo: REPO },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      status: "unavailable",
      detail: "simulated tree-fetch network failure",
    });

    const repoEntities = await findEntities({
      domain: "Code",
      entityType: "Repository",
    });
    expect(
      repoEntities.filter((e) => e.sourceSystem === "github"),
    ).toHaveLength(0);

    const fileEntities = await findEntities({
      domain: "Code",
      entityType: "File",
    });
    expect(
      fileEntities.filter((e) => e.sourceSystem === "github"),
    ).toHaveLength(0);

    const relationships = await queryRelationships({
      relationshipType: "CONTAINS",
    });
    expect(relationships).toHaveLength(0);
  });

  test("continue without source: GITHUB_TOKEN unset -> not_connected, no throw, Brain unaffected", async () => {
    delete process.env.GITHUB_TOKEN;

    const result = await syncGitHubRepository({ owner: OWNER, repo: REPO });

    expect(result).toEqual({ status: "not_connected" });

    const repoEntities = await findEntities({
      domain: "Code",
      entityType: "Repository",
    });
    expect(repoEntities).toHaveLength(0);
  });
});
