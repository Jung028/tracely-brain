# Module 06 — Human Collaboration (FR-28) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an in-progress investigation's current step and hypotheses observable from outside `investigate()` while it is still running (FR-28), via an in-memory, poll-based session registry.

**Architecture:** Add a `stepNumber` counter to module 03's existing `InvestigationState` (incremented once per tool call via a shared wrapper). Add a new `src/session/` module holding an in-memory `Map<sessionId, InvestigationState>` registry with register/unregister/read functions, where reads return defensive snapshot copies. `investigate()` optionally registers/unregisters itself under a caller-supplied `sessionId`, fully backward compatible when omitted.

**Tech Stack:** TypeScript, Bun, `bun:test`, existing `@anthropic-ai/sdk` mock-client test helpers (no new dependencies).

**Spec:** `specs/06-human-collaboration.md` (FR-28 only — FR-27 explicitly deferred). Design: `docs/superpowers/specs/2026-08-23-module-06-human-collaboration-design.md`.

## Global Constraints

- FR-28 (MUST) is the only requirement this plan implements. FR-27 (SHOULD) is explicitly out of
  scope for this plan — do not build any mid-investigation input-injection mechanism.
- `investigate()` called without a `sessionId` must behave byte-for-byte identically to before
  this plan — no new registration, no new overhead, no behavior change for any existing caller or
  test.
- `getInvestigationState` must never return a live reference into the mutable `InvestigationState`
  object — every read is a defensive copy, so a caller cannot mutate an in-progress investigation
  from outside.
