# Module 01 — Company Brain (core representation + construction/updates)

Build this first. Nothing else in Tracely works without it.

## Purpose

Maintain a persistent, queryable graph of entities and relationships describing how the
company's technical and business systems relate — built initially from GitHub, then enriched
from other sources.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Maintain a persistent, queryable graph representation of entities and relationships. | MUST |
| FR-2 | Model entities across five domains: Code, Runtime, Data, Business, Organization, Operational Knowledge. | MUST |
| FR-3 | Represent relationships using a controlled vocabulary only: `CONTAINS, CALLS, DEPENDS_ON, READS, WRITES, PUBLISHES, CONSUMES, TRIGGERS, TRANSITIONS_TO, IMPLEMENTS, STORED_IN, OWNED_BY, PART_OF, CAUSED, RESOLVED_BY, RELATED_TO, CHANGED_BY, OBSERVED_IN`. | MUST |
| FR-4 | Every relationship carries metadata: `source, confidence, valid_from, valid_until, provenance, status`. | MUST |
| FR-5 | A relationship independently observed by a second source is recorded as additional provenance on the existing relationship, not a duplicate. | MUST |
| FR-6 | The Brain is queryable by the Investigation Agent to retrieve context for a request. | MUST |
| FR-7 | Entities reference back to their originating source (e.g. GitHub repo + commit) instead of duplicating content. | MUST |
| FR-8 | Build the initial factual map from GitHub (code structure) before enriching with runtime/operational sources. | MUST |
| FR-9 | Enrich and validate the code-derived map using PostgreSQL, Datadog, PagerDuty, Slack data. | MUST |
| FR-10 | On new information, extract entities/relationships and compare against the existing Brain. | MUST |
| FR-11 | If a relationship is unchanged, retain it as-is. | MUST |
| FR-12 | If a relationship changed, version it — preserve the historical state, create a new current relationship. | MUST |
| FR-13 | Retain historical/superseded relationships as queryable investigation evidence — never hard-delete. | MUST |

## Relevant NFRs

- NFR-12: store derived representations + provenance references, not full copies of source data.
- NFR-13: each source system remains system of record for its domain.
- NFR-16: new relationship types only added via explicit schema review, never invented at runtime.
- NFR-17: schema supports versioning without breaking historical queries.

## Example entity chain this module must be able to represent

```
Chargeback → CB Center → ICB Center → WAIT_JUDGE → Liability Assignment
  → Scheduler → Service → Repository → Class → Method → Database Table
  → Event → Downstream Service
```

## Out of scope for this module

- Actual GitHub/Datadog/PagerDuty/Slack API integration code (that's `02-source-integrations.md`).
  This module owns the *schema and storage* the ingestion pipeline writes into, plus the query
  interface the agent reads from — not the ingestion pipeline itself.
- Investigation logic, hypotheses, evidence formatting (that's `03-investigation-agent.md` and
  `04-evidence-timeline.md`).

## Test cases required

- Entity/relationship CRUD with full metadata.
- Versioning: relationship change produces a new current version + preserved historical version,
  both independently queryable.
- Multi-source corroboration: second source observing an existing relationship adds provenance,
  does not create a duplicate edge.
- Query interface returns entities/relationships filtered by domain, relationship type, and
  time validity (`valid_from`/`valid_until`).
- Rejecting an attempt to write a relationship type outside the controlled vocabulary.

## Definition of Done

- Schema implemented and migratable.
- Query interface exists and is documented (even if only used by module 03 later).
- All test cases above pass.
- No ingestion/agent code leaked into this module.

## Suggested first Claude Code session

Open a session scoped to this file only. Plan mode first: propose the storage choice (graph DB
vs. relational-with-adjacency vs. hybrid) *as a consequence of these FRs*, not a default — in
particular FR-3/FR-4 (typed, attributed edges) and FR-12/FR-13 (versioned history) should drive
the choice, not familiarity with a particular database.
