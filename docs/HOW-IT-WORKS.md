# How It Works

An end-to-end walkthrough of the current codebase: how data gets **ingested**, how it becomes
**relationships** in the Company Brain, and how the Investigation Agent **consumes** them. This is
the connective narrative across modules — for full signatures and edge cases, see
[`company-brain-query-interface.md`](./company-brain-query-interface.md) and
[`github-integration.md`](./github-integration.md).

Only one ingestion source exists today: GitHub file structure. `query_database` and `search_logs`
are wired as agent tools but are stubs — they always return `NOT_IMPLEMENTED`. So the graph this
system can currently build is **code-topology-only**: repositories and files, nothing deeper yet
(no classes, functions, imports, or directories).

---

## 1. Ingestion — `src/integrations/github/sync.ts::syncGitHubRepository`

```ts
syncGitHubRepository({ owner, repo }) -> Promise<SyncResult>
```

**Hard ordering rule, enforced in code:** every GitHub fetch must succeed before any write to the
Brain begins. "Never fabricate data on failure" — if anything below fails, zero writes have
occurred.

1. `getRepo(owner, repo)` — `GET /repos/{owner}/{repo}` via `client.ts`. Any failure (not
   connected, expired auth, insufficient permissions, rate limited, 404, malformed body) resolves
   to a typed `ConnectionFailure` and returns immediately.
2. Read `default_branch` off the response. Missing/malformed → typed failure, not a guessed ref.
3. `getTreeRecursive(owner, repo, ref)` — `GET .../git/trees/{sha}?recursive=1`. Also rejects a
   `truncated: true` response (repo too large for one fetch) as a failure rather than silently
   ingesting a partial tree. This is the last point that can fail with a GitHub-side error.
4. Filter tree entries to `type === "blob"` — files only. `type === "tree"` (directories) is
   skipped entirely; no directory entities or directory-`CONTAINS` relationships exist yet.

`client.ts` itself is read-only by design (GET requests only) and never throws for expected
failure modes — every "expected" failure classifies into `ConnectionFailure`; only a genuine bug
is allowed to throw.

---

## 2. Turning ingested data into entities + relationships

Once both fetches succeed, `sync.ts` writes through the Brain's write-path
(`src/brain/index.ts` → `entities.ts` / `relationships.ts`):

```ts
// One Repository entity
upsertEntity({
  domain: "Code", entityType: "Repository", name: repo,
  sourceSystem: "github", sourceRef: `github:${owner}/${repo}`,
});

// One File entity + one CONTAINS relationship, per blob
upsertEntity({
  domain: "Code", entityType: "File", name: file.path,
  sourceSystem: "github", sourceRef: `github:${owner}/${repo}:${file.path}`,
  attributes: { sha: file.sha },
});

recordRelationshipObservation({
  fromEntityId: repositoryEntity.id,
  toEntityId: fileEntity.id,
  relationshipType: "CONTAINS",
  sourceSystem: "github",
  sourceRef: fileSourceRef, // same ref as the file itself
});
```

Two identity decisions matter here:

- **File identity is path-based**, not blob-sha-based. Editing a file's content doesn't spawn a
  new entity — `upsertEntity`'s `ON CONFLICT (source_system, source_ref)` just updates
  `attributes.sha` in place. The exact blob is still traceable via that field; it's just not part
  of the identity key.
- **Re-syncing is idempotent for free.** Because the `CONTAINS` relationship reuses the file's own
  `sourceRef`, a second sync run lands on `recordRelationshipObservation`'s `retained` /
  `corroborated` outcomes instead of duplicating edges — no special-case dedup logic needed in
  `sync.ts`.

### `recordRelationshipObservation` — the core write-path algorithm (`relationships.ts`)

Identity of an edge = `(fromEntityId, toEntityId, relationshipType)`. Only the `attributes`
payload determines whether something "changed" — provenance fields (source, confidence, notes)
are always additive. Four possible outcomes, computed atomically per call:

