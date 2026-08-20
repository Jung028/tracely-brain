# Module 03 — Investigation Agent (core loop + hypotheses + tools)

Depends on: `01-company-brain.md`, `02-source-integrations.md`.

## Purpose

The reasoning layer that turns a Brain + connected sources into an actual investigation:
retrieves context, forms and tests hypotheses, decides which tools to call and when.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-17 | Execute the lifecycle: understand problem → retrieve Brain context → form hypotheses → select tools → collect evidence → update hypotheses → validate → RCA → remediation proposal → human approval. | MUST |
| FR-18 | Support both parallel and sequential tool execution, chosen adaptively based on whether one result determines the next query. | MUST |
| FR-19 | Maintain explicit, named hypotheses — each with supporting evidence, contradicting evidence, and status `INVESTIGATING / CONFIRMED / REFUTED` — not unstructured narrative. | MUST |
| FR-20 | Be able to refute a hypothesis and generate a new one from evidence already gathered. | MUST |
| FR-29 | Retrieve similar historical incidents/RCAs as candidate hypotheses. | SHOULD |
| FR-30 | Treat historical RCAs as hypotheses to validate against current evidence, never as proof on their own. | MUST |
| FR-31 | Have access to at minimum: code search/read, PostgreSQL query execution, log search, Company Brain retrieval. | MUST |

## Example hypothesis object this module must be able to produce

```
H1: Liability assignment scheduler is disabled.
Supporting:    ✓ Task stuck in WAIT_JUDGE
               ✓ Workflow requires scheduler transition
               ✓ No scheduler execution observed
Contradicting: ✗ Scheduler configuration appears enabled
Status: INVESTIGATING
```

## Relevant NFRs

- NFR-3: no root-cause conclusion without evidence meeting a defined confidence threshold
  (threshold itself is TBD/calibrated later — but the *mechanism* for a threshold must exist now).
- NFR-1/NFR-2: latency budgets — not a hard number yet, but don't architect something that makes
  measuring latency impossible later (e.g., no black-box single mega-call with no intermediate
  visibility).

## Out of scope for this module

- How evidence is displayed to the user (`04-evidence-timeline.md` — this module produces the
  evidence objects, that module renders them).
- What happens when the agent can't reach a conclusion (`05-failure-handling.md` owns the
  `NOT CONFIRMED` / `MANUAL_REVIEW_REQUIRED` behavior — this module just needs to be able to
  report "insufficient evidence" honestly instead of guessing).
- Remediation/DML/PR generation (`09-remediation.md`).

## Test cases required

- Given the three demo scenarios (scheduler disabled / missing config / race condition — see
  `FUTURE-IDEAS.md` or the original spec PDF for full scenario text), the agent forms at least
  one hypothesis, gathers evidence via at least two different tool types, and reaches
  `CONFIRMED` or `REFUTED` correctly for each.
- A hypothesis correctly moves from `INVESTIGATING` → `REFUTED` when contradicting evidence
  arrives, and a new hypothesis is generated from that evidence.
- Historical-incident retrieval surfaces a plausible past RCA as a *candidate* hypothesis, and
  the agent still requires fresh evidence before confirming it (FR-30 — this must be tested
  explicitly, it's an easy rule to accidentally skip).

## Definition of Done

- Full FR-17 lifecycle runs end-to-end against a seeded test Brain + mocked tool responses.
- Hypothesis objects match the structure above and are inspectable, not just internal state.
- All test cases pass.

## Suggested first Claude Code session

Build the hypothesis data structure and state transitions first, with hard-coded/mocked evidence
— prove FR-19/FR-20 work as a state machine before wiring in real tool calls from module 02.
