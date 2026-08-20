# Module 04 — Evidence & Investigation Timeline (UX layer)

Depends on: `03-investigation-agent.md` (consumes its evidence objects).

## Purpose

Make every investigation step inspectable — what was queried, why, what was found, what it
means, and which hypothesis it touches — rendered as an expandable timeline, not a black box.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-21 | For every investigation action, record: what was queried, why, what was found, what the result means, which hypothesis it supports/refutes, which source produced it. | MUST |
| FR-22 | The user can inspect the full evidence trail behind any RCA. | MUST |
| FR-23 | UI displays the investigation as a chronological sequence of expandable steps. | MUST |
| FR-24 | Expanding a step reveals its full evidence (query, reasoning, result, hypothesis linkage). | MUST |

## Example rendered step this module must produce

```
Step: Query CB_TASK
Query:   SELECT ...
Why:     Determine current task state and related workflow.
Result:  status = WAIT_JUDGE, relation_id = ...
Supports: H1 — scheduler-related workflow blockage
```

## Relevant NFRs

- NFR-18: every step expandable to its evidence in a single interaction — no hidden reasoning.

## Out of scope for this module

- Generating the evidence itself (that's `03-investigation-agent.md`'s job — this module only
  formats and displays what it's given).
- Slack rendering specifics (`07-slack-interface.md` — this module is the canonical evidence
  data model + a web view; Slack is a thinner consumer of the same data).

## Test cases required

- Every evidence field from FR-21 is present and non-empty for a real investigation run (no
  silently-dropped "why" or "supports" fields).
- A step with no linked hypothesis is still renderable (some steps are exploratory, not every
  query needs to map to a hypothesis) but this must be an explicit, visible state, not a blank.
- Timeline order matches actual execution order, including for the parallel-tool case from
  FR-18 (parallel steps should be visually distinguishable from sequential ones, not misrepresented
  as a single linear sequence when they weren't).

## Definition of Done

- Given a completed investigation object from module 03, this module renders a full timeline
  with every step expandable to its evidence, matching the example above.
- All test cases pass.

## Suggested first Claude Code session

Build against a fixture (a hard-coded investigation result matching the WAIT_JUDGE demo case)
before wiring to the live agent — this decouples UI iteration from agent correctness.
