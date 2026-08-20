# Tracely — Project Memory (read this every session)

## What this project is

Tracely maintains a persistent, queryable representation of how a company's technical and
business systems relate (the **Company Brain**), and gives that context to an **Investigation
Agent** so production incidents get investigated with an evidence-backed root cause instead of
starting from zero every time.

Thesis under test: *a persistent, queryable representation of a company's technical and business
context lets an AI agent investigate complex problems across multiple systems more effectively
than starting fresh every time.* Every module exists to prove or disprove that thesis — nothing
else.

## How this repo is organized

- `CLAUDE.md` (this file) — constraints and rules that apply to *every* module. Always true.
- `specs/NN-module-name.md` — one bounded unit of work per file, numbered in build order.
- `specs/_security-nfrs.md` — cross-cutting constraints that apply inside every module, not a
  standalone build unit.

**Work one `specs/NN-*.md` file at a time.** Before writing any code for a module:
1. Read that module's spec file completely.
2. Read this file completely.
3. Enter plan mode and propose an approach before touching files.
4. Do not implement anything from a *later* numbered spec file, even if it seems related or easy
   to add while you're in there. If something in the current module seems to require a decision
   that belongs to a later spec, stop and flag it instead of guessing.

## Non-negotiable constraints (apply everywhere, no exceptions)

- **Never fabricate a root cause.** If evidence is insufficient, return an explicit
  `NOT CONFIRMED` result and transition to `MANUAL_REVIEW_REQUIRED`. This is not a style
  preference — treat it as a correctness bug if violated.
- **Database access is read-only** everywhere except the explicitly approved DML remediation
  workflow (`specs/09-remediation.md`). Never write code that lets the agent write to a database
  outside that one gated path.
- **No autonomous production changes.** No auto-deploy, no auto-merge, no Kubernetes
  remediation, no arbitrary production modification. Remediation always ends at a human
  approval gate.
- **Relationships use a controlled vocabulary only** (see `specs/01-company-brain.md`). Never
  invent a new relationship type at query/runtime — that requires an explicit schema change.
- **Each source system is authoritative for its own domain.** The Company Brain stores derived
  representations and provenance references back to the source — never treat the Brain itself as
  the source of truth, and never silently duplicate/copy full source content into it.
- **No invented numbers.** Any latency, accuracy, or benchmark figure quoted in docs, UI copy, or
  comments must come from an actual measurement. If no measurement exists yet, say "TBD" —
  never fill in a plausible-sounding placeholder and leave it looking real.
- **No compliance claims** (SOC 2, etc.) unless actually obtained. Do not add copy or comments
  implying certifications that don't exist.

## Definition of done for any module

A module is not done because it runs. It's done when:
- Every FR listed in that module's spec is implemented and testable.
- Tests exist and pass for the module's behavior, including its failure-mode test cases.
- The diff has been reviewed against this file and the module's spec (self-review at minimum;
  prefer a second Claude Code session/subagent reviewing in a fresh context).
- Nothing from a later module was implemented "while we were in there."

## MVP Acceptance Rubric (for reference — do not re-litigate weights)

| Category | Weight |
|---|---|
| Problem validation | 10% |
| Company Brain | 20% |
| Investigation agent | 20% |
| Evidence & RCA | 20% |
| Investigation UX | 10% |
| Failure handling | 5% |
| Integration | 5% |
| Benchmark | 10% |

## Explicitly out of scope for the whole MVP

Autonomous production DML beyond the gated workflow, automatic production fixes, automatic
deployment, automatic PR merging, Kubernetes remediation, 20+ integrations, building an
observability platform, replacing PagerDuty/Incident.io, a complete enterprise SRE platform,
supporting every database/language, perfect domain understanding, multi-agent architecture for
its own sake.

If you (Claude Code) discover mid-build that one of these seems genuinely necessary, stop and
say so explicitly — do not silently implement it. It goes into `FUTURE-IDEAS.md` until the human
deliberately revises scope.

## Priority key used in every spec file

- **MUST** — required for MVP acceptance; a module isn't done without it.
- **SHOULD** — strengthens the module but the module can still function without it at launch.

## Testing rule

Every module must have tests before it's considered complete. If a `Stop` hook enforcing
test-pass is configured in `.claude/settings.json`, respect it — do not work around a failing
test by weakening the test.
