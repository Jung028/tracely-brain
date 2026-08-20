# GitHub Source Integration

This documents the GitHub source integration (module 02, GitHub slice): connects to GitHub's
REST API, reads a repository's file tree, and writes it into the Company Brain (module 01) as
`Repository`/`File` entities and `CONTAINS` relationships.

For consumption by a future module (03, Investigation Agent — not part of this plan) or any
future scheduling/orchestration layer that needs to trigger a sync and react to its result.

Signatures below are copied from the actual implementation in `src/integrations/github/sync.ts`
and `src/integrations/github/types.ts` — keep this file in sync with those files if the
signatures change.

## Import

```ts
import { syncGitHubRepository } from "../integrations/github"; // src/integrations/github/index.ts
```

Only `syncGitHubRepository` and the `ConnectionFailure`/`SyncResult` types are part of this
module's public contract. `client.ts`'s low-level pieces (`getRepo`, `getTreeRecursive`,
`classifyGitHubResponse`) are internal to the sync and are not exported from the barrel — they
are implementation details, not something a caller should need to react to directly.

---

## `syncGitHubRepository`

```ts
function syncGitHubRepository(
  input: { owner: string; repo: string },
): Promise<SyncResult>;
```

*(The real implementation in `sync.ts` also accepts an optional second parameter,
`opts?: SyncGitHubRepositoryOptions` — a test-only `fetchImpl` injection point used to
deterministically simulate failure modes. It's omitted above since it's not part of the public
contract; real callers should only ever pass `{ owner, repo }`.)*

Fetches a repository's metadata and full recursive file tree from GitHub, then writes it into the
Brain:

- One `Repository` entity (`domain: "Code"`, `entityType: "Repository"`, `sourceSystem: "github"`,
  `sourceRef: "github:{owner}/{repo}"`).
- One `File` entity per tree entry where `type === "blob"` (`domain: "Code"`,
  `entityType: "File"`, `sourceRef: "github:{owner}/{repo}:{path}"` — path-based so identity stays
  stable across commits; `attributes.sha` carries the blob sha so a human can still trace back to
  the exact GitHub blob without it being part of the identity key).
- One `CONTAINS` relationship per file, from the Repository entity to the File entity, via module
  01's `recordRelationshipObservation` — this makes re-syncing naturally idempotent through module
  01's existing `retained`/`corroborated` write-path outcomes.

Directory entries (`type === "tree"`) are skipped entirely — no directory entities or
directory-`CONTAINS` relationships are created. Representing directory structure is a deliberate
scope cut; nothing in this module's requirements need it yet.

**Ordering guarantee ("never fabricate data on failure"):** both the repo lookup and the full
recursive tree fetch must succeed *before any write to the Brain begins*. If either fetch resolves
to a `ConnectionFailure`, `syncGitHubRepository` returns it immediately with zero writes having
occurred — no partial, guessed, or placeholder data ever lands in the Brain. This guarantee covers
GitHub-side failures only (auth, permissions, network, rate-limit, not-found, malformed/truncated
response) — on any of those, zero rows are written because the sync fails before any write begins.
It does not cover a database-level failure mid-write (e.g. Postgres becoming unavailable partway
through writing file entities); that scenario is not currently guarded by a transaction and could
leave a partial write behind.

**Example:**

```ts
const result = await syncGitHubRepository({ owner: "Jung028", repo: "tracely-brain" });

if (result.status === "ok") {
  console.log(`synced ${result.filesWritten} files, repository entity ${result.repositoryEntityId}`);
} else {
  // result is a ConnectionFailure — see below for what each status means.
  console.warn(`GitHub sync failed: ${result.status}`);
}
```

---

## `SyncResult`

```ts
type SyncResult =
  | { status: "ok"; repositoryEntityId: string; filesWritten: number }
  | ConnectionFailure;
```

- **`ok`** — the sync completed and wrote to the Brain. `repositoryEntityId` is the id of the
  upserted `Repository` entity; `filesWritten` is the count of `File` entities processed (each
  with its `CONTAINS` relationship recorded).
- Any other `status` is a `ConnectionFailure` variant (below) — the sync made zero writes to the
  Brain.

## `ConnectionFailure`

```ts
type ConnectionFailure =
  | { status: "not_connected" }
  | { status: "auth_expired"; detail: string }
  | { status: "insufficient_permissions"; detail: string }
  | { status: "unavailable"; detail: string }
  | { status: "query_failed"; detail: string };
```

