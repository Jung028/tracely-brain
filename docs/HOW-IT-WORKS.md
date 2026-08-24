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

### Evidence tool parameters, STEP_ID citation, and concurrencyGroup

Module 04's Task 1 retrofit added the capture layer every evidence-tool call now goes through
(`src/agent/tools.ts`), so a later timeline (below) has something to render.

- **Required `reason` param.** All four evidence tools (`query_brain`, `search_code`,
  `query_database`, `search_logs`) now require a `reason: z.string()` input field, described to the
  model as "Why you're making this call right now, in relation to the current investigation or
  hypothesis." It becomes `ToolCallRecord.why` / `TimelineStep.why`.
- **`STEP_ID:` prefix convention.** Every evidence tool's return value — the text the model actually
  sees, on every code path including early-return guidance strings like `"traverse mode requires
  startEntityId..."` — is prefixed `` STEP_ID: <id>\n `` ahead of its normal output, via a
  `withStepId(id, body)` helper. `<id>` is the `crypto.randomUUID()` id of the `ToolCallRecord` that
  call just created. This is how the model learns a step's id well enough to cite it later: it
  parses the prefix back out (regex `/^STEP_ID: ([^\n]+)\n/`) and passes it as `update_hypothesis`'s
  new optional `stepId` param. See `docs/DATA-MODEL.md`'s "Reading the two halves together" for
  what citing a `stepId` actually does to `Evidence.raw`.
- **`concurrencyGroup` derivation.** `InvestigationState` (`src/agent/tools.ts`) carries two extra
  fields purely to compute this: `batchCounter: number` and `batchOpen: boolean`. Each evidence
  tool's `run()` handler calls `beginToolCall(state)` as its first line — synchronously, before any
  `await` in that handler:
  - If `state.batchOpen` is `false`, it increments `batchCounter`, sets `batchOpen = true`, and
    schedules a `queueMicrotask(() => { state.batchOpen = false })` — only on this open transition,
    not on every call.
  - It returns `{ id, concurrencyGroup: `batch-${batchCounter}` }` immediately.
  - Once the tool's real (possibly `await`-ing) work completes, `finishToolCall(state, handle,
    toolName, input, result)` pushes the actual `ToolCallRecord` using that handle's `id` /
    `concurrencyGroup`.

  This works because the Anthropic SDK's `BetaToolRunner` dispatches every `tool_use` block from one
  assistant turn via `Promise.all(toolUseBlocks.map(async (toolUse) => { ... }))` — array/argument
  evaluation in JS is synchronous left-to-right, and each `run()` call executes synchronously up to
  its own first `await`, so every same-turn call's `beginToolCall` runs back-to-back with zero
  microtask ticks in between before any of them suspend. That means every call in one synchronous
  dispatch burst (i.e. one turn) reliably finds `batchOpen === true` (except the first, which opens
  it) and shares a `concurrencyGroup`; a call from a genuinely later turn runs only after that
  microtask has already fired, finds `batchOpen === false` again, and starts a new group. The
  `BetaRunnableTool` `run(input, context)` signature itself exposes no shared per-turn identifier —
  only a per-call `toolUse` and an abort `signal` — so this `queueMicrotask` timing trick is the real
  signal, not a documented SDK guarantee.

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

## 4. Timeline — `src/timeline/`

Module 04 adds a rendering layer on top of everything above — it generates nothing new, it only
formats and displays the `ToolCallRecord[]` module 03 already captures (see
`docs/DATA-MODEL.md` section 3 for the type shapes).

- **`buildTimeline(toolCalls: readonly ToolCallRecord[]): InvestigationTimeline`**
  (`src/timeline/build.ts`) is the pure transform: maps each `ToolCallRecord` to a `TimelineStep`
  (renaming only `input` → `query`), then sorts the result ascending by `timestamp`. No I/O.
- **The UI** (`src/timeline/server.ts`, a `Bun.serve()` app using the project's mandated
  `routes`-config + HTML-import pattern — no `vite`, no `express`) exposes three routes:
  - `"/"` → `src/timeline/index.html`, which loads `src/timeline/frontend.tsx`. That fetches
    `/api/timeline/demo` on mount and renders `<TimelineView />` (`src/timeline/TimelineView.tsx`)
    via `createRoot`.
  - `"/api/timeline/demo"` (`GET`) → `Response.json(buildTimeline(demoToolCalls))`, where
    `demoToolCalls` (`src/timeline/demoFixture.ts`) is a hand-authored `ToolCallRecord[]` telling
    the spec's WAIT_JUDGE demo story (`specs/04-evidence-timeline.md`'s "Suggested first Claude
    Code session") — no live Anthropic call or seeded Company Brain needed to see the UI working.
  - `"/api/investigate"` (`POST`) → validates a JSON body `{ problemDescription: string }` (400 on
    invalid JSON or a missing/empty/non-string `problemDescription`), otherwise calls the real
    `investigate(...)` from `src/agent` and returns `{ result, timeline:
    buildTimeline(result.toolCalls) }`. This path needs a real `ANTHROPIC_API_KEY` to complete.
  - The server auto-starts only when run directly (`if (import.meta.main)`), so `createServer(port)`
    can be imported and started on an ephemeral port from tests without side effects.
- **`TimelineView.tsx`** renders a chronological, collapsed-by-default, click-to-expand list
  (FR-23). The collapsed headline already shows `toolName`; expanding a step additionally shows
  `why`, `query`, and `result`, plus a hypothesis-linkage line (FR-24 / NFR-18 — always an
  explicit visible state, never blank):
  `` Supports: H1 — scheduler-related workflow blockage `` for a supporting step,
  `` Refutes: H1 — <meaning> `` for a contradicting one, or
  `` Exploratory — not linked to a hypothesis `` when `hypothesisId` is `null`. Steps sharing a
  `concurrencyGroup` are grouped into a visually distinct "Ran in parallel" block instead of being
  rendered as a single misleading linear sequence (the FR-18/spec parallel-tool test case).
- **Run it locally:** `bun --hot src/timeline/server.ts` — listens at `http://localhost:4300/`
  (`DEFAULT_PORT = 4300`, exported from `src/timeline/server.ts`; `createServer(port)` accepts an
  override).

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
- `Evidence.raw` is typed `unknown` and is `null` from the tool handler **unless**
  `update_hypothesis` is called with a `stepId` that matches a prior evidence-tool call's id (see
  "Evidence tool parameters, STEP_ID citation, and concurrencyGroup" in section 3 above) — when it doesn't match
  (or `stepId` is omitted, which is still a valid, backward-compatible call), `raw` stays `null`, so
  a model can still claim evidence without a real tool result backing it.
- No directory entities, no code-level parsing (classes/functions/imports) — file-level only.