- Never fabricate: `stepNumber` must be a real, derived counter (incremented on actual tool
  execution) — never an invented or approximated number (CLAUDE.md's "no invented numbers" rule).
- Do not implement anything from a later-numbered spec (e.g. `07-slack-interface.md`'s actual
  chat surface) — this plan is the underlying capability only.

---

### Task 1: `stepNumber` tracking in `InvestigationState`

**Files:**
- Modify: `src/agent/tools.ts:20-26` (the `InvestigationState` interface and `createInvestigationState`), and each of the six tool `run` functions (lines 63, 92, 133, 144, 157, 177 in the current file)
- Test: `tests/agent/tools.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: nothing new — only existing exports of `src/agent/tools.ts`.
- Produces: `InvestigationState.stepNumber: number` (starts at `0`, incremented by exactly 1 each
  time any tool's `run` executes). Task 2 (the session registry) reads this field. This task does
  **not** export a `withStep` symbol — it's a private helper local to `tools.ts`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agent/tools.test.ts`:

```ts
describe("stepNumber tracking", () => {
  test("starts at 0 and increments by exactly 1 per tool call, across different tools", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const propose = getTool(tools, "propose_hypothesis");
    const queryDatabase = getTool(tools, "query_database");

    expect(state.stepNumber).toBe(0);

    await propose.run({ statement: "Scheduler is disabled" });
    expect(state.stepNumber).toBe(1);

    await queryDatabase.run({ query: "SELECT 1" });
    expect(state.stepNumber).toBe(2);

    const hypothesisId = state.hypotheses[0].id;
    const update = getTool(tools, "update_hypothesis");
    await update.run({
      hypothesisId,
      direction: "supporting",
      description: "n/a",
      toolSource: "query_database",
    });
    expect(state.stepNumber).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/tools.test.ts`
Expected: FAIL — `state.stepNumber` is `undefined`, `expect(undefined).toBe(0)` fails.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/tools.ts`, change the `InvestigationState` interface and its constructor:

```ts
export interface InvestigationState {
  hypotheses: Hypothesis[];
  stepNumber: number;
}

export function createInvestigationState(): InvestigationState {
  return { hypotheses: [], stepNumber: 0 };
}
```

Add a private wrapper directly below `replaceHypothesis` (before `createTools`):

```ts
function withStep<Input>(
  state: InvestigationState,
  run: (input: Input) => Promise<string>,
): (input: Input) => Promise<string> {
  return async (input: Input) => {
    state.stepNumber++;
    return run(input);
  };
}
```

Wrap each tool's `run` in `withStep(state, ...)`. All six — change only the `run:` line of each
`betaZodTool({...})` call, keep every other field (`name`, `description`, `inputSchema`)
unchanged:

```ts
    run: withStep(state, async (input) => {
      if (input.mode === "search") {
        const entities = await findEntities({
          domain: input.domain,
          entityType: input.entityType,
        });
        return JSON.stringify(entities);
      }

      if (!input.startEntityId) {
        return "traverse mode requires startEntityId — run a search first to find one";
      }
      const result = await traverse({
        startEntityId: input.startEntityId,
        relationshipTypes: input.relationshipTypes,
        maxDepth: input.maxDepth,
      });
      return JSON.stringify(result);
    }),
```

```ts
    run: withStep(state, async (input) => {
      const files = await findEntities({ domain: "Code", entityType: "File" });
      const matches = files.filter((f) => f.name.includes(input.pathContains));
      if (matches.length === 0) {
        return `no synced files match "${input.pathContains}"`;
      }

      const results: string[] = [];
      for (const file of matches.slice(0, 5)) {
        const match = /^github:([^/]+)\/([^:]+):/.exec(file.sourceRef);
        if (!match) continue;
        const [, owner, repo] = match;
        const sha = (file.attributes as { sha?: string }).sha;
        if (!sha) continue;

        const content = await getFileContent(owner, repo, sha);
        if ("ok" in content && content.ok) {
          results.push(`--- ${file.name} ---\n${content.data.content}`);
        } else {
          results.push(`--- ${file.name} --- (read failed: ${JSON.stringify(content)})`);
        }
      }
      return results.join("\n\n");
    }),
```

```ts
    run: withStep(state, async () => {
      return JSON.stringify({ status: "NOT_IMPLEMENTED", tool: "query_database" });
    }),
```

```ts
    run: withStep(state, async () => {
      return JSON.stringify({ status: "NOT_IMPLEMENTED", tool: "search_logs" });
    }),
```

```ts
    run: withStep(state, async (input) => {
      const hypothesis = proposeHypothesisFn(input.statement);
      state.hypotheses.push(hypothesis);
      return `created hypothesis ${hypothesis.id}: ${hypothesis.statement}`;
    }),
```

```ts
    run: withStep(state, async (input) => {
      const hypothesis = findHypothesis(state, input.hypothesisId);
      if (!hypothesis) {
        return `hypothesis not found: ${input.hypothesisId}`;
      }

      const evidence: Evidence = {
        id: crypto.randomUUID(),
        toolSource: input.toolSource,
        description: input.description,
        timestamp: new Date(),
        raw: null,
      };

      const updated =
        input.direction === "supporting"
          ? addSupportingEvidence(hypothesis, evidence)
          : addContradictingEvidence(hypothesis, evidence);

      replaceHypothesis(state, updated);
      return `hypothesis ${updated.id} is now ${updated.status} (confidence ${updated.confidence.toFixed(2)})`;
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/tools.test.ts`
Expected: PASS, including all pre-existing tests in this file (unaffected — `withStep` only adds a
side effect, doesn't change any return value or existing behavior).

- [ ] **Step 5: Run the full suite and typecheck to confirm no regressions**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as before this task (the 8 pre-existing live-GitHub-API failures
are unrelated and expected), zero new failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "Module 06 Task 1: add stepNumber tracking to InvestigationState"
```

---

### Task 2: Session registry (`src/session/`)

**Files:**
- Create: `src/session/types.ts`
- Create: `src/session/registry.ts`
- Create: `src/session/index.ts`
- Test: `tests/session/registry.test.ts`

**Interfaces:**
- Consumes: `InvestigationState` from `src/agent/tools.ts` (Task 1's `stepNumber` field),
  `Hypothesis` from `src/agent/types.ts`.
- Produces: `registerSession(sessionId: string, state: InvestigationState): void`,
  `unregisterSession(sessionId: string): void`,
  `getInvestigationState(sessionId: string): LiveInvestigationState | undefined`,
  `LiveInvestigationState` type — all exported from `src/session/index.ts`. Task 3 (`investigate.ts`)
  calls `registerSession`/`unregisterSession` directly.

- [ ] **Step 1: Write the failing test**

Create `tests/session/registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { registerSession, unregisterSession, getInvestigationState } from "../../src/session";
import { createInvestigationState } from "../../src/agent/tools";
import { proposeHypothesis } from "../../src/agent/hypotheses";
import type { Hypothesis } from "../../src/agent/types";

describe("session registry", () => {
  test("getInvestigationState returns undefined for an unregistered session", () => {
    expect(getInvestigationState("does-not-exist")).toBeUndefined();
  });

  test("registerSession then getInvestigationState returns a snapshot of the current state", () => {
    const sessionId = crypto.randomUUID();
    const state = createInvestigationState();
    state.hypotheses.push(proposeHypothesis("Scheduler is disabled"));
    state.stepNumber = 3;

    registerSession(sessionId, state);
    const snapshot = getInvestigationState(sessionId);

    expect(snapshot).toBeDefined();
    expect(snapshot!.sessionId).toBe(sessionId);
    expect(snapshot!.status).toBe("IN_PROGRESS");
    expect(snapshot!.stepNumber).toBe(3);
    expect(snapshot!.hypotheses).toHaveLength(1);
    expect(snapshot!.hypotheses[0]!.statement).toBe("Scheduler is disabled");

    unregisterSession(sessionId);
  });

  test("registering the same sessionId twice throws", () => {
    const sessionId = crypto.randomUUID();
    registerSession(sessionId, createInvestigationState());

    expect(() => registerSession(sessionId, createInvestigationState())).toThrow();

    unregisterSession(sessionId);
  });

  test("unregisterSession removes the entry — subsequent getInvestigationState returns undefined", () => {
    const sessionId = crypto.randomUUID();
    registerSession(sessionId, createInvestigationState());
    unregisterSession(sessionId);

    expect(getInvestigationState(sessionId)).toBeUndefined();
  });

  test("unregistering a sessionId that was never registered is a harmless no-op", () => {
    expect(() => unregisterSession("never-registered")).not.toThrow();
  });

  test("the snapshot's hypotheses array is a copy, not a live reference into the registered state", () => {
    const sessionId = crypto.randomUUID();
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const snapshot = getInvestigationState(sessionId)!;
    (snapshot.hypotheses as Hypothesis[]).push(proposeHypothesis("mutated from outside"));

    expect(state.hypotheses).toHaveLength(0);

    unregisterSession(sessionId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session/registry.test.ts`
Expected: FAIL — `../../src/session` module does not exist (import error).

- [ ] **Step 3: Write minimal implementation**

Create `src/session/types.ts`:

```ts
// FR-28's read model — a point-in-time snapshot of a running investigation,
// returned by getInvestigationState. Never a live reference into the
// mutable InvestigationState a running investigate() call owns.
import type { Hypothesis } from "../agent/types";

export interface LiveInvestigationState {
  readonly sessionId: string;
  readonly status: "IN_PROGRESS";
  readonly stepNumber: number;
  readonly hypotheses: readonly Hypothesis[];
}
```

Create `src/session/registry.ts`:

```ts
// In-memory, poll-based session registry (FR-28). A caller with a
// sessionId can read a running investigation's current state at any point
// before investigate() resolves — see docs/human-collaboration.md.
import type { InvestigationState } from "../agent/tools";
import type { LiveInvestigationState } from "./types";

const sessions = new Map<string, InvestigationState>();

/** Throws on a duplicate sessionId — prevents one investigation's state
 * from silently overwriting/cross-talking with another's in the registry. */
export function registerSession(sessionId: string, state: InvestigationState): void {
  if (sessions.has(sessionId)) {
    throw new Error(`session already registered: ${sessionId}`);
  }
  sessions.set(sessionId, state);
}

/** No-op if the sessionId isn't registered — safe to call unconditionally
 * from a finally block regardless of whether registration happened. */
export function unregisterSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Returns a defensive snapshot copy — never the live InvestigationState
 * object — so a caller can't mutate an in-progress investigation. */
export function getInvestigationState(sessionId: string): LiveInvestigationState | undefined {
  const state = sessions.get(sessionId);
  if (!state) return undefined;

  return {
    sessionId,
    status: "IN_PROGRESS",
    stepNumber: state.stepNumber,
    hypotheses: [...state.hypotheses],
  };
}
```

Create `src/session/index.ts`:

```ts
export type { LiveInvestigationState } from "./types";
export { registerSession, unregisterSession, getInvestigationState } from "./registry";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session/registry.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: same pass/fail counts as after Task 1 plus the 6 new registry tests passing, zero new
failures, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add src/session tests/session/registry.test.ts
git commit -m "Module 06 Task 2: in-memory session registry for live investigation state"
```

---

### Task 3: Wire `sessionId` into `investigate()`

**Files:**
- Modify: `src/agent/investigate.ts` (all of it — file is only 67 lines)
- Test: `tests/session/live-state.test.ts`

**Interfaces:**
- Consumes: `registerSession`, `unregisterSession` from `src/session/registry.ts` (Task 2);
  `getInvestigationState` from `src/session/index.ts` (Task 2, used only by the test, not by
  `investigate.ts` itself).
- Produces: `InvestigateOptions.sessionId?: string` — the public opt-in for live-state visibility.
  No new exports beyond this field; `investigate()`'s return type (`Promise<InvestigationResult>`)
  is unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/session/live-state.test.ts`:

```ts
// End-to-end proof of FR-28: getInvestigationState reflects hypotheses
// added mid-run, read from inside the mock client's own callback — which
// runs while investigate() is still suspended awaiting the "network" call,
// proving the state is observable before investigate() resolves, not only
// after.
import { describe, expect, test } from "bun:test";
import { investigate } from "../../src/agent/investigate";
import { getInvestigationState } from "../../src/session";
import { createStepFunctionClient, extractHypothesisId } from "../agent/helpers/mockAnthropicClient";

describe("live investigation state (FR-28)", () => {
  test("getInvestigationState reflects hypotheses added mid-run, and the session is gone after completion", async () => {
    const sessionId = crypto.randomUUID();
    let hypothesisId: string | undefined;
    let sawHypothesisMidRun = false;
    let sawStepNumberAdvance = false;
    let lastStepNumberSeen = -1;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex > 1) {
        const snapshot = getInvestigationState(sessionId);
        expect(snapshot).toBeDefined();
        if (snapshot!.hypotheses.length > 0) sawHypothesisMidRun = true;
        if (snapshot!.stepNumber > lastStepNumberSeen) sawStepNumberAdvance = true;
        lastStepNumberSeen = snapshot!.stepNumber;
      }

      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: { statement: "Scheduler is disabled" },
            },
          ],
        };
      }

      if (callIndex <= 3) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_evidence_${callIndex}`,
              name: "update_hypothesis",
              input: {
                hypothesisId,
                direction: "supporting",
                description: `supporting evidence ${callIndex}`,
                toolSource: "query_brain",
              },
            },
          ],
        };
      }

      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "stopping here" }],
      };
    });

    expect(getInvestigationState(sessionId)).toBeUndefined();

    const result = await investigate("Task stuck in WAIT_JUDGE", { client, sessionId });

    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(sawHypothesisMidRun).toBe(true);
    expect(sawStepNumberAdvance).toBe(true);
    expect(getInvestigationState(sessionId)).toBeUndefined();
  });

  test("a sessionId is unregistered even when the tool-runner call throws", async () => {
    const sessionId = crypto.randomUUID();
    const throwingClient = {
      beta: {
        messages: {
          toolRunner: () => {
            throw new Error("simulated failure");
          },
        },
      },
    } as unknown as Parameters<typeof investigate>[1]["client"];

    await expect(
      investigate("test problem", { client: throwingClient, sessionId }),
    ).rejects.toThrow("simulated failure");

    expect(getInvestigationState(sessionId)).toBeUndefined();
  });

  test("investigate() without a sessionId behaves exactly as before — no registration, no error", async () => {
    const client = createStepFunctionClient(() => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }],
    }));

    const result = await investigate("test problem", { client });
    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/session/live-state.test.ts`
Expected: FAIL — `sessionId` isn't a recognized option yet, so `getInvestigationState(sessionId)`
never returns a defined snapshot mid-run (`sawHypothesisMidRun`/`sawStepNumberAdvance` stay
`false`), failing those two assertions.

- [ ] **Step 3: Write minimal implementation**

Replace `src/agent/investigate.ts` in full:

```ts
// FR-17's lifecycle entrypoint. Tool Runner drives the request/execute/loop
// cycle (see design doc "Architecture"); this file's job is composing the
// system prompt, tool set, and model, then interpreting the final
// InvestigationState into an InvestigationResult that never fabricates a
// conclusion (CLAUDE.md).
//
// FR-28 (module 06): an optional `sessionId` registers this run's live
// InvestigationState in src/session/registry.ts for the duration of the
// call, so a caller elsewhere can poll getInvestigationState(sessionId)
// while this is still running. Omitting sessionId is a no-op — behavior
// is identical to before module 06.
import Anthropic from "@anthropic-ai/sdk";
import { resolveModel } from "./model";
import { createInvestigationState, createTools } from "./tools";
import { registerSession, unregisterSession } from "../session/registry";
import type { InvestigationResult } from "./types";

const SYSTEM_PROMPT = `You are investigating a production incident for Tracely.
Follow this lifecycle: understand the problem, retrieve Company Brain context via
query_brain, form named hypotheses via propose_hypothesis, gather evidence with
search_code / query_brain / query_database / search_logs, and attach that evidence to
a hypothesis via update_hypothesis as either supporting or contradicting.

You never set a hypothesis's status or confidence directly — update_hypothesis's result
tells you the current status after our system recomputes it from accumulated evidence.
If a hypothesis becomes REFUTED, propose a new hypothesis from the evidence already
gathered rather than abandoning the investigation.

If you cannot gather enough evidence to confirm a hypothesis, say so plainly and stop —
do not guess or state a root cause you have not confirmed via update_hypothesis.`;

export interface InvestigateOptions {
  /** Injectable for tests — see tests/agent/helpers/mockAnthropicClient.ts. */
  client?: Anthropic;
  maxIterations?: number;
  /** Registers this run's live state for FR-28 polling via getInvestigationState. Omit for no registration. */
  sessionId?: string;
}

export async function investigate(
  problemDescription: string,
  options: InvestigateOptions = {},
): Promise<InvestigationResult> {
  const client = options.client ?? new Anthropic();
  const model = resolveModel();
  const state = createInvestigationState();
  const tools = createTools(state);

  if (options.sessionId) {
    registerSession(options.sessionId, state);
  }

  try {
    await client.beta.messages.toolRunner({
      model,
      max_tokens: 16000,
      max_iterations: options.maxIterations ?? 20,
      system: SYSTEM_PROMPT,
      tools,
      messages: [{ role: "user", content: problemDescription }],
    });

    const confirmed = state.hypotheses.find((h) => h.status === "CONFIRMED");
    if (confirmed) {
      return {
        outcome: "CONFIRMED",
        hypothesis: confirmed,
        rca: confirmed.statement,
        evidenceTrail: [...confirmed.supportingEvidence],
      };
    }

    return {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: state.hypotheses,
      reason:
        state.hypotheses.length === 0
          ? "no hypothesis was proposed"
          : "no hypothesis reached the confirmation threshold",
    };
  } finally {
    if (options.sessionId) {
      unregisterSession(options.sessionId);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session/live-state.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all prior tests (including `tests/agent/investigate.test.ts`'s existing 4 tests, which
pass no `sessionId` and must be completely unaffected) still pass, zero new failures, zero type
errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/investigate.ts tests/session/live-state.test.ts
git commit -m "Module 06 Task 3: wire sessionId into investigate() for FR-28 live state"
```

---

### Task 4: Documentation

**Files:**
- Create: `docs/human-collaboration.md`

**Interfaces:**
- Consumes: final shapes from Tasks 1-3 (`InvestigationState.stepNumber`, `src/session/*`,
  `InvestigateOptions.sessionId`). Purely descriptive — no code changes.
- Produces: nothing consumed by later tasks (last task in this plan).

- [ ] **Step 1: Write the doc**

Create `docs/human-collaboration.md`:

```markdown
# Human Collaboration — Live Investigation State (FR-28)

This documents module 06's FR-28 implementation: making an in-progress investigation's current
step and hypotheses observable while `investigate()` (module 03) is still running, instead of
only after it resolves. **FR-27 (mid-investigation hint injection) is explicitly deferred** — see
"FR-27: deferred" below.

Signatures below are copied from `src/session/registry.ts`, `src/session/types.ts`, and
`src/agent/investigate.ts` — keep this file in sync with those if the signatures change.

## Import

\`\`\`ts
import { getInvestigationState } from "../session"; // src/session/index.ts
\`\`\`

## Usage

\`\`\`ts
import { investigate } from "../agent/investigate";
import { getInvestigationState } from "../session";

const sessionId = crypto.randomUUID();

// Start the investigation without awaiting it yet, so it can be polled
// while running:
const resultPromise = investigate("Elevated error rate", { sessionId });

// Elsewhere (a separate request handler, a polling loop, etc.) — any code
// that has the sessionId can read the current state at any point before
// resultPromise resolves:
const snapshot = getInvestigationState(sessionId);
if (snapshot) {
  console.log(`step ${snapshot.stepNumber}, ${snapshot.hypotheses.length} hypotheses so far`);
}

const result = await resultPromise; // the authoritative final InvestigationResult
\`\`\`

## `getInvestigationState`

\`\`\`ts
function getInvestigationState(sessionId: string): LiveInvestigationState | undefined;

interface LiveInvestigationState {
  sessionId: string;
  status: "IN_PROGRESS";
  stepNumber: number;
  hypotheses: readonly Hypothesis[];
}
\`\`\`

- Returns `undefined` if `sessionId` was never registered, **or** if the investigation it belonged
  to has already completed. These two cases are intentionally indistinguishable here — once you
  have a session's final answer (the `InvestigationResult` your `investigate()` call resolved
  with), the registry no longer has anything useful to add. `undefined` means "stop polling this
  id and use the result you're awaiting instead," not an error you need to handle specially.
- Every call returns a **fresh, defensive snapshot copy** — `hypotheses` is a new array on every
  call, not a live reference into the investigation's real internal state. Mutating a returned
  snapshot has no effect on the running investigation.
- `stepNumber` increments by exactly 1 each time any tool executes (`query_brain`, `search_code`,
  `query_database`, `search_logs`, `propose_hypothesis`, or `update_hypothesis`) — a coarse but
  real, non-fabricated progress indicator (`src/agent/tools.ts`'s `withStep` wrapper).

## Registering a session

\`\`\`ts
investigate(problemDescription, { sessionId: "some-id", ...otherOptions });
\`\`\`

- The **caller** generates and owns the `sessionId` (e.g. `crypto.randomUUID()`, or an id tied to
  an existing incident ticket) — `investigate()` never generates one itself. This is what lets a
  caller have the id in hand *before* `investigate()` resolves, so it has something to poll with.
- Passing no `sessionId` is a complete no-op for this feature: no registration happens, and
  `investigate()`'s behavior, return value, and performance are identical to module 03's original
  implementation. Every existing caller is unaffected.
- Registering the same `sessionId` twice (e.g. a bug that reuses an id, or two investigations
  racing on one id) throws immediately from `registerSession` — this is deliberate: silently
  letting two investigations share one registry slot would produce a snapshot that's a
  cross-talked mix of both, which is worse than a loud failure.
- The registry entry is always removed when `investigate()` finishes — success or throw — via a
  `finally` block. There is no persistence beyond the process's lifetime; this is in-memory only.

## FR-27: deferred

FR-27 (an engineer injecting a hint like "I think the config changed yesterday" mid-investigation,
with the agent incorporating it as evidence attributed to the human) is a SHOULD requirement the
spec explicitly allows deferring rather than blocking later modules. It needs a way to get a new
message into the Anthropic tool-runner's request/execute loop *while that loop is already
running* — there's no documented hook for that today, and designing one (e.g. a pending-hints
queue a tool surfaces to the model on its next turn) is a genuinely open question, not a
side-effect of the state-visibility work here. See
`docs/superpowers/specs/2026-08-23-module-06-human-collaboration-design.md` for the full
rationale. This module's session registry gives a future FR-27 implementation a foundation
(a registered per-investigation session) to build on.
\`\`\`

- [ ] **Step 2: Self-check against the actual code**

Re-open `src/session/registry.ts`, `src/session/types.ts`, and `src/agent/investigate.ts` as they
exist after Task 3 and confirm every signature, field name, and behavior claim in the doc above
matches exactly (field names, the `finally`-based cleanup, the double-registration throw, the
`undefined`-means-both-cases behavior). Fix any drift inline.

- [ ] **Step 3: Commit**

```bash
git add docs/human-collaboration.md
git commit -m "Module 06 Task 4: document FR-28 live investigation state, FR-27 deferral"
```

---

## Final whole-branch check (after all 4 tasks)

- [ ] Run `bun test && bunx tsc --noEmit` once more from a clean state — confirm the only failures
      are the same 8 pre-existing live-GitHub-API tests, zero type errors.
- [ ] Push the branch and open a PR, per this repo's `CLAUDE.md` definition-of-done.
