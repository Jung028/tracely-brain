# Module 11 — Benchmark

Depends on: everything else. This is the module that proves (or disproves) the thesis.

## Purpose

Run the same investigation cases through Manual / Claude+Tools / Tracely and capture real,
measured numbers — this module exists specifically to stop anyone (including Claude Code) from
inventing a number like "Tracely is 80% faster" without evidence.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-40 | Support running the same investigation case through Manual, Claude+Tools, and Tracely paths, capturing time-to-RCA, correctness, number of investigation actions, context switches, human interventions, and evidence quality for each. | MUST |

## Relevant NFRs

- NFR-1/NFR-2: this module is also where real latency numbers get produced, which then retroactively
  fill in the TBD targets in `_security-nfrs.md` and elsewhere. Feed those numbers back once
  measured — don't leave them TBD forever once real data exists.

## The three cases to benchmark (from the original spec)

1. **Scheduler/infrastructure failure** — CB-123456 stuck in WAIT_JUDGE, liability-assignment
   scheduler disabled.
2. **Business configuration failure** — CB-118820 auto-rejected at PRE_JUDGE due to missing
   exchange-rate configuration for a new region.
3. **Code/concurrency failure** — CB-130201 duplicate ICB records from a webhook-retry race
   condition.

## Out of scope for this module

- Building new investigation capability to make the benchmark look better. If Tracely performs
  poorly on a case, that's a real result — report it, don't patch the benchmark to hide it.

## Test cases required

- Each of the three cases runs cleanly through all three paths (Manual is human-timed/logged
  manually, not automated) and produces a comparable metrics record.
- Metrics are stored in a format that can be cited directly in the pitch/demo material without
  transformation — i.e., no manual "cleanup" step between raw measurement and the number quoted
  publicly.

## Definition of Done

- All three cases benchmarked across all three paths with real numbers.
- Numbers are written into the pitch material (replacing every placeholder marked "TBD" or
  "example only, do not use") — and *only* real numbers, cited with the underlying run.

## Suggested first Claude Code session

Do this module last, once modules 01–09 are stable enough to actually run the three demo cases
end-to-end. Running the benchmark against a half-built system produces a number that looks real
but isn't — worse than no number at all.
