// Public barrel export for the GitHub source integration (module 02).
//
// This is the ONLY entry point future callers (module 03's Investigation
// Agent, or a scheduling/orchestration layer — neither exists yet) should
// import from. `client.ts`'s low-level pieces (`getRepo`, `getTreeRecursive`,
// `classifyGitHubResponse`) are implementation details of the sync and are
// deliberately not re-exported here — see the module plan's Task 3.
export { syncGitHubRepository } from "./sync";
export type { ConnectionFailure, SyncResult } from "./types";
