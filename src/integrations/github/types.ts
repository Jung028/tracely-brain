// Shared result types for the GitHub source integration (module 02).
//
// `ConnectionFailure` is the typed failure surface every client/sync
// function returns instead of throwing for "expected" failure modes (not
// connected, expired auth, insufficient permissions, source unavailable,
// query failure). Only genuinely unexpected bugs are allowed to throw — see
// the module plan's "never fabricate data on failure" constraint.
export type ConnectionFailure =
  | { status: "not_connected" }
  | { status: "auth_expired"; detail: string }
  | { status: "insufficient_permissions"; detail: string }
  | { status: "unavailable"; detail: string }
  | { status: "query_failed"; detail: string };

// Result of a full sync run (produced by sync.ts's syncGitHubRepository,
// Task 2). Declared here alongside ConnectionFailure since both are part of
// this module's shared result-type vocabulary.
export type SyncResult =
  | { status: "ok"; repositoryEntityId: string; filesWritten: number }
  | ConnectionFailure;

// One entry from GitHub's recursive git tree API
// (GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1).
export interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}