| Outcome | When |
|---|---|
| `created` | no current row exists for that identity triple |
| `retained` | current row exists, attributes unchanged, this exact `(sourceSystem, sourceRef)` already recorded it — pure no-op |
| `corroborated` | attributes unchanged, but a *new* source is observing the same edge — provenance-only insert |
| `versioned` | attributes differ — old row flips to `status: "historical"` + `supersededBy`, new row inserted as current, atomically |

---

## 3. Consumption — `src/agent/tools.ts`

The ingested graph is read through two of the six agent tools available to the LLM
(`createTools(state)`). Every tool call is dispatched here; the file's own header states the
governing principle: **"The LLM reasons; our code enforces the rules."**

**Read-only evidence tools** (never touch investigation state):

| Tool | Calls into | Notes |
|---|---|---|
| `query_brain` (`mode: "search"`) | `findEntities({ domain, entityType })` | bootstraps an investigation — find candidate entities with no starting id needed. `domain: "Operational Knowledge"` surfaces candidate historical incidents (still require fresh evidence — never trusted outright) |
| `query_brain` (`mode: "traverse"`) | `traverse({ startEntityId, relationshipTypes, maxDepth })` | walks relationships outward once an entity id is known, e.g. `Repository --CONTAINS--> File` |
| `search_code` | `findEntities` + `getFileContent` (GitHub client) | matches synced file paths by substring, parses `sourceRef` back into `owner/repo`, fetches the actual blob content live from GitHub — the Brain never stores file bodies, only metadata |
| `query_database` | — | **stub**, always `NOT_IMPLEMENTED` |
| `search_logs` | — | **stub**, always `NOT_IMPLEMENTED` |

**Control tools** — the only way the model can mutate investigation state:

| Tool | Calls into | Notes |
|---|---|---|
| `propose_hypothesis` | `hypotheses.ts::proposeHypothesis` | creates a hypothesis, `status: "INVESTIGATING"`, `confidence: 0` |
| `update_hypothesis` | `hypotheses.ts::addSupportingEvidence` / `addContradictingEvidence` | attaches one piece of evidence; **status and confidence are recomputed by our code, never set by the model** |

### The guardrail — `hypotheses.ts`

This is the actual enforcement point for "never fabricate a root cause":

- `confidenceFrom(count) = min(1, count * 0.2)` — a flat, uncalibrated placeholder, explicitly
  marked `TBD` pending real benchmark data (`specs/11-benchmark.md`).
- **`CONFIRMED`** requires confidence ≥ `0.75` **and zero contradicting evidence** — any
  contradiction blocks confirmation regardless of how much supporting evidence exists.
- **`REFUTED`** requires contradiction-weight ≥ `0.75`, and is terminal — a refuted hypothesis
  never resurrects from new evidence; a replacement hypothesis is expected to come from a
  lifecycle layer that doesn't exist yet.

---

## Walkthrough, start to finish

```
syncGitHubRepository({ owner: "acme", repo: "api" })
  → 1 Repository entity + N File entities + N CONTAINS relationships (source: "github")

query_brain({ mode: "search", domain: "Code", entityType: "Repository" })
  → repo entity id

query_brain({ mode: "traverse", startEntityId: repoId,
              relationshipTypes: ["CONTAINS"], maxDepth: 1 })
  → the file list

search_code({ pathContains: "auth" })
  → live content of auth/middleware.ts, fetched straight from GitHub

propose_hypothesis({ statement: "..." })
  → hypothesis created, INVESTIGATING, confidence 0

update_hypothesis({ hypothesisId, direction: "supporting",
                     toolSource: "search_code", description: "..." })
  → repeated until confidence crosses 0.75 with no contradictions (CONFIRMED)
     or contradiction weight crosses 0.75 (REFUTED)
```

## Known gaps

- No automatic re-sync — `syncGitHubRepository` must be triggered manually; no
  scheduling/orchestration layer exists yet.
- `query_database` / `search_logs` are stubs, so no live production telemetry can feed the graph —
  only GitHub file structure can, today.
- `Evidence.raw` is typed `unknown` and always `null` from the tool handler — nothing yet forces a
  model's claimed evidence to be traceable back to a real tool result.
- No directory entities, no code-level parsing (classes/functions/imports) — file-level only.
