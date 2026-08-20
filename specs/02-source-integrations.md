# Module 02 — Source System Integrations

Depends on: `01-company-brain.md` (writes into the schema that module defines).

## Purpose

Connect GitHub, PostgreSQL, Datadog, PagerDuty, and Slack so the Brain can be built and kept
current, and handle missing/broken sources explicitly rather than silently.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-14 | Support GitHub, PostgreSQL, Datadog, PagerDuty, Slack as required MVP integrations; internal docs optional. | MUST |
| FR-15 | If an investigation requires a source that isn't connected/authorized, explicitly notify the user with options: connect it, continue without it, or cancel. Never fail silently. | MUST |
| FR-16 | Treat each source as authoritative for its own domain (GitHub=code, PostgreSQL=data/schema, Datadog=telemetry, PagerDuty=incidents, Slack=conversations, Docs=documentation). | MUST |

## Relevant NFRs

- NFR-5: database access is read-only for investigation (no exceptions in this module).
- NFR-6: tenant/customer data logically isolated.
- NFR-7: data encrypted in transit and at rest.
- NFR-19: explicit test cases (below) are required, not optional polish.

## Out of scope for this module

- The Brain's storage schema (`01-company-brain.md` owns that; this module only writes into it).
- Investigation-time source *usage* — this module is about connecting and syncing sources, not
  about the agent deciding which tool to call during an investigation (`03`).

## Test cases required (explicitly required by NFR-19 — do not skip)

- Integration not connected at all.
- Authorization expired mid-use.
- Insufficient permissions on a connected integration.
- Source unavailable (timeout / down).
- Source query failure (valid connection, query itself errors).
- User chooses "continue without source" — investigation proceeds and later notes the gap.
- Investigation becomes impossible because the missing source contained required evidence — this
  must resolve to the `NOT CONFIRMED` / `MANUAL_REVIEW_REQUIRED` path from `05-failure-handling.md`,
  not a crash or a silent guess.

## Definition of Done

- All five required integrations can authenticate and pull data into the Brain schema from
  module 01.
- Every test case above is implemented and passing.
- No integration is allowed write access beyond what FR-16 and NFR-5 permit.

## Suggested first Claude Code session

Start with GitHub only (per FR-8 in module 01, it's the structural foundation). Get the
not-connected / auth-expired / query-failure test cases passing for GitHub before adding the
next integration — don't build all five in parallel.
