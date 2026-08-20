# Module 07 — Slack Interface

Depends on: `03-investigation-agent.md`, `04-evidence-timeline.md`, `06-human-collaboration.md`.

## Purpose

The initial product surface. An engineer starts and follows an investigation from Slack.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-32 | Engineer can initiate an investigation from Slack via natural-language request. | MUST |
| FR-33 | System creates an Investigation record with a unique ID and status, posts progress/results back into the Slack thread. | MUST |
| FR-34 | A full investigation view (timeline + evidence) is accessible from a link surfaced in Slack. | MUST |

## Relevant NFRs

- NFR-14: Slack path meets an uptime target appropriate for on-call use (target TBD — do not
  invent a number, but do log/measure so a real target can be set later).

## Out of scope for this module

- Investigation logic itself — this module is a thin interface on top of modules 03/04/06, not a
  place to reimplement any of their logic.

## Test cases required

- A Slack message triggers investigation creation with a real, retrievable Investigation ID.
- Progress updates post to the correct thread as the investigation proceeds (not just a single
  final message — ties back to FR-28's live-state requirement).
- The link to the full timeline view resolves to the same evidence a user would see if they'd
  used the web view directly (no divergence between what Slack shows and what the full UI shows).

## Definition of Done

- All three FRs implemented and tested end-to-end from a real Slack message to a real
  Investigation.

## Suggested first Claude Code session

Build against modules 03/04/06 once those are stable — this module should be nearly all
integration glue, very little new logic. If you find yourself writing investigation logic here,
stop — it belongs in an earlier module.
