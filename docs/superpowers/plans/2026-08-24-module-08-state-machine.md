# Module 08 — Investigation State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the investigation lifecycle (FR-35) as a pure, tested state machine, wire it into the real persistent `Investigation` record (migrating module 07's placeholder 3-value status), and surface the lifecycle state live in Slack.

**Architecture:** A new pure module `src/state-machine/` owns the 7-state graph and a `transition()` validator with no DB dependency, so every legal/illegal transition is cheaply unit-testable. `src/investigations/db.ts` gets new wrapper functions that call `transition()` before touching Postgres, replacing the old ad-hoc status derivation. `src/slack/handler.ts` and `poller.ts` are extended to call the new wrappers and surface the resulting state in their existing Slack messages.

**Tech Stack:** Bun (`bun test`, `bunx tsc --noEmit`), `bun:sql` via `src/brain/db.ts`'s `sql` re-export, Postgres.

**Spec:** `specs/08-state-machine.md` (FR-35). Design: `docs/superpowers/specs/2026-08-24-module-08-state-machine-design.md`. Depends on modules 03, 05, 06, 07 — all merged to `main`.

## Global Constraints

- Typed-failure-surface convention throughout: an illegal transition is an expected, normal
  condition — every new function returns a typed `{ok:false, error}` result, never throws, for a
  transition-legality failure. (An "investigation not found" condition is likewise returned as a
  typed `{ok:false, error}` now, for consistency within the same function — see Task 2.)
- No test anywhere in this plan may trigger a real `investigate()`/Anthropic API call — every test
  injects/mocks `investigateImpl` exactly as the existing test suite already does.
- No invented numbers or compliance claims in `docs/state-machine.md`.
- Do not build `RESOLUTION_PROPOSAL`'s own DB wrapper functions (`proposeResolution`,
  `rejectResolution`, `resolveFromProposal`) — module 09 doesn't exist yet and nothing would call
  them. Only the `transition()` rules for those two edges need to exist and be tested.
- The reopen retry cap is exactly **3** (a `REOPEN` event succeeds at `retryCount` 0, 1, 2; is
  rejected at `retryCount` 3).
- `RESOLVED` is the only true terminal state — it must reject every possible `TransitionEvent`.

---

### Task 1: Pure state machine (`src/state-machine/`)

**Files:**
- Create: `src/state-machine/types.ts`
- Create: `src/state-machine/transition.ts`
- Create: `src/state-machine/index.ts`
- Test: `tests/state-machine/transition.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no dependency on any other task).
- Produces: `InvestigationState` (6-value union), `TransitionEvent` (8-value discriminated union),
  `TransitionContext = { retryCount: number }`, `TransitionResult = { ok: true; state:
  InvestigationState } | { ok: false; error: string }`, and `transition(current:
  InvestigationState, event: TransitionEvent, context: TransitionContext): TransitionResult`. Task
  2 imports all of these from `../state-machine`.

- [ ] **Step 1: Write the failing test**

Create `tests/state-machine/transition.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { transition } from "../../src/state-machine";
import type { TransitionEvent } from "../../src/state-machine";

const noRetries = { retryCount: 0 };

describe("transition — legal edges", () => {
  test("CREATED --BEGIN_INVESTIGATING--> INVESTIGATING", () => {
    const result = transition("CREATED", { type: "BEGIN_INVESTIGATING" }, noRetries);
    expect(result).toEqual({ ok: true, state: "INVESTIGATING" });
  });

  test("INVESTIGATING --RCA_CONFIRMED--> RCA_IDENTIFIED", () => {
    const result = transition("INVESTIGATING", { type: "RCA_CONFIRMED" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RCA_IDENTIFIED" });
  });

  test("INVESTIGATING --INSUFFICIENT_EVIDENCE--> MANUAL_REVIEW_REQUIRED", () => {
    const result = transition("INVESTIGATING", { type: "INSUFFICIENT_EVIDENCE" }, noRetries);
    expect(result).toEqual({ ok: true, state: "MANUAL_REVIEW_REQUIRED" });
  });

  test("RCA_IDENTIFIED --PROPOSE_RESOLUTION--> RESOLUTION_PROPOSAL", () => {
    const result = transition("RCA_IDENTIFIED", { type: "PROPOSE_RESOLUTION" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLUTION_PROPOSAL" });
  });

  test("RCA_IDENTIFIED --CLOSE_DIRECTLY--> RESOLVED", () => {
    const result = transition("RCA_IDENTIFIED", { type: "CLOSE_DIRECTLY" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLVED" });
  });

  test("MANUAL_REVIEW_REQUIRED --REOPEN--> INVESTIGATING (under the retry cap)", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "REOPEN" }, { retryCount: 2 });
    expect(result).toEqual({ ok: true, state: "INVESTIGATING" });
  });

  test("MANUAL_REVIEW_REQUIRED --CLOSE_DIRECTLY--> RESOLVED", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "CLOSE_DIRECTLY" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLVED" });
  });

  test("RESOLUTION_PROPOSAL --RESOLUTION_APPROVED--> RESOLVED", () => {
    const result = transition("RESOLUTION_PROPOSAL", { type: "RESOLUTION_APPROVED" }, noRetries);
    expect(result).toEqual({ ok: true, state: "RESOLVED" });
  });

  test("RESOLUTION_PROPOSAL --RESOLUTION_REJECTED--> MANUAL_REVIEW_REQUIRED", () => {
    const result = transition("RESOLUTION_PROPOSAL", { type: "RESOLUTION_REJECTED" }, noRetries);
    expect(result).toEqual({ ok: true, state: "MANUAL_REVIEW_REQUIRED" });
  });
});

describe("transition — illegal edges", () => {
  test("the spec's explicit example: CREATED --CLOSE_DIRECTLY--> RESOLVED (skipping the whole lifecycle) is rejected", () => {
    const result = transition("CREATED", { type: "CLOSE_DIRECTLY" }, noRetries);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("CREATED");
  });

  test("INVESTIGATING cannot REOPEN (REOPEN only applies from MANUAL_REVIEW_REQUIRED)", () => {
    const result = transition("INVESTIGATING", { type: "REOPEN" }, noRetries);
    expect(result.ok).toBe(false);
  });

  test("RCA_IDENTIFIED cannot receive INSUFFICIENT_EVIDENCE", () => {
    const result = transition("RCA_IDENTIFIED", { type: "INSUFFICIENT_EVIDENCE" }, noRetries);
    expect(result.ok).toBe(false);
  });

  test("MANUAL_REVIEW_REQUIRED cannot receive BEGIN_INVESTIGATING", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "BEGIN_INVESTIGATING" }, noRetries);
    expect(result.ok).toBe(false);
  });
});

