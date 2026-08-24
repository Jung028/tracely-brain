# Module 13 — End-to-End Integration Test

Depends on: `01-company-brain.md`, `02-source-integrations.md`, `03-investigation-agent.md`,
`04-evidence-timeline.md`, `05-failure-handling.md`, `06-human-collaboration.md`,
`07-slack-interface.md`, `08-state-machine.md`, `09-remediation.md`, `10-teams-org.md`,
`12-auth.md`.

## Purpose

Every module above has its own isolated test suite (mocked collaborators, seeded fixtures).
None of them prove the *whole* product works as one continuous path a real user would actually
take. This module is that proof: one automated test that drives the system exactly the way a
brand-new user would on day one, with no module mocked out.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-46 | A single automated end-to-end test drives, in order: (1) user sign-up via OAuth, (2) connecting Slack, GitHub, the database, and a logs/telemetry source, (3) initiating an investigation from Slack, (4) the investigation running to a result, (5) the result being visible in both the Slack thread and the full timeline view, (6) the investigation being resolved (either RCA confirmed and marked resolved, or explicitly routed to `MANUAL_REVIEW_REQUIRED` and resolved by a human action). | MUST |
| FR-47 | The test asserts on real state transitions and real persisted records at each stage (session/user id, per-source connection status, Investigation id and status, timeline content) — not just "the call returned 200." A stage that silently no-ops must fail the test. | MUST |
| FR-48 | If any connected source is deliberately left unavailable during the run, the test asserts the system follows `02-source-integrations.md`'s FR-15 notify/continue/cancel path and `05-failure-handling.md`'s `NOT CONFIRMED` path instead of failing opaquely or fabricating a result. | MUST |
| FR-49 | The test is runnable on demand (a single command) and produces a clear pass/fail plus a per-stage breakdown of where it failed, so a broken stage is immediately attributable to one module. | MUST |

## Relevant NFRs

- Reuses whichever latency/uptime targets have been measured by the time this module is built
  (`11-benchmark.md`, NFR-1/NFR-2) — do not invent new ones here.
- NFR-10: the audit trail produced during this run (actor, source connections, tool calls,
  approval) must itself be inspectable at the end of the test as evidence the modules are wired
  together correctly, not just that the final status looked right.

## Out of scope for this module

- Building new product capability to make the test pass. If a stage fails because a module
  genuinely doesn't do what this test expects, that's a real gap in that module — fix the
  module via its own spec, don't special-case this test around it.
- Load/performance testing — this is a correctness/integration test of one user's one journey,
  not a benchmark (`11-benchmark.md` owns real performance numbers).
- Testing every permutation of every source being unavailable — one deliberate-gap case (FR-48)
  is enough to prove the path is wired correctly; exhaustive failure-mode coverage belongs to
  `02-source-integrations.md`'s own test suite.

## Test cases required

- Full happy path: sign-up → all four sources connected → investigation started from Slack →
  RCA confirmed → investigation reaches a resolved terminal state — runs clean start to finish.
- Deliberate-gap path: one source (e.g. logs) is left disconnected → system prompts per FR-15 →
  investigation proceeds without it → result correctly reflects `NOT CONFIRMED` /
  `MANUAL_REVIEW_REQUIRED` per module 05, not a false-confidence RCA.
- Manual-review resolution path: an investigation that lands in `MANUAL_REVIEW_REQUIRED` is
  resolved by an authenticated human action, and that actor is the one recorded in the audit
  trail (ties to `12-auth.md` FR-42/NFR-10).
- Re-running the same journey for a second, distinct user does not cross-contaminate the first
  user's connections, investigation, or Brain data.

## Test scenario ownership

The concrete scenarios exercised by this module's tests (what problem
description to send, which source to leave disconnected, what a failure
log looks like) are supplied by the project owner, not invented by whoever
implements this spec. When building or debugging this module, ask for the
specific scenario and/or failure log rather than fabricating one — this
module tests real integrations (real Slack, real GitHub, a real database),
so a synthetic scenario that doesn't match how the system is actually used
risks passing while the real flow still breaks.

## Definition of Done

- FR-46 through FR-49 implemented and passing against the real (non-mocked) module
  implementations — test doubles are allowed only for genuinely external third-party services
  (the actual Slack/GitHub/Datadog/OAuth providers), never for Tracely's own modules.
- The per-stage failure breakdown (FR-49) has been verified to actually work by intentionally
  breaking one stage and confirming the test report points at it.
- Running this test is the final gate this repo's CLAUDE.md "Definition of done for any module"
  checklist points to before a milestone is considered demo-ready.

## Suggested first Claude Code session

Do this module last, once `09-remediation.md` and `12-auth.md` are stable — building it earlier
means constantly rewriting it as upstream modules change shape. Plan mode first: decide how
much of "connect Slack/GitHub/DB/logs" can run against real sandbox/test accounts for these
providers versus a thin real-protocol test double, before writing the test itself.
