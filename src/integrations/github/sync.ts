// Orchestrates the GitHub API client (Task 1, client.ts) and the Company
// Brain's write-path (module 01, src/brain/index.ts) to sync a repo's file
// structure into the Brain as entities and relationships.
//
// Hard ordering requirement ("never fabricate data on failure"): every fetch
// from GitHub — the repo lookup and the full recursive tree — must succeed
// before any write to the Brain begins. If either fetch resolves to a
// `ConnectionFailure`, this function returns it immediately with zero writes
// having occurred. Nothing below the tree fetch can fail with a GitHub-side
// error, so nothing below it risks a partial write followed by a late
// failure.
//
// Deliberately out of scope for this task (see the module plan):
//   - No Class/Method-level code parsing (AST parsing per language) — only
//     file-level entities.
//   - No directory entities or directory-CONTAINS relationships — `type ===
//     "tree"` tree entries are skipped entirely. Representing directory
//     structure is a second relationship shape nothing in FR-14/15/16
//     requires yet.
import { getRepo, getTreeRecursive, type GitHubFetchOptions } from "./client";
import type { ConnectionFailure, SyncResult } from "./types";
import { recordRelationshipObservation, upsertEntity } from "../../brain";

/**
 * Test-only escape hatch: lets tests inject a `fetchImpl` (same injection
 * point Task 1's client.ts tests use) so failure modes that can't be
 * reliably triggered against the live API — e.g. the tree fetch failing
 * right after the repo lookup succeeds — can be simulated deterministically.
 * Real callers never need to pass this; the public input stays
 * `{ owner, repo }` as specified by the module plan.
 */
export type SyncGitHubRepositoryOptions = GitHubFetchOptions;

export async function syncGitHubRepository(
  input: { owner: string; repo: string },
  opts?: SyncGitHubRepositoryOptions,
): Promise<SyncResult> {
  const { owner, repo } = input;

  // Step 1: fetch the repo. Nothing written yet, and nothing below this
  // point runs if this fails.
  const repoResult = await getRepo(owner, repo, opts);
  if (!("ok" in repoResult) || !repoResult.ok) {
    return repoResult as ConnectionFailure;
  }

  const repoData = repoResult.data as { default_branch?: unknown };
  const ref =
    typeof repoData.default_branch === "string"
      ? repoData.default_branch
      : undefined;
  if (!ref) {
    // Defensive: GitHub's repo response always includes `default_branch` in
    // practice, but treat a missing/malformed field as a typed failure
    // rather than crashing or guessing a ref — still zero writes.
    return {
      status: "query_failed",
      detail: "repo response is missing a usable default_branch",
    };
  }

  // Step 2: fetch the full recursive tree at the default branch. This is
  // the last point that can fail with a GitHub-side error — still zero
  // writes so far.
  const treeResult = await getTreeRecursive(owner, repo, ref, opts);
  if (!("ok" in treeResult) || !treeResult.ok) {
    return treeResult as ConnectionFailure;
  }

  // All fetching is complete and validated. Everything from here on is
  // local write logic that cannot fail with a GitHub-side error, so it's
  // safe to start writing to the Brain.
  const files = treeResult.data.filter((entry) => entry.type === "blob");

  const repositorySourceRef = `github:${owner}/${repo}`;
  const repositoryEntity = await upsertEntity({
    domain: "Code",
    entityType: "Repository",
    name: repo,
    sourceSystem: "github",
    sourceRef: repositorySourceRef,
  });

  let filesWritten = 0;
  for (const file of files) {
    // Per FR-7's back-reference requirement: the ref must let a human trace
    // back to the exact GitHub blob.
    const fileSourceRef = `github:${owner}/${repo}@${file.sha}:${file.path}`;

    const fileEntity = await upsertEntity({
      domain: "Code",
      entityType: "File",
      name: file.path,
      sourceSystem: "github",
      sourceRef: fileSourceRef,
    });

    await recordRelationshipObservation({
      fromEntityId: repositoryEntity.id,
      toEntityId: fileEntity.id,
      relationshipType: "CONTAINS",
      sourceSystem: "github",
      // Matches the file's own source ref, so re-syncing is naturally
      // idempotent through module 01's existing retained/corroborated
      // write-path outcomes — no special-casing needed here.
      sourceRef: fileSourceRef,
    });

    filesWritten++;
  }

  return {
    status: "ok",
    repositoryEntityId: repositoryEntity.id,
    filesWritten,
  };
}