This is the typed failure surface returned (never thrown) for every "expected" failure mode. Only
a genuinely unexpected bug is allowed to throw. A caller should treat any non-`"ok"` `SyncResult`
as "continue without this source" — the function always returns normally, and the Brain is
guaranteed unaffected.

- **`not_connected`** — no `GITHUB_TOKEN` is configured. Detected before any network call.
- **`auth_expired`** — GitHub returned HTTP 401 ("Bad credentials"). `detail` carries GitHub's
  error message (or the response's status text as a fallback).
- **`insufficient_permissions`** — GitHub returned HTTP 403 for a reason other than rate limiting
  (see the classification table below for how this is distinguished from `unavailable`). `detail`
  carries GitHub's error message.
- **`unavailable`** — either a network-level failure (connection refused, timeout, DNS failure —
  the underlying `fetch` call threw), or GitHub returned HTTP 403 specifically because of rate
  limiting. `detail` carries the underlying error message, or `"rate limited"` for the rate-limit
  case.
- **`query_failed`** — GitHub returned HTTP 404 (repo/ref not found), any other non-2xx status, a
  response body that couldn't be parsed as JSON, a 200 tree response missing/malformed `tree`
  array, or a tree response with `truncated: true` (repo too large for a single tree fetch).
  `detail` carries context (URL, status, or parse error) about what went wrong.

---

## Failure-mode classification design

GitHub's actual HTTP responses don't map 1:1 onto a "not connected / auth expired / insufficient
permissions / unavailable / query failed" taxonomy, so the mapping below is deliberate, not a
literal transcription of GitHub's status codes:

| Failure mode | How it's triggered/classified |
|---|---|
| Not connected at all | No `GITHUB_TOKEN` configured — checked before any network call, via `getGitHubToken()` returning `null`. |
| Authorization expired mid-use | GitHub returns HTTP 401 ("Bad credentials"). |
| Insufficient permissions | GitHub returns HTTP 403 **without** an `x-ratelimit-remaining: 0` header — i.e. a genuine permissions denial, not rate limiting. |
| Source unavailable (timeout/down/rate-limited) | Either a network-level failure (the `fetch` call itself throws — connection refused, timeout, DNS failure), **or** GitHub returns HTTP 403 **with** an `x-ratelimit-remaining: 0` header. GitHub uses 403 for both rate limiting and permissions denial; the rate-limit header is the only reliable discriminator between the two. Rate limiting is transient/retryable, so it's classified as `unavailable` rather than `insufficient_permissions`. |
| Source query failure (valid connection, query errors) | GitHub returns HTTP 404 (repo/ref not found), any other non-2xx status, or a response body that fails to parse as JSON. |
| "Continue without source" | The caller always receives a typed `ConnectionFailure` result, never a thrown exception — `syncGitHubRepository` returns normally with zero writes, and the caller can proceed with whatever else it's doing. |
| Investigation impossible → `NOT_CONFIRMED`/`MANUAL_REVIEW_REQUIRED` path | Module 05 (failure-handling) doesn't exist yet, so this module doesn't implement that state machine. What this module guarantees is that a sync failure is always a distinguishable typed result (never a crash, never a silent partial success) so that whatever module 05 becomes can correctly route it. |

---

## Environment variables

- **`GITHUB_TOKEN`** (required) — a GitHub personal access token with `repo` scope. Read via
  `process.env.GITHUB_TOKEN` (`src/integrations/github/client.ts`'s `getGitHubToken()`). If unset
  or empty, every sync call returns `{ status: "not_connected" }` without making a network call.
- **`GITHUB_REPO`** (format `owner/repo`) — set in `.env.test` alongside `GITHUB_TOKEN` per the
  module's local-dev convention, but **not currently read by any code**. `syncGitHubRepository`
  itself takes `{ owner, repo }` directly, and the test suite (`tests/integrations/github/*.test.ts`)
  hardcodes its target repo as literal `OWNER`/`REPO` constants rather than reading this var. It's
  reserved for a future caller that wants a configured default target, not part of any current
  contract.

Both are set in `.env.test` for local development/testing (gitignored) and have placeholder
entries in `.env.example`.

---

## Read-only guarantee

Every request `src/integrations/github/client.ts` makes to GitHub is a `GET`. No write
(`POST`/`PATCH`/`DELETE`) call to GitHub exists anywhere in this module, and none should ever be
added — GitHub is a source system, and Tracely never mutates the systems it observes.
