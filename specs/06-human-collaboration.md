# Module 06 — Human Collaboration

Depends on: `03-investigation-agent.md`.

## Purpose

Let an engineer participate in an in-progress investigation instead of only reading a final
report.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-27 | Engineer can inject information into an in-progress investigation (e.g. "I think the config changed yesterday"), and the agent incorporates it into its hypotheses. | SHOULD |
| FR-28 | Investigation state is visible to the engineer in real time as shared state, not delivered only as a final report. | MUST |

## Out of scope for this module

- The channel this happens through (Slack UI specifics are `07-slack-interface.md`) — this
  module defines the underlying capability (agent can accept mid-investigation input and update
  state live), not the chat surface.

## Test cases required

- A human-provided hint mid-investigation results in a new or updated hypothesis that references
  the hint as a source of evidence (distinct from tool-derived evidence — should be visibly
  attributed to the human, not presented as if the agent found it independently).
- Investigation state (current step, current hypotheses) is queryable/observable *before* the
  investigation completes, not only after.

## Definition of Done

- FR-28 (MUST) is fully implemented and tested.
- FR-27 (SHOULD) implemented if time allows — do not let this block later modules if it slips;
  flag it and move on rather than over-investing in a SHOULD item.

## Suggested first Claude Code session

Build FR-28 (live state visibility) first since it's MUST — FR-27 (accepting human input) can be
a fast-follow once the state model already supports being read mid-flight.