describe("transition — RESOLVED is terminal", () => {
  const allEvents: TransitionEvent[] = [
    { type: "BEGIN_INVESTIGATING" },
    { type: "RCA_CONFIRMED" },
    { type: "INSUFFICIENT_EVIDENCE" },
    { type: "PROPOSE_RESOLUTION" },
    { type: "CLOSE_DIRECTLY" },
    { type: "REOPEN" },
    { type: "RESOLUTION_APPROVED" },
    { type: "RESOLUTION_REJECTED" },
  ];

  for (const event of allEvents) {
    test(`RESOLVED rejects ${event.type}`, () => {
      const result = transition("RESOLVED", event, noRetries);
      expect(result.ok).toBe(false);
    });
  }
});

describe("transition — reopen retry cap", () => {
  test("allows reopening at retryCount 0, 1, 2 (under the cap of 3)", () => {
    for (const retryCount of [0, 1, 2]) {
      const result = transition("MANUAL_REVIEW_REQUIRED", { type: "REOPEN" }, { retryCount });
      expect(result).toEqual({ ok: true, state: "INVESTIGATING" });
    }
  });

  test("rejects reopening at retryCount 3 (cap reached), naming the limit in the error", () => {
    const result = transition("MANUAL_REVIEW_REQUIRED", { type: "REOPEN" }, { retryCount: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/state-machine/transition.test.ts`
Expected: FAIL — `src/state-machine` does not exist yet (module resolution error).

- [ ] **Step 3: Write the implementation**

Create `src/state-machine/types.ts`:

```ts
// FR-35's formal investigation lifecycle. See
// docs/superpowers/specs/2026-08-24-module-08-state-machine-design.md for
// the full diagram and rationale behind every edge.
export type InvestigationState =
  | "CREATED"
  | "INVESTIGATING"
  | "RCA_IDENTIFIED"
  | "MANUAL_REVIEW_REQUIRED"
  | "RESOLUTION_PROPOSAL"
  | "RESOLVED";

export type TransitionEvent =
  | { type: "BEGIN_INVESTIGATING" }
  | { type: "RCA_CONFIRMED" }
  | { type: "INSUFFICIENT_EVIDENCE" }
  | { type: "PROPOSE_RESOLUTION" }
  | { type: "CLOSE_DIRECTLY" }
  | { type: "REOPEN" }
  | { type: "RESOLUTION_APPROVED" }
  | { type: "RESOLUTION_REJECTED" };

export interface TransitionContext {
  readonly retryCount: number;
}

export type TransitionResult =
  | { ok: true; state: InvestigationState }
  | { ok: false; error: string };
```

Create `src/state-machine/transition.ts`:

```ts
import type {
  InvestigationState,
  TransitionContext,
  TransitionEvent,
  TransitionResult,
} from "./types";

const REOPEN_LIMIT = 3;

// The full legal-transition table (9 edges). Any (state, event) pair not
// listed here is illegal. RESOLVED has no entries at all — it accepts no
// events, per FR-35's terminal-state requirement.
const TRANSITIONS: Record<
  InvestigationState,
  Partial<Record<TransitionEvent["type"], InvestigationState>>
> = {
  CREATED: {
    BEGIN_INVESTIGATING: "INVESTIGATING",
  },
  INVESTIGATING: {
    RCA_CONFIRMED: "RCA_IDENTIFIED",
    INSUFFICIENT_EVIDENCE: "MANUAL_REVIEW_REQUIRED",
  },
  RCA_IDENTIFIED: {
    PROPOSE_RESOLUTION: "RESOLUTION_PROPOSAL",
    CLOSE_DIRECTLY: "RESOLVED",
  },
  MANUAL_REVIEW_REQUIRED: {
    REOPEN: "INVESTIGATING",
    CLOSE_DIRECTLY: "RESOLVED",
  },
  RESOLUTION_PROPOSAL: {
    RESOLUTION_APPROVED: "RESOLVED",
    RESOLUTION_REJECTED: "MANUAL_REVIEW_REQUIRED",
  },
  RESOLVED: {},
};

export function transition(
  current: InvestigationState,
  event: TransitionEvent,
  context: TransitionContext,
): TransitionResult {
  if (
    event.type === "REOPEN" &&
    current === "MANUAL_REVIEW_REQUIRED" &&
    context.retryCount >= REOPEN_LIMIT
  ) {
    return {
      ok: false,
      error: `cannot reopen investigation: retry limit reached (${context.retryCount}/${REOPEN_LIMIT})`,
    };
  }

  const nextState = TRANSITIONS[current][event.type];
  if (!nextState) {
    return {
      ok: false,
      error: `illegal transition: cannot apply ${event.type} from ${current}`,
    };
  }

  return { ok: true, state: nextState };
}
```

Create `src/state-machine/index.ts`:

```ts
export type { InvestigationState, TransitionContext, TransitionEvent, TransitionResult } from "./types";
export { transition } from "./transition";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/state-machine/transition.test.ts`
Expected: PASS, all tests green (25 tests: 9 legal + 4 illegal + 8 terminal-state + 2 retry-cap +
2 boundary-value loop iterations already counted above).

Also run: `bunx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/state-machine tests/state-machine
git commit -m "Module 08 Task 1: pure investigation state machine (FR-35)"
```

---

### Task 2: Wire the state machine into `src/investigations/`

**Files:**
- Create: `migrations/0003_investigation_state_machine.sql`
- Modify: `src/investigations/types.ts`
- Modify: `src/investigations/db.ts`
- Modify: `src/investigations/index.ts`
- Modify (rewrite): `tests/investigations/db.test.ts`
- Modify: `tests/timeline/slack-routes.test.ts:172` (test name only)

**Interfaces:**
- Consumes: `transition`, `InvestigationState`, `TransitionEvent` from Task 1's `src/state-machine`.
- Produces: `Investigation` now has `status: InvestigationState` (the 6-value union, not the old
  3-value one) and a new `retryCount: number` field. `InvestigationTransitionResult = { ok: true;
  investigation: Investigation } | { ok: false; error: string }`. New functions:
  `beginInvestigating(id: string): Promise<InvestigationTransitionResult>`,
  `completeInvestigation(id: string, outcome: { result: InvestigationResult; timeline:
  InvestigationTimeline }): Promise<InvestigationTransitionResult>` (return type changed — was
  `Promise<Investigation>`, now wrapped, and it no longer throws on a not-found id),
  `reopenInvestigation(id: string): Promise<InvestigationTransitionResult>`,
  `closeInvestigation(id: string): Promise<InvestigationTransitionResult>`. Task 3 (Slack handler
  and poller) consumes all of these.

**Why `completeInvestigation`'s signature is changing:** it previously returned a raw
`Investigation` and threw on a not-found id. Since this task already has to change its return type
to support the new typed illegal-transition rejection, this is also the natural point to make the
not-found case consistent with that same typed-result pattern (rather than one code path
throwing and another returning a typed result within the same function) — closing out a minor
finding parked during module 07's review. `createInvestigation` and `getInvestigation` are
unaffected; their existing tests for those two functions are unchanged except for the status
default (see below).

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `tests/investigations/db.test.ts` with:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  beginInvestigating,
  closeInvestigation,
  completeInvestigation,
  createInvestigation,
  getInvestigation,
  reopenInvestigation,
} from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { InvestigationTimeline } from "../../src/timeline/types";

afterEach(async () => {
  await truncateAll();
});

const fakeTimeline: InvestigationTimeline = { steps: [] };

const confirmedResult: InvestigationResult = {
  outcome: "CONFIRMED",
  hypothesis: {
    id: "h1",
    statement: "Scheduler is disabled",
    supportingEvidence: [],
    contradictingEvidence: [],
    status: "CONFIRMED",
    confidence: 0.8,
  },
  rca: "Scheduler is disabled",
  evidenceTrail: [],
  toolCalls: [],
};

const insufficientResult: InvestigationResult = {
  outcome: "INSUFFICIENT_EVIDENCE",
  hypothesesConsidered: [],
  reason: "no hypothesis was proposed",
  toolCalls: [],
};

describe("createInvestigation", () => {
  test("creates a record with status CREATED, retryCount 0, and no result yet", async () => {
    const investigation = await createInvestigation({
      problemDescription: "Elevated error rate starting at 14:03",
      slackChannelId: "C123",
      slackThreadTs: "1700000000.000100",
    });

    expect(investigation.id).toBeTruthy();
    expect(investigation.status).toBe("CREATED");
    expect(investigation.retryCount).toBe(0);
    expect(investigation.problemDescription).toBe("Elevated error rate starting at 14:03");
    expect(investigation.slackChannelId).toBe("C123");
    expect(investigation.slackThreadTs).toBe("1700000000.000100");
    expect(investigation.result).toBeNull();
  });

  test("slackChannelId/slackThreadTs are optional", async () => {
    const investigation = await createInvestigation({ problemDescription: "test problem" });

    expect(investigation.slackChannelId).toBeNull();
    expect(investigation.slackThreadTs).toBeNull();
  });
});

describe("getInvestigation", () => {
  test("round-trips a created investigation", async () => {
    const created = await createInvestigation({ problemDescription: "round trip test" });
    const fetched = await getInvestigation(created.id);

    expect(fetched).toEqual(created);
  });

  test("returns undefined for an id that doesn't exist", async () => {
    const fetched = await getInvestigation("00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeUndefined();
  });

  test("returns undefined for a malformed id, without throwing", async () => {
    const fetched = await getInvestigation("not-a-uuid");
    expect(fetched).toBeUndefined();
  });
});

describe("beginInvestigating", () => {
  test("CREATED -> INVESTIGATING succeeds", async () => {
    const created = await createInvestigation({ problemDescription: "test" });

    const result = await beginInvestigating(created.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.status).toBe("INVESTIGATING");
    }
  });

  test("calling it twice fails the second time (already past CREATED)", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);

    const result = await beginInvestigating(created.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("INVESTIGATING");
    }
  });

  test("returns a typed error for an id that doesn't exist, without throwing", async () => {
    const result = await beginInvestigating("00000000-0000-0000-0000-000000000000");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });
});

describe("completeInvestigation", () => {
  test("CONFIRMED outcome sets status RCA_IDENTIFIED and stores the result", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);

    const result = await completeInvestigation(created.id, {
      result: confirmedResult,
      timeline: fakeTimeline,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.status).toBe("RCA_IDENTIFIED");
      expect(result.investigation.result).toEqual({ result: confirmedResult, timeline: fakeTimeline });
    }
  });

  test("INSUFFICIENT_EVIDENCE outcome sets status MANUAL_REVIEW_REQUIRED", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);

    const result = await completeInvestigation(created.id, {
      result: insufficientResult,
      timeline: fakeTimeline,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.status).toBe("MANUAL_REVIEW_REQUIRED");
    }
  });

  test("fails with a typed error (not a throw) for an id that doesn't exist", async () => {
    const result = await completeInvestigation("00000000-0000-0000-0000-000000000000", {
      result: insufficientResult,
      timeline: fakeTimeline,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  test("fails with a typed error when called on a CREATED investigation (never began investigating)", async () => {
    const created = await createInvestigation({ problemDescription: "test" });

    const result = await completeInvestigation(created.id, {
      result: confirmedResult,
      timeline: fakeTimeline,
    });

    expect(result.ok).toBe(false);
  });
});

describe("reopenInvestigation", () => {
  async function reachManualReview(): Promise<string> {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);
    await completeInvestigation(created.id, { result: insufficientResult, timeline: fakeTimeline });
    return created.id;
  }

  test("MANUAL_REVIEW_REQUIRED -> INVESTIGATING succeeds and increments retryCount", async () => {
    const id = await reachManualReview();

    const result = await reopenInvestigation(id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.status).toBe("INVESTIGATING");
      expect(result.investigation.retryCount).toBe(1);
    }
  });

  test("allows exactly 3 reopens, rejects the 4th with the cap named in the error", async () => {
    const id = await reachManualReview();

    for (let i = 0; i < 3; i++) {
      await reopenInvestigation(id);
      await completeInvestigation(id, { result: insufficientResult, timeline: fakeTimeline });
    }

    const fourthAttempt = await reopenInvestigation(id);

    expect(fourthAttempt.ok).toBe(false);
    if (!fourthAttempt.ok) {
      expect(fourthAttempt.error).toContain("3");
    }

    const stored = await getInvestigation(id);
    expect(stored?.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(stored?.retryCount).toBe(3);
  });

  test("cannot reopen an RCA_IDENTIFIED investigation", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);
    await completeInvestigation(created.id, { result: confirmedResult, timeline: fakeTimeline });

    const result = await reopenInvestigation(created.id);

    expect(result.ok).toBe(false);
  });
});

describe("closeInvestigation", () => {
  test("closes an RCA_IDENTIFIED investigation directly to RESOLVED", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);
    await completeInvestigation(created.id, { result: confirmedResult, timeline: fakeTimeline });

    const result = await closeInvestigation(created.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.status).toBe("RESOLVED");
    }
  });

  test("closes a MANUAL_REVIEW_REQUIRED investigation directly to RESOLVED", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);
    await completeInvestigation(created.id, { result: insufficientResult, timeline: fakeTimeline });

    const result = await closeInvestigation(created.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.status).toBe("RESOLVED");
    }
  });

  test("cannot close a CREATED investigation directly (matches the spec's illegal-transition example)", async () => {
    const created = await createInvestigation({ problemDescription: "test" });

    const result = await closeInvestigation(created.id);

    expect(result.ok).toBe(false);
  });

  test("RESOLVED cannot be closed again", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(created.id);
    await completeInvestigation(created.id, { result: confirmedResult, timeline: fakeTimeline });
    await closeInvestigation(created.id);

    const result = await closeInvestigation(created.id);

    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/investigations/db.test.ts`
Expected: FAIL — `beginInvestigating`/`reopenInvestigation`/`closeInvestigation` are not exported
yet, and the migration hasn't added `retry_count` or the new status values.

- [ ] **Step 3: Write the implementation**

Create `migrations/0003_investigation_state_machine.sql`:

```sql
-- Module 08 (FR-35): migrate the placeholder 3-value status
-- (IN_PROGRESS | CONFIRMED | INSUFFICIENT_EVIDENCE, from module 07) to the
-- full 6-state lifecycle. Existing rows are dev data only (no production
-- users yet), so they're remapped in place. Constraint must be dropped
-- before the remap — Postgres validates ADD CONSTRAINT against existing
-- rows immediately, so adding the new CHECK before remapping old values
-- would fail on every existing row.

ALTER TABLE investigations
  DROP CONSTRAINT investigations_status_check;

UPDATE investigations SET status = 'INVESTIGATING' WHERE status = 'IN_PROGRESS';
UPDATE investigations SET status = 'RCA_IDENTIFIED' WHERE status = 'CONFIRMED';
UPDATE investigations SET status = 'MANUAL_REVIEW_REQUIRED' WHERE status = 'INSUFFICIENT_EVIDENCE';

ALTER TABLE investigations
  ADD CONSTRAINT investigations_status_check
    CHECK (status IN (
      'CREATED', 'INVESTIGATING', 'RCA_IDENTIFIED', 'MANUAL_REVIEW_REQUIRED',
      'RESOLUTION_PROPOSAL', 'RESOLVED'
    ));

ALTER TABLE investigations
  ALTER COLUMN status SET DEFAULT 'CREATED';

ALTER TABLE investigations
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0;
```

If the `ALTER TABLE ... DROP CONSTRAINT investigations_status_check` fails because Postgres
auto-named the inline `CHECK` from `migrations/0002_investigations.sql` differently than the
standard `<table>_<column>_check` convention, query the real name first
(`SELECT conname FROM pg_constraint WHERE conrelid = 'investigations'::regclass AND contype =
'c';` against the dev database) and use that name instead — this is expected verification, not a
placeholder to fill in.

Replace the contents of `src/investigations/types.ts`:

```ts
// The persistent Investigation record (FR-33, FR-35). Unlike src/session's
// in-memory registry (removed the moment investigate() resolves), this
// survives indefinitely — FR-34's link may be clicked long after the
// investigation finishes. `status` is now the full FR-35 lifecycle (see
// src/state-machine/), not module 07's original 3-value placeholder.
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";
import type { InvestigationState } from "../state-machine";

export interface Investigation {
  readonly id: string;
  readonly status: InvestigationState;
  readonly retryCount: number;
  readonly problemDescription: string;
  readonly slackChannelId: string | null;
  readonly slackThreadTs: string | null;
  readonly result: { result: InvestigationResult; timeline: InvestigationTimeline } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type InvestigationTransitionResult =
  | { ok: true; investigation: Investigation }
  | { ok: false; error: string };
```

Replace the contents of `src/investigations/db.ts`:

```ts
// Persistence for the Investigation record (FR-33, FR-35). Mirrors
// src/brain/entities.ts's exact query/row-mapping style — same sql
// tagged-template connection, same "jsonb comes back as raw text,
// JSON.parse it yourself" handling.
import { sql } from "../brain/db";
import type { Investigation, InvestigationTransitionResult } from "./types";
import type { InvestigationResult } from "../agent/types";
import type { InvestigationTimeline } from "../timeline/types";
import { transition } from "../state-machine";
import type { TransitionEvent } from "../state-machine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvestigationRow {
  id: string;
  status: string;
  retry_count: number;
  problem_description: string;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  result: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    status: row.status as Investigation["status"],
    retryCount: row.retry_count,
    problemDescription: row.problem_description,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    result: row.result ? (JSON.parse(row.result) as Investigation["result"]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createInvestigation(input: {
  problemDescription: string;
  slackChannelId?: string;
  slackThreadTs?: string;
}): Promise<Investigation> {
  const [row] = await sql<InvestigationRow[]>`
    INSERT INTO investigations (problem_description, slack_channel_id, slack_thread_ts)
    VALUES (
      ${input.problemDescription},
      ${input.slackChannelId ?? null},
      ${input.slackThreadTs ?? null}
    )
    RETURNING *
  `;
  return rowToInvestigation(row);
}

export async function getInvestigation(id: string): Promise<Investigation | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await sql<InvestigationRow[]>`SELECT * FROM investigations WHERE id = ${id}`;
  return row ? rowToInvestigation(row) : undefined;
}

export async function beginInvestigating(id: string): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const result = transition(current.status, { type: "BEGIN_INVESTIGATING" }, {
    retryCount: current.retryCount,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations SET status = ${result.state}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return { ok: true, investigation: rowToInvestigation(row) };
}

export async function completeInvestigation(
  id: string,
  outcome: { result: InvestigationResult; timeline: InvestigationTimeline },
): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const event: TransitionEvent =
    outcome.result.outcome === "CONFIRMED"
      ? { type: "RCA_CONFIRMED" }
      : { type: "INSUFFICIENT_EVIDENCE" };
  const result = transition(current.status, event, { retryCount: current.retryCount });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const resultJson = JSON.stringify(outcome);
  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations
    SET status = ${result.state}, result = ${resultJson}::jsonb, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return { ok: true, investigation: rowToInvestigation(row) };
}

// Known limitation: this reads the current row, computes the next state,
// then issues a separate UPDATE — not atomic. Two near-simultaneous
// reopen calls on the same investigation could both read retryCount=2 and
// both succeed, pushing the real count to 4 rather than the 3 this module
// enforces. Accepted for now: this is single-operator-scale software with
// no concurrent-caller scenario in real usage (a human does not click
// "reopen" twice in the same instant), and no other function in this
// codebase uses row-locking/transactions for this kind of update. Revisit
// if a real concurrent-write scenario ever appears.
export async function reopenInvestigation(id: string): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const result = transition(current.status, { type: "REOPEN" }, { retryCount: current.retryCount });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations
    SET status = ${result.state}, retry_count = ${current.retryCount + 1}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return { ok: true, investigation: rowToInvestigation(row) };
}

export async function closeInvestigation(id: string): Promise<InvestigationTransitionResult> {
  const current = await getInvestigation(id);
  if (!current) {
    return { ok: false, error: `investigation not found: ${id}` };
  }

  const result = transition(current.status, { type: "CLOSE_DIRECTLY" }, {
    retryCount: current.retryCount,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const [row] = await sql<InvestigationRow[]>`
    UPDATE investigations SET status = ${result.state}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return { ok: true, investigation: rowToInvestigation(row) };
}
```

Replace the contents of `src/investigations/index.ts`:

```ts
export type { Investigation, InvestigationTransitionResult } from "./types";
export {
  beginInvestigating,
  closeInvestigation,
  completeInvestigation,
  createInvestigation,
  getInvestigation,
  reopenInvestigation,
} from "./db";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/investigations/db.test.ts`
Expected: PASS, all tests green.

Also run: `bunx tsc --noEmit`
Expected: this will fail with TS2367 ("This comparison appears to be unintentional because the
types 'InvestigationState' and '"IN_PROGRESS"' have no overlap") at
`src/timeline/server.ts:113`, which currently reads:

```ts
if (!investigation || investigation.status === "IN_PROGRESS" || !investigation.result) {
```

`"IN_PROGRESS"` is no longer a valid `InvestigationState` value after Task 2's migration, so this
comparison can never be true — and `!investigation.result` already fully covers the same
condition it was checking for (no stored result yet means the investigation hasn't completed,
regardless of which pre-completion state it's in). Fix by deleting the now-redundant check:

```ts
if (!investigation || !investigation.result) {
```

Re-run `bunx tsc --noEmit` after this fix — expect it clean.

Also, `tests/timeline/slack-routes.test.ts:172` has a test named `"404s while the investigation is
still IN_PROGRESS"` — its body (create an investigation, fetch its timeline, expect 404) still
passes unchanged under the new lifecycle (a freshly created investigation's `result` is still
`null` regardless of its exact status name), but the name references a status value that no
longer exists. Rename it to `"404s while the investigation is not yet complete"` — no other change
to that file or test body.

Also run the full suite: `bun test`
Expected: exactly 8 pre-existing failures in `tests/integrations/github/{client,sync}.test.ts`
(live GitHub API auth) — anything else, including any failure newly appearing in
`tests/timeline/`, must be fixed as part of this task before moving on.

- [ ] **Step 5: Commit**

```bash
git add migrations/0003_investigation_state_machine.sql src/investigations tests/investigations src/timeline/server.ts tests/timeline/slack-routes.test.ts
git commit -m "Module 08 Task 2: wire the state machine into the Investigation record (FR-35)"
```

---

### Task 3: Slack visibility (`src/slack/handler.ts`, `src/slack/poller.ts`)

**Files:**
- Modify: `src/slack/handler.ts`
- Modify: `src/slack/poller.ts`
- Modify: `tests/slack/handler.test.ts`
- Modify: `tests/slack/poller.test.ts`

**Interfaces:**
- Consumes: `beginInvestigating`, `completeInvestigation` (Task 2's reworked wrapped-result
  version) from `../investigations`.
- Produces: no new exported interface — this task only changes the text of existing Slack
  messages and the internal call sequence. Task 4 (docs) reads the final real message text from
  these two files.

- [ ] **Step 1: Write the failing test**

In `tests/slack/handler.test.ts`, add one assertion to the first test (`"strips the leading
mention token..."`) right after the existing `expect(postCalls[0]!.text).toContain("Investigating");`
line:

```ts
    expect(postCalls[0]!.text).toContain("Status: INVESTIGATING");
```

In `tests/slack/poller.test.ts`:

1. Change the import line from:
```ts
import { createInvestigation, getInvestigation } from "../../src/investigations";
```
to:
```ts
import { beginInvestigating, createInvestigation, getInvestigation } from "../../src/investigations";
```

2. In the first test (`"posts a progress update only when stepNumber has advanced, then posts the
   final CONFIRMED result"`), add `await beginInvestigating(investigation.id);` immediately after
   the line `const investigation = await createInvestigation({ problemDescription: "test" });`.
   Change `expect(stored!.status).toBe("CONFIRMED");` to `expect(stored!.status).toBe("RCA_IDENTIFIED");`
   and add a new assertion right after it:
```ts
    expect(posts[1]!.text).toContain("Status: RCA_IDENTIFIED");
```

3. In the second test (`"INSUFFICIENT_EVIDENCE result posts the NOT CONFIRMED report text"`), add
   `await beginInvestigating(investigation.id);` immediately after
   `const investigation = await createInvestigation({ problemDescription: "test" });`. Change
   `expect(stored!.status).toBe("INSUFFICIENT_EVIDENCE");` to
   `expect(stored!.status).toBe("MANUAL_REVIEW_REQUIRED");` and add a new assertion right after
   the existing `expect(posts[0]!.text).toContain("NOT CONFIRMED");` line:
```ts
    expect(posts[0]!.text).toContain("Status: MANUAL_REVIEW_REQUIRED");
```

4. In the third test (`"a failed progress-update postMessage call..."`), add `await
   beginInvestigating(investigation.id);` immediately after `const investigation = await
   createInvestigation({ problemDescription: "test" });` (for realism; this test's own assertion
   on `callCount` is unaffected).

The fourth test (`"a rejecting resultPromise..."`) needs no change — the reject path never reaches
`completeInvestigation`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/slack/handler.test.ts tests/slack/poller.test.ts`
Expected: FAIL — the new `"Status: ..."` assertions don't match current message text yet.

- [ ] **Step 3: Write the implementation**

Replace the contents of `src/slack/handler.ts`:

```ts
// FR-32/33: the only place this module's Slack-specific code meets
// modules 03/06/08's investigation lifecycle. No investigation logic here —
// this only orchestrates: create the record, transition it to
// INVESTIGATING (FR-35), ack, kick off investigate() without blocking,
// hand off progress/completion to the poller.
import { investigate } from "../agent";
import type { InvestigateOptions } from "../agent";
import type { InvestigationResult } from "../agent/types";
import { beginInvestigating, createInvestigation } from "../investigations";
import { postMessage } from "./client";
import type { PostMessageResult, PostMessageInput } from "./client";
import { pollAndPost } from "./poller";

// app_mention events fire only when this app itself is mentioned, so the
// leading <@ANYID> token is always this bot — no need for a separately
// configured bot user id env var to know which id to strip.
const LEADING_MENTION_RE = /^<@[^>]+>\s*/;

export interface AppMentionEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export interface HandleAppMentionOptions {
  investigateImpl?: (problem: string, options?: InvestigateOptions) => Promise<InvestigationResult>;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}

export async function handleAppMention(
  event: AppMentionEvent,
  opts: HandleAppMentionOptions = {},
): Promise<void> {
  const investigateImpl = opts.investigateImpl ?? investigate;
  const postMessageImpl = opts.postMessageImpl ?? postMessage;
  const baseUrl = opts.baseUrl ?? "http://localhost:4300";

  const problemDescription = event.text.replace(LEADING_MENTION_RE, "").trim();
  const threadTs = event.thread_ts ?? event.ts;

  const investigation = await createInvestigation({
    problemDescription,
    slackChannelId: event.channel,
    slackThreadTs: threadTs,
  });

  // CREATED -> INVESTIGATING (FR-35). In the real flow this can only fail
  // if the record isn't actually still CREATED, which shouldn't happen —
  // nothing else touches a brand-new record before this call. A failure
  // here is logged but doesn't block the investigation from proceeding;
  // the Slack-visible status line below falls back to a neutral label
  // rather than failing the whole request over lifecycle bookkeeping.
  const began = await beginInvestigating(investigation.id);
  if (!began.ok) {
    console.error(`slack handler: beginInvestigating failed for ${investigation.id}: ${began.error}`);
  }
  const status = began.ok ? began.investigation.status : "INVESTIGATING";

  const link = `${baseUrl}/?investigation=${investigation.id}`;
  await postMessageImpl({
    channel: event.channel,
    thread_ts: threadTs,
    text: `Investigating — I'll post updates here. Full view: ${link}\nStatus: ${status}`,
  });

  const resultPromise = investigateImpl(problemDescription, { sessionId: investigation.id });

  // Deliberately not awaited — the poller owns the rest of this
  // investigation's lifecycle, including posting the final result.
  void pollAndPost(
    investigation.id,
    investigation.id,
    resultPromise,
    { channel: event.channel, thread_ts: threadTs },
    { postMessageImpl },
  );
}
```

In `src/slack/poller.ts`, replace the success-path block inside the `try` (everything from `const
result = await resultPromise;` through the `logIfFailed(finalResult, "final result");` line) with:

```ts
    const result = await resultPromise;

    const timeline = buildTimeline(result.toolCalls);
    const completed = await completeInvestigation(investigationId, { result, timeline });
    if (!completed.ok) {
      console.error(
        `slack poller: completeInvestigation failed for ${investigationId}: ${completed.error}`,
      );
    }
    const statusLine = completed.ok ? `\nStatus: ${completed.investigation.status}` : "";

    const link = `${baseUrl}/?investigation=${investigationId}`;
    const finalText =
      result.outcome === "CONFIRMED"
        ? `✅ Root cause confirmed: ${result.rca}\nFull view: ${link}${statusLine}`
        : `${renderFailureReport(buildFailureReport(result))}\nFull view: ${link}${statusLine}`;

    const finalResult = await postMessageImpl({
      channel: slackTarget.channel,
      thread_ts: slackTarget.thread_ts,
      text: finalText,
    });
    logIfFailed(finalResult, "final result");
```

Everything else in `poller.ts` (the `catch`/`finally` blocks, the progress-update logic inside the
interval callback, all imports except none new are needed since `completeInvestigation`'s import
path is unchanged) stays exactly as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/slack/handler.test.ts tests/slack/poller.test.ts`
Expected: PASS, all tests green.

Also run the full suite: `bun test`
Expected: exactly 8 pre-existing failures (`tests/integrations/github/`). `bunx tsc --noEmit`:
clean.

- [ ] **Step 5: Commit**

```bash
git add src/slack/handler.ts src/slack/poller.ts tests/slack/handler.test.ts tests/slack/poller.test.ts
git commit -m "Module 08 Task 3: surface lifecycle state in Slack messages (FR-35)"
```

---

### Task 4: Documentation (`docs/state-machine.md`)

**Files:**
- Create: `docs/state-machine.md`

**Interfaces:**
- Consumes: the real, shipped shapes from Tasks 1–3 (`src/state-machine/`, `src/investigations/`,
  the Slack message text) — read the actual current source files before writing this, do not copy
  from this plan or the design doc without verifying against real code, in case anything was
  adjusted during Tasks 1–3 (e.g. the exact constraint name in Task 2's migration, if it had to be
  looked up).
- Produces: nothing consumed by later work — this is the last task.

- [ ] **Step 1: Write the doc**

Create `docs/state-machine.md`:

```markdown
# Investigation State Machine (FR-35)

Formalizes the investigation lifecycle so every module transitions state the same, predictable
way. See `src/state-machine/` for the implementation and `docs/superpowers/specs/2026-08-24-module-08-state-machine-design.md`
for the full design rationale.

## The state diagram

Seven states. `RESOLVED` is the only true terminal state — it accepts no events at all.

| From | Event | To |
|---|---|---|
| `CREATED` | `BEGIN_INVESTIGATING` | `INVESTIGATING` |
| `INVESTIGATING` | `RCA_CONFIRMED` | `RCA_IDENTIFIED` |
| `INVESTIGATING` | `INSUFFICIENT_EVIDENCE` | `MANUAL_REVIEW_REQUIRED` |
| `RCA_IDENTIFIED` | `PROPOSE_RESOLUTION` | `RESOLUTION_PROPOSAL` |
| `RCA_IDENTIFIED` | `CLOSE_DIRECTLY` | `RESOLVED` |
| `MANUAL_REVIEW_REQUIRED` | `REOPEN` (retryCount < 3) | `INVESTIGATING` |
| `MANUAL_REVIEW_REQUIRED` | `CLOSE_DIRECTLY` | `RESOLVED` |
| `RESOLUTION_PROPOSAL` | `RESOLUTION_APPROVED` | `RESOLVED` |
| `RESOLUTION_PROPOSAL` | `RESOLUTION_REJECTED` | `MANUAL_REVIEW_REQUIRED` |

Every other `(state, event)` pair is illegal and `transition()` rejects it with a typed
`{ok:false, error}` result — never a throw.

## The spec's four open questions, answered

1. **Direct `INVESTIGATING → MANUAL_REVIEW_REQUIRED`, not only via a failed RCA attempt.** Module
   03's `investigate()` produces exactly two outcomes (`CONFIRMED`/`INSUFFICIENT_EVIDENCE`) — there
   is no intermediate "attempted RCA that failed" state in the real code.
2. **`MANUAL_REVIEW_REQUIRED` is not terminal.** The `REOPEN` edge exists and is enforced. Its real
   trigger (a human adding new information mid-review) is module 06's FR-27, a SHOULD that remains
   unbuilt — this module makes the transition legal and testable, not wired to a live trigger yet.
3. **A rejected `RESOLUTION_PROPOSAL` routes back to `MANUAL_REVIEW_REQUIRED`**, not a new
   `REJECTED` state — rejection means "a human needs to decide what happens next," which
   `MANUAL_REVIEW_REQUIRED` already represents. Module 09 (not built) owns the actual
   approve/reject sub-workflow inside `RESOLUTION_PROPOSAL`.
4. **Reopen retry cap: 3.** Tracked via `retryCount` on the `Investigation` record, incremented on
   each successful `REOPEN`. The 4th attempt is rejected with a typed error naming the cap; the
   investigation stays in `MANUAL_REVIEW_REQUIRED` (still reachable via `CLOSE_DIRECTLY`).

## Direct closure (`CLOSE_DIRECTLY`)

Added during design review, not named in the spec's original six states: a human-initiated "mark
resolved outside the automated remediation workflow" action, available from both `RCA_IDENTIFIED`
and `MANUAL_REVIEW_REQUIRED`. Without it, an investigation stuck at `MANUAL_REVIEW_REQUIRED` after
its 3 reopens are exhausted would have no path to `RESOLVED`, and a confirmed root cause needing no
code/DML remediation would be forced through `RESOLUTION_PROPOSAL` for no reason.

## Migration and existing data

`migrations/0003_investigation_state_machine.sql` remaps module 07's original 3-value status
(dev data only, no production users existed at the time) to the new lifecycle:

| Old value | New value |
|---|---|
| `IN_PROGRESS` | `INVESTIGATING` |
| `CONFIRMED` | `RCA_IDENTIFIED` |
| `INSUFFICIENT_EVIDENCE` | `MANUAL_REVIEW_REQUIRED` |

The column default also changed from `IN_PROGRESS` to `CREATED` — a freshly created `Investigation`
now genuinely starts in `CREATED` and only enters `INVESTIGATING` once `beginInvestigating()` is
called.

## Slack visibility

`src/slack/handler.ts`'s ack message and `src/slack/poller.ts`'s final message each include a
`Status: <state>` line, so the lifecycle's transitions are observable live in the Slack thread —
not just via tests or a direct database query. Mid-investigation progress updates are unchanged;
the state doesn't change during `INVESTIGATING` itself, only at its boundaries.

## What this module does not build

- `RESOLUTION_PROPOSAL`'s own DB wrapper functions (`proposeResolution`, `rejectResolution`,
  `resolveFromProposal`) — module 09 doesn't exist yet, so nothing calls them. The transition
  rules for those two edges exist and are tested in `src/state-machine/transition.ts`; the DB
  wrappers are module 09's job to add when it needs them.
- A live trigger for `REOPEN` — module 06's FR-27 (unbuilt) owns accepting human input
  mid-investigation; this module only makes the resulting transition legal.

## Testing

- `tests/state-machine/transition.test.ts` — pure unit tests, no database: every legal edge, the
  spec's explicit illegal example, `RESOLVED` rejecting every possible event, and the retry cap
  (allowed at 0/1/2, rejected at 3).
- `tests/investigations/db.test.ts` — real-database tests: each wrapper function persists the
  correct `status`/`retry_count` on a legal transition and refuses to touch the row on an illegal
  one.
- `tests/slack/handler.test.ts` / `tests/slack/poller.test.ts` — the ack and final messages
  include the expected `Status: ...` line, using this module's established injected-mock pattern
  (no test ever triggers a real `investigate()`/Anthropic API call).
```

- [ ] **Step 2: Verify accuracy against real code**

Before committing, re-read `src/state-machine/transition.ts`, `src/investigations/db.ts`,
`src/slack/handler.ts`, and `src/slack/poller.ts` as they actually exist after Tasks 1–3, and
confirm every claim in the doc above (the table, the retry cap value, the migration's constraint
name if it differed from the guessed one, the exact `Status: ...` message wording) still matches.
Fix any drift before committing.

- [ ] **Step 3: Commit**

```bash
git add docs/state-machine.md
git commit -m "Module 08 Task 4: document the investigation state machine (FR-35)"
```
