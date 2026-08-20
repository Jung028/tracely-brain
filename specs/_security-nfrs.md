# Cross-Cutting — Security & Governance NFRs

This is **not a standalone build module.** Every module above must satisfy these constraints;
there is no dedicated "security session" that implements them separately, because bolted-on
security after the fact is how gaps happen. Read this file alongside every module's spec.

| ID | Requirement | Applies most directly to |
|---|---|---|
| NFR-5 | DB access read-only except the gated DML workflow. | 02, 09 |
| NFR-6 | Customer data logically isolated per tenant. | 01, 02, 10 |
| NFR-7 | Data encrypted in transit and at rest. | all |
| NFR-8 | Brain access governed by team/role-based authorization. | 10 |
| NFR-9 | No compliance claims not actually obtained. | all, especially pitch/UI copy |
| NFR-10 | Every query/tool call/Brain read-write logged with timestamp, actor, purpose, retained per policy. | all, especially 09 |
| NFR-11 | Every DML/PR action traceable end-to-end to a human approver. | 09 |
| NFR-15 | MVP scoped to one company's Brain, small number of teams — multi-tenant scale explicitly out of scope until validated. | 01, 10 |
| NFR-19 | Explicit failure-mode test cases (not connected, auth expired, insufficient permissions, unavailable, query failure, continue-without-source, blocked investigation). | 02, 05 |

## TBD targets (do not fill with a guessed number)

- NFR-1: investigation latency SLA — set from `11-benchmark.md` real data.
- NFR-2: Brain context retrieval latency budget — set from real data.
- NFR-3: confidence threshold for claiming a root cause — calibrated during MVP testing, not
  fixed here.
- NFR-14: Slack path uptime target — set once real usage exists.

If any of these get filled in with a plausible-sounding number instead of a measured one, that's
a bug — flag it in code review the same way you'd flag a logic error.
