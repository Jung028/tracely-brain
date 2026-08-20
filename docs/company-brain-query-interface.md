# Company Brain — Query Interface

This documents the read-only query interface exposed by `src/brain/query.ts` (re-exported from
`src/brain/index.ts`), for consumption by a future module (03, Investigation Agent — not part of
this plan) or by module 02 (source integrations) when it needs to read back what it wrote.

This is FR-6's "documented" requirement from `specs/01-company-brain.md`. Signatures below are
copied from the actual implementation in `src/brain/query.ts` — keep this file in sync with that
file if the signatures change.

All functions are pure data access: no hypothesis generation, no evidence scoring, no
investigation logic. That logic belongs in module 03.

## Import

```ts
import {
  queryRelationships,
  getRelationshipHistory,
  getProvenance,
  traverse,
  isValidRelationshipType,
} from "../brain"; // src/brain/index.ts
```

Calling these via `src/brain/index.ts` (rather than importing `query.ts` directly) is what fires
the `onRead` audit hook — see [Audit hooks](#audit-hooks) below.

---

## `queryRelationships`

```ts
interface QueryRelationshipsFilter {
  /** Matches either endpoint entity's domain. */
  domain?: Domain;
  relationshipType?: RelationshipType | RelationshipType[];
  /** Default 'current'. Ignored when `validAt` is set. */
  status?: "current" | "historical" | "any";
  /**
   * When set, overrides status filtering with
   * valid_from <= validAt AND (valid_until IS NULL OR valid_until > validAt).
   */
  validAt?: Date;
  fromEntityId?: string;
  toEntityId?: string;
  limit?: number;
}

function queryRelationships(
  filter: QueryRelationshipsFilter,
): Promise<Relationship[]>;
```

Filtered listing of relationships. All filter fields are optional and combine with AND. An empty
filter (`{}`) returns all current relationships.

**Example** — all current `DEPENDS_ON` edges within the `Runtime` domain:

```ts
const edges = await queryRelationships({
  domain: "Runtime",
  relationshipType: "DEPENDS_ON",
  status: "current",
  limit: 100,
});
```

**Example** — point-in-time query, ignoring `status` (overridden by `validAt`):

```ts
const edgesAtIncidentStart = await queryRelationships({
  fromEntityId: serviceEntity.id,
  validAt: new Date("2026-08-15T09:00:00Z"),
});
```

---

## `getRelationshipHistory`

```ts
function getRelationshipHistory(
  fromEntityId: string,
  toEntityId: string,
  relationshipType: RelationshipType,
): Promise<Relationship[]>;
```

Returns every version (current and historical) of a single identity triple
(`from_entity_id`, `to_entity_id`, `relationship_type`), ordered oldest first by `valid_from`.
Use this to see how a specific edge's `attributes` changed over time (see
[write-path outcomes](#write-path-outcomes) below for how versions get created).

**Example**:

```ts
const versions = await getRelationshipHistory(
  serviceEntity.id,
  databaseEntity.id,
  "DEPENDS_ON",
);
// versions[0] is the oldest; the entry with status === "current" (if any) is the latest.
```

---

## `getProvenance`

```ts
function getProvenance(relationshipId: string): Promise<Provenance[]>;
```

Returns every observation (source system + source ref + when it was observed) that corroborated
a specific relationship row, ordered oldest first by `observed_at`. Use this to answer "which
source systems told us about this edge, and when."

**Example**:

```ts
const observations = await getProvenance(currentRelationship.id);
// e.g. [{ sourceSystem: "github", sourceRef: "org/repo#L42", observedAt: ... }, ...]
```

---

## `traverse`

```ts
interface TraverseParams {
  startEntityId: string;
  /** Omit = any type. */
  relationshipTypes?: RelationshipType[];
  /** Default 'outgoing'. See note below on 'both'. */
  direction?: "outgoing" | "incoming" | "both";
  /** REQUIRED — no default. Caller must always bound recursion explicitly. */
  maxDepth: number;
  /** Default: current relationships only. */
  validAt?: Date;
}

interface TraverseResult {
  entities: Entity[];
  relationships: (Relationship & { depth: number })[];
}

function traverse(params: TraverseParams): Promise<TraverseResult>;
```

Recursive graph walk from a starting entity, up to `maxDepth` hops, returning every entity and
relationship touched along the way (each relationship annotated with the depth at which it was
first reached).

**Important semantics for `direction: "both"`:** this is a union of two direction-consistent
walks (one all-outgoing, one all-incoming) from the start entity — **not** full undirected
reachability. Neither walk ever changes direction mid-path. For example, given
`ServiceA --DEPENDS_ON--> DB <--DEPENDS_ON-- ServiceB`, traversing from `ServiceA` with
`direction: "both"` returns the `ServiceA -> DB` edge but never reaches `ServiceB`, because there
is no all-outgoing or all-incoming path from A to B — only a path that goes out then back in,
which this traversal does not follow.

**Example** — what does this service depend on, up to 3 hops out:

```ts
const { entities, relationships } = await traverse({
  startEntityId: serviceEntity.id,
  relationshipTypes: ["DEPENDS_ON", "CALLS"],
  direction: "outgoing",
  maxDepth: 3,
});
```

**Example** — point-in-time traversal as of an incident window:

```ts
const blastRadius = await traverse({
  startEntityId: incidentEntity.id,
  direction: "both",
  maxDepth: 2,
  validAt: new Date("2026-08-15T09:00:00Z"),
});
```

---

## `isValidRelationshipType`

```ts
function isValidRelationshipType(value: string): value is RelationshipType;
```

Type guard against the controlled relationship-type vocabulary (`RelationshipType` in
`src/brain/types.ts`). Use this to validate untrusted input (e.g. from module 02's ingestion
adapters) before calling a write-path function, which will otherwise throw
`InvalidRelationshipTypeError` for an invalid value.

**Example**:

```ts
if (!isValidRelationshipType(candidateType)) {
  throw new Error(`Unrecognized relationship type from source: ${candidateType}`);
}
```

Note: this is a pure in-memory check with no database access — it does not fire the `onRead`
audit hook (see below).

---

## Write-path outcomes

The write-path (`src/brain/relationships.ts`, primarily `recordRelationshipObservation`) is not
part of this document's function list, but its result shape matters to any caller reading query
results afterward — including module 03, which may need to explain *why* a relationship looks
the way it does.

```ts
type RecordRelationshipObservationResult = {
  action: "created" | "retained" | "corroborated" | "versioned";
  relationship: Relationship;
};
```

Every call to `recordRelationshipObservation` resolves to exactly one of four outcomes:

- **`created`** — no current relationship existed for the identity triple
  (`from_entity_id`, `to_entity_id`, `relationship_type`) yet. A new relationship row and its
  first provenance row were inserted.
- **`retained`** — a current relationship already existed with the same `attributes` payload,
  and this exact `(source_system, source_ref)` had already corroborated it before. Pure no-op —
  nothing was written. This makes re-ingestion from the same source idempotent.
- **`corroborated`** — a current relationship already existed with the same `attributes`
  payload, but this is a *new* `(source_system, source_ref)` observing it. Only a new provenance
  row was added; the relationship row itself is untouched. This is how confidence in an edge
  accumulates across multiple source systems agreeing on it.
- **`versioned`** — a current relationship already existed but with a *different* `attributes`
  payload. The old row is marked `historical` (with `valid_until` set and `superseded_by`
  pointing at the new row), and a new `current` row is inserted with the new attributes and a
  fresh provenance row. `getRelationshipHistory` on the same identity triple will now return both
  rows.

Identity for versioning purposes is the triple `(from_entity_id, to_entity_id,
relationship_type)`. What counts as "changed" is the `attributes` jsonb payload only, compared by
exact structural equality — confidence and provenance fields (`source_system`, `source_ref`,
`observed_at`, per-observation `confidence`, `notes`) are always additive and never trigger
versioning on their own.

Two related write-path functions exist for cases outside this core algorithm:

- **`supersedeRelationship`** — an explicit escape hatch for when a caller already knows two
  different-identity edges represent the same functional slot over time (e.g. a service rename
  changes `to_entity_id`, but conceptually it's "the same" relationship). Same transactional
  shape as `versioned` above.
- **`updateRelationshipConfidence`** — in-place update of a current relationship's `confidence`
  only. Never touches `status`/`valid_from`/`valid_until`/`superseded_by` — this is not a
  versioning event.

---

## Audit hooks

`src/brain/index.ts` (the barrel a future module 03 imports from) provides an optional audit-hook
seam per NFR-10:

```ts
interface BrainHookEvent {
  operation: string;
  actor?: string;
  timestamp: Date;
}

interface BrainHooks {
  onRead?: (event: BrainHookEvent) => void;
  onWrite?: (event: BrainHookEvent) => void;
}

function configureBrainHooks(hooks: BrainHooks): void;
```

This is a seam only — there is no logging backend, no storage, and no retention policy built in.
`configureBrainHooks` registers process-wide callbacks (each optional, defaulting to a no-op);
`onRead` fires after a successful call to any read-path function exported from the barrel
(`getEntity`, `findEntities`, `queryRelationships`, `getRelationshipHistory`, `getProvenance`,
`traverse`), and `onWrite` fires after a successful call to any write-path function
(`upsertEntity`, `recordRelationshipObservation`, `supersedeRelationship`,
`updateRelationshipConfidence`). Hooks only fire for calls made through the `src/brain/index.ts`
barrel; calling `entities.ts`/`relationships.ts`/`query.ts` functions directly bypasses them.

A caller (e.g. a future logging integration) is expected to plug in `onRead`/`onWrite`
implementations themselves — this module makes no logging decisions on their behalf.
