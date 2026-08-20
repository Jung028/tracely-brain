# Module 10 — Teams & Organizational Context

Depends on: `01-company-brain.md`.

## Purpose

Let one Company Brain serve multiple teams with access-controlled, team-scoped retrieval,
instead of siloed per-team Brains.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-39 | Company Brain shared across teams, access-controlled, team-scoped retrieval based on authorization and ownership. | SHOULD |

## Relevant NFRs

- NFR-8: access to Brain content governed by team/role-based authorization.

## Out of scope for this module

- Building a full RBAC/IAM system — scope this to what's needed for the MVP's single company,
  small-number-of-teams context (per NFR-15 in `_security-nfrs.md`). Do not over-build enterprise
  multi-tenant permissioning here.

## Test cases required

- A user scoped to Team A cannot retrieve Brain entities owned exclusively by Team B without
  explicit cross-team access granted.
- Ownership inference (from repo/incident/Slack metadata) correctly attributes an entity to a
  team without manual tagging for the common case.

## Definition of Done

- Basic team-scoped retrieval works for at least two teams in a test fixture.

## Suggested first Claude Code session

This is a SHOULD, not a MUST — do not start this module before 01–09 are in reasonable shape.
If time is tight before a demo, it's fine to skip and note it in `FUTURE-IDEAS.md`.
