# Module 05 — Failure Handling (the "never fabricate" gate)

Depends on: `03-investigation-agent.md`.

## Purpose

Guarantee the agent never presents a guess as a conclusion. This module is small but treat it as
one of the highest-priority modules in the whole system — it's the difference between a trustworthy
tool and a dangerous one.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-25 | Never fabricate a root cause. If evidence is insufficient, return explicit `NOT CONFIRMED` with what was investigated, what's missing, and a recommended next step. | MUST |
| FR-26 | An investigation with insufficient evidence transitions to `MANUAL_REVIEW_REQUIRED`. | MUST |

## Example output this module must produce

```
Investigation completed
Root cause: NOT CONFIRMED
Investigated: ✓ Database  ✓ Logs  ✓ Code
Missing: Trace expired
Recommended next investigation: ...
```

## Relevant NFRs

- NFR-3: root-cause conclusions require evidence meeting a defined confidence threshold — this
  module is what *enforces* that threshold; module 03 just produces the hypotheses it enforces
  against.

## Out of scope for this module

- Defining what happens *after* `MANUAL_REVIEW_REQUIRED` in terms of state machine transitions
  (`08-state-machine.md` owns the full transition graph — this module only needs to trigger the
  transition correctly).

## Test cases required

- Investigation with zero confirmed hypotheses at the end of the agent loop → produces the
  `NOT CONFIRMED` object above, not an empty result or an error.
- Investigation where the highest-confidence hypothesis is below the confidence threshold →
  same outcome, even though *some* evidence exists.
- Investigation blocked by a missing required source (from `02-source-integrations.md`'s test
  cases) → correctly routes here instead of crashing or silently omitting the gap.
- Adversarial test: feed the agent a case deliberately designed to tempt a plausible-but-wrong
  guess (e.g. a red herring correlation) — confirm it does not confidently claim a root cause it
  hasn't actually verified.

## Definition of Done

- Every path that could produce a low-confidence or no-confidence result correctly produces the
  `NOT CONFIRMED` object and triggers `MANUAL_REVIEW_REQUIRED`.
- The adversarial test case passes.

## Suggested first Claude Code session

Write the adversarial test case *before* the implementation. This is one module where
test-first genuinely matters, since "looks plausible" is exactly the failure mode you're
guarding against.
