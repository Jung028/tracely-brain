# Module 09 — Remediation (DML + PR workflow, human-gated)

Depends on: `03-investigation-agent.md`, `08-state-machine.md`.

**This is the highest-risk module in the system.** It's the one place Tracely is allowed to
touch anything beyond read-only investigation. Treat every requirement here as load-bearing, not
a suggestion.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-36 | For DML remediation: generate SQL → test in a development environment → validate/rollback → tests pass → human approval → execution. Direct agent-to-production execution without this sequence is prohibited. | MUST |
| FR-37 | For code remediation: generate proposed change → generate/run tests → check coverage/test conditions → human review → create PR. Never auto-merge. | MUST |
| FR-38 | On successful resolution, feed incident + investigation + RCA + resolution back into the Company Brain as validated knowledge. | SHOULD |

## Relevant NFRs (all MUST, no exceptions)

- NFR-5: database access is read-only everywhere *except* this module's gated DML path.
- NFR-9: no compliance claims not actually held.
- NFR-10: every query/tool call/Brain write is logged with timestamp, actor, purpose.
- NFR-11: every DML or PR action is traceable end-to-end from originating investigation to
  human approver.

## Out of scope for this module (per `CLAUDE.md` non-negotiables — do not implement even if asked mid-session)

- Autonomous deployment.
- Kubernetes remediation.
- Auto-merging PRs.
- Any production write path that bypasses the human approval gate below.

## The one rule that overrides convenience

There is no code path — none, ever, for any reason including "the fix was obviously correct" or
"the human was slow to respond" — where the agent executes DML against production without an
explicit human approval action recorded in the audit log. If you (Claude Code) find yourself
building a fallback/timeout/auto-approve path "just in case," stop and flag it instead.

## Test cases required

- DML generated for a real remediation case runs successfully against a dev/test database, with
  rollback proven to work before human approval is even requested.
- Attempting to skip the human-approval step programmatically fails/is rejected.
- PR is created but a test asserting "PR is not auto-merged" explicitly passes.
- Full audit trail test: given a resolved remediation, the log reconstructs investigation →
  RCA → proposed fix → approver identity → execution, with no gaps.
- Module 38 (Brain update on resolution): a resolved incident is retrievable as a historical
  case by module 03's FR-29 (historical incident retrieval) after being written back.

## Definition of Done

- FR-36 and FR-37 fully implemented with the approval gate provably impossible to bypass.
- All test cases pass, especially the audit-trail and no-auto-merge tests.

## Suggested first Claude Code session

Plan mode first, and explicitly review the proposed approval-gate design with the human before
any code is written — this is the one module where getting the plan wrong is not a "fix it in
review" mistake, it's a production-safety mistake.
