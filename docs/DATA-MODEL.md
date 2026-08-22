# Data Model

Companion to [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) and
[`SEQUENCE-DIAGRAMS.md`](./SEQUENCE-DIAGRAMS.md). Two views of the same data: the persisted
Postgres schema (ERD), and the TypeScript domain types built on top of it (class diagram).

Source of truth for the ERD: `migrations/0001_init.sql`. Source of truth for the class diagram:
`src/brain/types.ts` and `src/agent/types.ts`.

---

## 1. Entity-Relationship Diagram — Postgres schema

```mermaid
erDiagram
    entities ||--o{ relationships : "from_entity_id"
    entities ||--o{ relationships : "to_entity_id"
    relationships ||--o{ relationship_provenance : "relationship_id"
    relationships ||--o| relationships : "superseded_by (self-ref)"

    entities {
        uuid id PK
        text domain "CHECK: Code|Runtime|Data|Business|Organization|Operational Knowledge"
        text entity_type "free text, not controlled vocab"
        text name
        text source_system "github|postgres|datadog|pagerduty|slack|manual"
        text source_ref "back-reference, e.g. github:acme/repo:path"
        jsonb attributes "small derived facts only, never full source content"
        timestamptz created_at
        timestamptz updated_at
        UNIQUE source_system_source_ref "UNIQUE(source_system, source_ref)"
    }

    relationships {
        uuid id PK
        uuid from_entity_id FK
        uuid to_entity_id FK
        text relationship_type "CHECK: 18-value controlled vocabulary"
        jsonb attributes "the VERSIONED payload"
        numeric confidence "nullable, 0-1, never defaulted"
        text status "current | historical"
        timestamptz valid_from
        timestamptz valid_until "NULL = still open"
        uuid superseded_by FK "self-ref to relationships.id"
        timestamptz created_at
    }

    relationship_provenance {
        uuid id PK
        uuid relationship_id FK
        text source_system
        text source_ref "commit sha, Datadog query id, PagerDuty incident id, ..."
        numeric confidence "nullable, 0-1"
        timestamptz observed_at
        text notes
        timestamptz created_at
        UNIQUE idempotent_guard "UNIQUE(relationship_id, source_system, source_ref)"
    }
```

### Key constraints not visible in a plain ER diagram

- **`relationships_current_identity_uniq`** — a *partial* unique index:
  `UNIQUE (from_entity_id, to_entity_id, relationship_type) WHERE status = 'current'`. This is the
  invariant the whole versioning algorithm in `relationships.ts` is built around: at most one
  `current` row per identity triple, but unlimited `historical` rows.
- **`entities` identity** is `UNIQUE (source_system, source_ref)`, not `id` — that's what makes
  `upsertEntity`'s `ON CONFLICT DO UPDATE` work as an upsert keyed on origin, not on a
  caller-supplied id.
- **`relationship_provenance`'s** `UNIQUE (relationship_id, source_system, source_ref)` is the
  idempotent-reingestion guard — the same observation from the same source can be recorded twice
  with zero effect (`INSERT ... ON CONFLICT DO NOTHING`).
- This schema is **single-tenant by design** (see the migration's own comment) — no `tenant_id`
  anywhere. Adding multi-tenancy later would touch both unique indexes above plus every query
  predicate in `query.ts`/`relationships.ts`.
- `entity_type` is free text (`'Repository'`, `'File'`, `'Service'`, `'Table'`, ...) — only
  `domain` and `relationship_type` are DB-enforced controlled vocabularies.

---

## 2. Class Diagram — TypeScript domain types

Two type families, matching the two modules that own them: the Brain's persisted types
(`src/brain/types.ts`, mirrors the tables above 1:1), and the Investigation Agent's in-memory
types (`src/agent/types.ts`, not persisted — `InvestigationState` lives only in process memory for
the duration of one investigation).

```mermaid
classDiagram
    class Domain {
        <<enum>>
        Code
        Runtime
        Data
        Business
        Organization
        Operational_Knowledge
    }

    class RelationshipType {
        <<enum>>
        CONTAINS
        CALLS
        DEPENDS_ON
        READS
        WRITES
        PUBLISHES
        CONSUMES
        TRIGGERS
        TRANSITIONS_TO
        IMPLEMENTS
        STORED_IN
        OWNED_BY
        PART_OF
        CAUSED
        RESOLVED_BY
        RELATED_TO
        CHANGED_BY
        OBSERVED_IN
    }

    class Entity {
        +string id
        +Domain domain
        +string entityType
        +string name
        +string sourceSystem
        +string sourceRef
        +Record~string,unknown~ attributes
        +Date createdAt
        +Date updatedAt
    }

    class Relationship {
        +string id
        +string fromEntityId
        +string toEntityId
        +RelationshipType relationshipType
        +Record~string,unknown~ attributes
        +number|null confidence
        +"current"|"historical" status
        +Date validFrom
        +Date|null validUntil
        +string|null supersededBy
        +Date createdAt
    }

    class Provenance {
        +string id
        +string relationshipId
        +string sourceSystem
        +string sourceRef
        +number|null confidence
        +Date observedAt
        +string|null notes
        +Date createdAt
    }

    Entity "1" --> "1" Domain : domain
    Relationship "1" --> "1" RelationshipType : relationshipType
    Entity "1" <-- "0..*" Relationship : fromEntityId
    Entity "1" <-- "0..*" Relationship : toEntityId
    Relationship "1" --> "0..1" Relationship : supersededBy (self-ref)
    Relationship "1" <-- "1..*" Provenance : relationshipId

    class HypothesisStatus {
        <<enum>>
        INVESTIGATING
        CONFIRMED
        REFUTED
    }

    class Evidence {
        +string id
        +string toolSource
        +string description
        +Date timestamp
        +unknown raw
    }

    class Hypothesis {
        +string id
        +string statement
        +Evidence[] supportingEvidence
        +Evidence[] contradictingEvidence
        +HypothesisStatus status
        +number confidence
    }

    class InvestigationState {
        +Hypothesis[] hypotheses
    }

    class InvestigationResult {
        <<discriminated union>>
        CONFIRMED: hypothesis, rca, evidenceTrail
        INSUFFICIENT_EVIDENCE: hypothesesConsidered, reason
    }

    Hypothesis "1" --> "1" HypothesisStatus : status
    Hypothesis "1" *-- "0..*" Evidence : supportingEvidence
    Hypothesis "1" *-- "0..*" Evidence : contradictingEvidence
    InvestigationState "1" *-- "0..*" Hypothesis : hypotheses
    InvestigationResult ..> Hypothesis : references
```

### Reading the two halves together

- `Evidence.toolSource` is a free string (e.g. `"query_brain"`, `"search_code"`) naming which of
  the six agent tools produced it — there's no formal enum tying it back to the tool definitions
  in `tools.ts`.
- `Evidence.raw` is typed `unknown` and, per the current `update_hypothesis` handler, always
  `null` — the type supports carrying the underlying tool result for inspection, but nothing wires
  a real value into it yet (see the "Known gaps" section of `HOW-IT-WORKS.md`).
- `Hypothesis`/`Evidence`/`InvestigationState` are **not** persisted anywhere — no
  `investigations` or `hypotheses` table exists in `migrations/`. An investigation's reasoning
  trail currently disappears when the process holding `InvestigationState` exits.
- The only durable link between the two halves is `Evidence.toolSource` naming `query_brain` /
  `search_code`, which internally read `Entity`/`Relationship` rows — but that link is by
  convention (a string), not enforced by any type.
