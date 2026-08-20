# Module 08 — Investigation State Machine

Depends on: `03-investigation-agent.md`, `05-failure-handling.md`.

## Purpose

Formalize the investigation lifecycle so every module transitions state the same, predictable
way instead of each module inventing its own status strings.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-35 | Implement a lifecycle with at minimum the states `CREATED, INVESTIGATING, RCA_IDENTIFIED, MANUAL_REVIEW_REQUIRED, RESOLUTION_PROPOSAL, RESOLVED`, with legal transitions, failure transitions, retry behavior, and terminal states formally defined. | MUST |

## This is explicitly unfinished business from the baseline design

The original design notes say: *"We also need to formally define the legal transitions, failure
transitions, retry behavior and terminal states when we do the state-machine design... The exact
state machine will be reviewed later rather than assumed complete."* That review happens in this
module — do not assume the six states above are the complete list; propose the full transition
diagram in plan mode and get it reviewed before implementing.

## Questions this module must answer explicitly (do not leave implicit)

- Can `INVESTIGATING` go directly to `MANUAL_REVIEW_REQUIRED`, or only via a failed
  `RCA_IDENTIFIED` attempt?
- Is `MANUAL_REVIEW_REQUIRED` terminal, or can a human action move it back to `INVESTIGATING`
  with new information (ties to `06-human-collaboration.md`)?
- What happens if `RESOLUTION_PROPOSAL` is rejected by the human approver — back to
  `INVESTIGATING`, a new terminal `REJECTED` state, or something else?
- Are there retry limits (e.g., how many times can a hypothesis cycle before forcing
  `MANUAL_REVIEW_REQUIRED`)?

## Out of scope for this module

- The remediation-specific sub-states inside `RESOLUTION_PROPOSAL` (DML test/approve/execute,
  PR generate/review) — those live in `09-remediation.md`'s own state machine, which this
  module's `RESOLUTION_PROPOSAL` state hands off to.

## Test cases required

- Every legal transition in the finalized diagram is tested.
- Every illegal transition attempt is rejected (e.g., `CREATED` → `RESOLVED` directly should be
  impossible).
- Terminal states cannot be exited.

## Definition of Done

- A complete, reviewed state diagram exists as a diagram/table in this repo (not just in code).
- All transitions (legal and illegal) are tested.

## Suggested first Claude Code session

Plan mode only, first — this session should produce a proposed state diagram for human review
before any code is written, since these are exactly the kind of decisions the baseline design
explicitly deferred rather than assumed.
