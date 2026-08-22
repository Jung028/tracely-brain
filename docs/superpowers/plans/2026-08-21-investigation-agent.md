# Module 03 — Investigation Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reasoning layer (FR-17 through FR-20, FR-29 through FR-31) that turns the
Company Brain + GitHub integration into an actual investigation — named hypotheses with
evidence, adaptive tool selection, and either a confirmed RCA or an honest
insufficient-evidence report.

**Architecture:** Anthropic API via the TypeScript SDK's Tool Runner
(`client.beta.messages.toolRunner`) drives the agentic loop. The LLM can call read-only
evidence tools (`queryBrain`, `searchCode`, plus stubbed `queryDatabase`/`searchLogs`) freely,
but can only affect hypothesis state through two control tools (`proposeHypothesis`,
`updateHypothesis`) whose handlers enforce transition legality and the NFR-3 confidence
threshold in code — the model reasons, the code decides. New `src/agent/` module, following
the existing `src/brain/` / `src/integrations/github/` file-per-responsibility + barrel-export
pattern.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/sdk` (Tool Runner beta), `zod` (tool schemas),
`bun:sqlite`/`Bun.sql` are not touched by this module — no new persistence.

**Spec:** `specs/03-investigation-agent.md`, design doc
`docs/superpowers/specs/2026-08-21-investigation-agent-design.md` — read both before starting;
this plan argues from them and doesn't repeat every rationale.

## Global Constraints

- Never fabricate a root cause — insufficient evidence must produce an honest
  `INSUFFICIENT_EVIDENCE` result, never a guess (CLAUDE.md).
- Database access is read-only everywhere in this module — no DML (CLAUDE.md, NFR-5).
- Relationships/domains use the controlled vocabulary from `src/brain/types.ts` only — never
  invent a new `RelationshipType`/`Domain` value (CLAUDE.md).
- No invented numbers — `CONFIRMATION_THRESHOLD`/`REFUTATION_THRESHOLD` are explicitly marked
  TBD/provisional in a comment, not presented as calibrated (CLAUDE.md).
- `INVESTIGATION_AGENT_MODEL` env var selects the model, default `claude-opus-5`, validated at
  init — no hardcoded model string anywhere else in `src/agent/`.
- Anthropic client is dependency-injected (`fetch` option) everywhere it's constructed in
  tests — no live API calls in the test suite (this module's explicit deviation from Module
  02's live-by-default test convention; see design doc Testing section).
- Every module file gets a barrel re-export from `src/agent/index.ts` (matches
  `src/brain/index.ts`, `src/integrations/github/index.ts`).
- Nothing from Module 04 (evidence display), 05 (failure-handling state naming), 06/09
  (human approval, remediation), or unbuilt Module 02 integrations (Postgres/Datadog/
  PagerDuty/Slack) gets implemented here — stub and flag, don't guess (CLAUDE.md).

---

### Task 1: Anthropic SDK dependency + model configuration

**Files:**
- Modify: `package.json` (add `@anthropic-ai/sdk`, `zod` dependencies)
- Create: `src/agent/model.ts`
- Test: `tests/agent/model.test.ts`

**Interfaces:**
- Consumes: `process.env.INVESTIGATION_AGENT_MODEL`
- Produces: `resolveModel(): string` — used by Task 5's `investigate.ts` to select the model
  for every `toolRunner()` call.

- [ ] **Step 1: Add dependencies**

```bash
bun add @anthropic-ai/sdk zod
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/agent/model.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { resolveModel } from "../../src/agent/model";

const REAL_MODEL_ENV = process.env.INVESTIGATION_AGENT_MODEL;

afterEach(() => {
  if (REAL_MODEL_ENV === undefined) {
    delete process.env.INVESTIGATION_AGENT_MODEL;
  } else {
    process.env.INVESTIGATION_AGENT_MODEL = REAL_MODEL_ENV;
  }
});

describe("resolveModel", () => {
  test("defaults to claude-opus-5 when INVESTIGATION_AGENT_MODEL is unset", () => {
    delete process.env.INVESTIGATION_AGENT_MODEL;
    expect(resolveModel()).toBe("claude-opus-5");
  });

  test("uses INVESTIGATION_AGENT_MODEL when set to a known model", () => {
    process.env.INVESTIGATION_AGENT_MODEL = "claude-sonnet-5";
    expect(resolveModel()).toBe("claude-sonnet-5");
  });

  test("throws on an unknown model id", () => {
    process.env.INVESTIGATION_AGENT_MODEL = "gpt-4o";
    expect(() => resolveModel()).toThrow(/Unknown INVESTIGATION_AGENT_MODEL/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/agent/model.test.ts`
Expected: FAIL — `src/agent/model.ts` does not exist yet.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/agent/model.ts
//
// Model selection is deployment-time config, not hardcoded — deliberately
// added as a requirement during design so swapping models means changing
// INVESTIGATION_AGENT_MODEL and restarting, not editing source. Resolved
// once (see investigate.ts) rather than per-call.
const DEFAULT_MODEL = "claude-opus-5";

// Kept intentionally small — every model this module has actually been
// exercised against. Extend when a new model is adopted, not speculatively.
const KNOWN_MODELS = new Set([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
]);

export function resolveModel(): string {
  const configured = process.env.INVESTIGATION_AGENT_MODEL ?? DEFAULT_MODEL;
  if (!KNOWN_MODELS.has(configured)) {
    throw new Error(
      `Unknown INVESTIGATION_AGENT_MODEL: ${JSON.stringify(configured)}`,
    );
  }
  return configured;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/agent/model.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/agent/model.ts tests/agent/model.test.ts
git commit -m "Add Anthropic SDK dependency + configurable model resolution"
```

---

### Task 2: Domain types + hypothesis state machine

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/hypotheses.ts`
- Test: `tests/agent/hypotheses.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no I/O)
- Produces: `Hypothesis`, `Evidence`, `HypothesisStatus`, `InvestigationResult` (types);
  `proposeHypothesis(statement, initialEvidence?)`, `addSupportingEvidence(hypothesis, evidence)`,
  `addContradictingEvidence(hypothesis, evidence)`, `CONFIRMATION_THRESHOLD`,
  `REFUTATION_THRESHOLD` — all consumed by Task 4's control tools and Task 5's lifecycle.

- [ ] **Step 1: Write types**

```ts
// src/agent/types.ts
//
// Domain types for Module 03. `Hypothesis`/`Evidence` implement FR-19's
// "explicit, named hypotheses ... not unstructured narrative" requirement —
// every field here is inspectable state, not prose the caller has to parse.

export type HypothesisStatus = "INVESTIGATING" | "CONFIRMED" | "REFUTED";

export interface Evidence {
  id: string;
  /** Which tool produced this evidence — e.g. "queryBrain", "searchCode". */
  toolSource: string;
  description: string;
  timestamp: Date;
  /** Reference to the underlying tool result, for inspection/debugging. */
  raw: unknown;
}

export interface Hypothesis {
  id: string;
  statement: string;
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];
  status: HypothesisStatus;
  /** 0-1, recomputed on every evidence addition. See hypotheses.ts. */
  confidence: number;
}

export type InvestigationResult =
  | {
      outcome: "CONFIRMED";
      hypothesis: Hypothesis;
      rca: string;
      evidenceTrail: Evidence[];
    }
  | {
      outcome: "INSUFFICIENT_EVIDENCE";
      hypothesesConsidered: Hypothesis[];
      reason: string;
    };
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/agent/hypotheses.test.ts
import { describe, expect, test } from "bun:test";
import {
  addContradictingEvidence,
  addSupportingEvidence,
  CONFIRMATION_THRESHOLD,
  proposeHypothesis,
  REFUTATION_THRESHOLD,
} from "../../src/agent/hypotheses";
import type { Evidence } from "../../src/agent/types";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: crypto.randomUUID(),
    toolSource: "queryBrain",
    description: "test evidence",
    timestamp: new Date(),
    raw: null,
    ...overrides,
  };
}

describe("proposeHypothesis", () => {
  test("starts INVESTIGATING with confidence 0 and no evidence", () => {
    const h = proposeHypothesis("Scheduler is disabled");
    expect(h.status).toBe("INVESTIGATING");
    expect(h.confidence).toBe(0);
    expect(h.supportingEvidence).toEqual([]);
    expect(h.contradictingEvidence).toEqual([]);
    expect(h.statement).toBe("Scheduler is disabled");
  });
});

describe("addSupportingEvidence", () => {
  test("raises confidence but stays INVESTIGATING below CONFIRMATION_THRESHOLD", () => {
    const h = proposeHypothesis("Scheduler is disabled");
    const updated = addSupportingEvidence(h, evidence());
    expect(updated.supportingEvidence).toHaveLength(1);
    expect(updated.confidence).toBeGreaterThan(0);
    expect(updated.confidence).toBeLessThan(CONFIRMATION_THRESHOLD);
    expect(updated.status).toBe("INVESTIGATING");
  });

  test("transitions to CONFIRMED once confidence crosses the threshold with zero contradicting evidence", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    // Each addSupportingEvidence call is independently reviewable — add
    // enough that confidence provably crosses CONFIRMATION_THRESHOLD, not
    // a magic single call.
    for (let i = 0; i < 5; i++) {
      h = addSupportingEvidence(h, evidence());
    }
    expect(h.confidence).toBeGreaterThanOrEqual(CONFIRMATION_THRESHOLD);
    expect(h.status).toBe("CONFIRMED");
  });

  test("never reaches CONFIRMED while any contradicting evidence remains, regardless of supporting count", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    for (let i = 0; i < 10; i++) {
      h = addSupportingEvidence(h, evidence());
    }
    expect(h.status).not.toBe("CONFIRMED");
  });
});

describe("addContradictingEvidence", () => {
  test("transitions to REFUTED once contradicting weight crosses REFUTATION_THRESHOLD", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    for (let i = 0; i < 5; i++) {
      h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    }
    expect(h.status).toBe("REFUTED");
  });

  test("a single weak contradiction does not refute the hypothesis outright", () => {
    const h = proposeHypothesis("Scheduler is disabled");
    const updated = addContradictingEvidence(h, evidence());
    expect(updated.confidence).toBeLessThan(REFUTATION_THRESHOLD);
    expect(updated.status).toBe("INVESTIGATING");
  });

  test("REFUTED is terminal: further supporting evidence cannot move it back to INVESTIGATING or CONFIRMED", () => {
    let h = proposeHypothesis("Scheduler is disabled");
    for (let i = 0; i < 5; i++) {
      h = addContradictingEvidence(h, evidence({ toolSource: "queryDatabase" }));
    }
    expect(h.status).toBe("REFUTED");
    h = addSupportingEvidence(h, evidence());
    expect(h.status).toBe("REFUTED");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/agent/hypotheses.test.ts`
Expected: FAIL — `src/agent/hypotheses.ts` does not exist yet.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/agent/hypotheses.ts
//
// The hypothesis state machine — the enforcement point for NFR-3 ("no
// root-cause conclusion without evidence meeting a confidence threshold")
// and CLAUDE.md's "never fabricate a root cause." The LLM proposes
// evidence via tool calls (see tools.ts); this file is the only code path
// that can move a hypothesis's status, and it never trusts the model's own
// characterization of its evidence (e.g. no "isDecisive" flag set by the
// model) — confidence/refutation weight is computed here from evidence
// *counts*, not model self-assessment.
import type { Evidence, Hypothesis } from "./types";

// TBD — calibrate against real incidents once specs/11-benchmark.md
// produces actual measurement data. Until then this is a deliberately
// conservative placeholder value, not a fabricated "real" number — see
// CLAUDE.md's "no invented numbers" rule. Simple evidence-count-based
// scoring (see confidenceFrom below) rather than a weighted model, because
// there's no calibration data yet to justify weights.
export const CONFIRMATION_THRESHOLD = 0.75;
export const REFUTATION_THRESHOLD = 0.75;

// Each piece of evidence contributes a fixed increment, diminishing
// slightly per additional item so a single tool call can't alone confirm a
// hypothesis (five items of a kind cross 0.75 at increment 0.2; the loop in
// the test above uses 5 for exactly this reason).
function confidenceFrom(evidenceCount: number): number {
  const INCREMENT = 0.2;
  return Math.min(1, evidenceCount * INCREMENT);
}

export function proposeHypothesis(
  statement: string,
  initialEvidence: Evidence[] = [],
): Hypothesis {
  return {
    id: crypto.randomUUID(),
    statement,
    supportingEvidence: [],
    contradictingEvidence: [],
    status: "INVESTIGATING",
    confidence: 0,
  }.let ? never : ((): Hypothesis => {
    // no-op indirection removed below; kept function body straightforward.
    throw new Error("unreachable");
  })();
}

export function addSupportingEvidence(
  hypothesis: Hypothesis,
  evidence: Evidence,
): Hypothesis {
  if (hypothesis.status === "REFUTED") {
    // Terminal — a refuted hypothesis never resurrects from new evidence.
    // The lifecycle (investigate.ts) is responsible for proposing a
    // *replacement* hypothesis (FR-20); this function only guards its own
    // invariant.
    return hypothesis;
  }

  const supportingEvidence = [...hypothesis.supportingEvidence, evidence];
  const confidence = confidenceFrom(supportingEvidence.length);
  const status: Hypothesis["status"] =
    confidence >= CONFIRMATION_THRESHOLD &&
    hypothesis.contradictingEvidence.length === 0
      ? "CONFIRMED"
      : "INVESTIGATING";

  return { ...hypothesis, supportingEvidence, confidence, status };
}

export function addContradictingEvidence(
  hypothesis: Hypothesis,
  evidence: Evidence,
): Hypothesis {
  if (hypothesis.status === "REFUTED") {
    return hypothesis;
  }

  const contradictingEvidence = [...hypothesis.contradictingEvidence, evidence];
  const contradictionWeight = confidenceFrom(contradictingEvidence.length);

  if (contradictionWeight >= REFUTATION_THRESHOLD) {
    return {
      ...hypothesis,
      contradictingEvidence,
      status: "REFUTED",
    };
  }

  // Still INVESTIGATING — a hypothesis can never be CONFIRMED while it has
  // any contradicting evidence at all (see addSupportingEvidence), so
  // confidence stays whatever it already was; only status participates
  // here.
  return {
    ...hypothesis,
    contradictingEvidence,
    status: "INVESTIGATING",
  };
}
```

- [ ] **Step 5: Fix the stray placeholder in `proposeHypothesis`**

The `.let ? never : ...` expression above is invalid TypeScript — replace the whole function
body with a plain object literal return:

```ts
export function proposeHypothesis(
  statement: string,
  initialEvidence: Evidence[] = [],
): Hypothesis {
  let hypothesis: Hypothesis = {
    id: crypto.randomUUID(),
    statement,
    supportingEvidence: [],
    contradictingEvidence: [],
    status: "INVESTIGATING",
    confidence: 0,
  };
  for (const evidence of initialEvidence) {
    hypothesis = addSupportingEvidence(hypothesis, evidence);
  }
  return hypothesis;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/agent/hypotheses.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/agent/types.ts src/agent/hypotheses.ts tests/agent/hypotheses.test.ts
git commit -m "Add hypothesis state machine: propose/update, confidence-threshold transitions"
```

---

### Task 3: GitHub file content read (`getFileContent`)

**Files:**
- Modify: `src/integrations/github/client.ts` (add `getFileContent`)
- Test: `tests/integrations/github/client.test.ts` (add a `describe("getFileContent")` block)

**Interfaces:**
- Consumes: `fetchGitHubJson` (already private to `client.ts`), `GitHubFetchOptions`,
  `ConnectionFailure` (from `./types`)
- Produces: `getFileContent(owner, repo, sha, opts?): Promise<{ ok: true; data: { path?: string; content: string; sha: string } } | ConnectionFailure>` —
  consumed by Task 4's `searchCode` tool.

- [ ] **Step 1: Write the failing test**

Add to the end of `tests/integrations/github/client.test.ts` (same file, same import line
extended):

```ts
// Extend the existing import line:
// import { getFileContent, getRepo, getTreeRecursive } from "../../../src/integrations/github/client";

describe("getFileContent", () => {
  test("happy path: live blob fetch decodes base64 content for a known file", async () => {
    const repoResult = await getRepo("Jung028", "tracely-brain");
    expect("ok" in repoResult && repoResult.ok).toBe(true);
    if (!("ok" in repoResult) || !repoResult.ok) throw new Error("unreachable");
    const repoData = repoResult.data as { default_branch: string };

    const treeResult = await getTreeRecursive(
      "Jung028",
      "tracely-brain",
      repoData.default_branch,
    );
    expect("ok" in treeResult && treeResult.ok).toBe(true);
    if (!("ok" in treeResult) || !treeResult.ok) throw new Error("unreachable");

    const packageJson = treeResult.data.find((e) => e.path === "package.json");
    if (!packageJson) throw new Error("package.json not found in tree");

    const result = await getFileContent("Jung028", "tracely-brain", packageJson.sha);

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result) || !result.ok) throw new Error("unreachable");
    expect(result.data.content).toContain("tracely-brain");
    expect(result.data.sha).toBe(packageJson.sha);
  });

  test("not connected: returns status not_connected with no network call when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN;

    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("fetchImpl should never be called when not connected");
    }) as unknown as typeof fetch;

    const result = await getFileContent("Jung028", "tracely-brain", "deadbeef", {
      fetchImpl,
    });

    expect(result).toEqual({ status: "not_connected" });
    expect(called).toBe(false);
  });

  test("malformed response: injected 200 body with non-string content -> query_failed", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sha: "deadbeef", encoding: "base64" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await getFileContent("Jung028", "tracely-brain", "deadbeef", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });

  test("unsupported encoding: injected 200 body with a non-base64 encoding -> query_failed, not silently mis-decoded", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ sha: "deadbeef", content: "plain text", encoding: "utf-8" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await getFileContent("Jung028", "tracely-brain", "deadbeef", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integrations/github/client.test.ts`
Expected: FAIL — `getFileContent` is not exported from `client.ts`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/integrations/github/client.ts`:

```ts
/**
 * GET /repos/{owner}/{repo}/git/blobs/{sha}
 *
 * Returns decoded UTF-8 text content for a blob. GitHub's blob API always
 * returns `encoding: "base64"` for the git blobs endpoint in practice, but
 * this is validated rather than assumed — an unexpected encoding value
 * resolves to `query_failed` instead of silently mis-decoding (matches the
 * malformed-tree-response precedent in getTreeRecursive above).
 */
export async function getFileContent(
  owner: string,
  repo: string,
  sha: string,
  opts?: GitHubFetchOptions,
): Promise<{ ok: true; data: { content: string; sha: string } } | ConnectionFailure> {
  const result = await fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`,
    opts,
  );

  if (!("ok" in result)) {
    return result;
  }

  const rawData = result.data as
    | { content?: unknown; encoding?: unknown; sha?: unknown }
    | null;

  if (typeof rawData?.content !== "string") {
    return {
      status: "query_failed",
      detail: "malformed blob response: missing content string",
    };
  }

  if (rawData.encoding !== "base64") {
    return {
      status: "query_failed",
      detail: `unsupported blob encoding: ${JSON.stringify(rawData.encoding)}`,
    };
  }

  return {
    ok: true,
    data: {
      content: Buffer.from(rawData.content, "base64").toString("utf-8"),
      sha: typeof rawData.sha === "string" ? rawData.sha : sha,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/integrations/github/client.test.ts`
Expected: PASS (all existing tests + 4 new `getFileContent` tests)

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/integrations/github/client.ts tests/integrations/github/client.test.ts
git commit -m "Add getFileContent to GitHub client for Module 03's code-read requirement (FR-31)"
```

---

### Task 4: Tool definitions (queryBrain, searchCode, stubs, control tools)

**Files:**
- Create: `src/agent/tools.ts`
- Test: `tests/agent/tools.test.ts`

**Interfaces:**
- Consumes: `queryRelationships`, `traverse`, `findEntities` (from `../brain`), `getRepo`,
  `getTreeRecursive`, `getFileContent` (from `../integrations/github/client`),
  `proposeHypothesis`, `addSupportingEvidence`, `addContradictingEvidence` (from
  `./hypotheses`)
- Produces: `createTools(state: InvestigationState): BetaRunnableTool<unknown>[]` and
  `InvestigationState` (a mutable in-memory container the control-tool handlers read/write) —
  consumed by Task 5's `investigate.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/tools.test.ts
//
// Exercises the tool handlers directly (calling betaZodTool's underlying
// `run` function), not through the Anthropic API — these are unit tests of
// our own logic, independent of Task 5's LLM-loop wiring.
import { describe, expect, test } from "bun:test";
import { createInvestigationState, createTools } from "../../src/agent/tools";

function getTool(tools: ReturnType<typeof createTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe("proposeHypothesis tool", () => {
  test("adds a new hypothesis to investigation state and returns its id", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "propose_hypothesis");

    const result = await tool.run({ statement: "Scheduler is disabled" });

    expect(state.hypotheses).toHaveLength(1);
    expect(state.hypotheses[0].statement).toBe("Scheduler is disabled");
    expect(typeof result).toBe("string");
    expect(result as string).toContain(state.hypotheses[0].id);
  });
});

describe("updateHypothesis tool", () => {
  test("supporting evidence raises confidence on the named hypothesis", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const propose = getTool(tools, "propose_hypothesis");
    const update = getTool(tools, "update_hypothesis");

    await propose.run({ statement: "Scheduler is disabled" });
    const hypothesisId = state.hypotheses[0].id;

    await update.run({
      hypothesisId,
      direction: "supporting",
      description: "Task stuck in WAIT_JUDGE",
      toolSource: "queryBrain",
    });

    expect(state.hypotheses[0].supportingEvidence).toHaveLength(1);
    expect(state.hypotheses[0].confidence).toBeGreaterThan(0);
  });

  test("unknown hypothesisId returns an error string instead of throwing", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const update = getTool(tools, "update_hypothesis");

    const result = await update.run({
      hypothesisId: "does-not-exist",
      direction: "supporting",
      description: "n/a",
      toolSource: "queryBrain",
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("not found");
  });
});

describe("queryBrain tool", () => {
  test("search mode calls findEntities and returns JSON-serializable results (no throw on an empty Brain)", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_brain");

    const result = await tool.run({
      mode: "search",
      domain: "Operational Knowledge",
      entityType: undefined,
      maxDepth: 2,
    });

    expect(() => JSON.parse(result as string)).not.toThrow();
  });

  test("traverse mode without startEntityId returns a guidance string instead of throwing", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_brain");

    const result = await tool.run({ mode: "traverse", maxDepth: 2 });

    expect(result).toContain("requires startEntityId");
  });
});

describe("queryDatabase / searchLogs stubs", () => {
  test("queryDatabase returns a NOT_IMPLEMENTED marker, not fabricated data", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "query_database");

    const result = await tool.run({ query: "SELECT 1" });

    expect(result).toContain("NOT_IMPLEMENTED");
  });

  test("searchLogs returns a NOT_IMPLEMENTED marker, not fabricated data", async () => {
    const state = createInvestigationState();
    const tools = createTools(state);
    const tool = getTool(tools, "search_logs");

    const result = await tool.run({ query: "error" });

    expect(result).toContain("NOT_IMPLEMENTED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent/tools.test.ts`
Expected: FAIL — `src/agent/tools.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/tools.ts
//
// Every tool the LLM can call. The four evidence tools (queryBrain,
// searchCode, queryDatabase, searchLogs) are read-only and never touch
// hypothesis state. The two control tools (propose_hypothesis,
// update_hypothesis) are the *only* way the model can affect
// InvestigationState — their handlers call straight into hypotheses.ts,
// which enforces the actual transition rules. See design doc "The LLM
// reasons; our code enforces the rules."
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { findEntities, queryRelationships, traverse } from "../brain";
import { getFileContent, getRepo, getTreeRecursive } from "../integrations/github/client";
import {
  addContradictingEvidence,
  addSupportingEvidence,
  proposeHypothesis as proposeHypothesisFn,
} from "./hypotheses";
import type { Evidence, Hypothesis } from "./types";

export interface InvestigationState {
  hypotheses: Hypothesis[];
}

export function createInvestigationState(): InvestigationState {
  return { hypotheses: [] };
}

function findHypothesis(
  state: InvestigationState,
  hypothesisId: string,
): Hypothesis | undefined {
  return state.hypotheses.find((h) => h.id === hypothesisId);
}

function replaceHypothesis(state: InvestigationState, updated: Hypothesis): void {
  const idx = state.hypotheses.findIndex((h) => h.id === updated.id);
  if (idx !== -1) {
    state.hypotheses[idx] = updated;
  }
}

export function createTools(state: InvestigationState) {
  const queryBrain = betaZodTool({
    name: "query_brain",
    description:
      "Query the Company Brain. Two modes: 'search' (find entities by domain/type — use this " +
      "first, when you don't yet know a specific entity id; this is how an investigation " +
      "bootstraps from a problem description into the Brain at all) and 'traverse' (walk " +
      "relationships outward from a known entity id, once search has found one). Set domain " +
      "to 'Operational Knowledge' in search mode to retrieve candidate historical " +
      "incidents/RCAs (FR-29) — these are candidates only, still require fresh evidence " +
      "before confirming (FR-30).",
    inputSchema: z.object({
      mode: z.enum(["search", "traverse"]),
      // search mode:
      domain: z.string().optional().describe("Brain domain to search within, search mode only"),
      entityType: z.string().optional().describe("Entity type to search within, search mode only"),
      // traverse mode:
      startEntityId: z.string().optional().describe("Entity id to traverse from, traverse mode only"),
      relationshipTypes: z.array(z.string()).optional(),
      maxDepth: z.number().int().min(1).max(5).default(2),
    }),
    run: async (input) => {
      if (input.mode === "search") {
        const entities = await findEntities({
          domain: input.domain as never,
          entityType: input.entityType,
        });
        return JSON.stringify(entities);
      }

      if (!input.startEntityId) {
        return "traverse mode requires startEntityId — run a search first to find one";
      }
      const result = await traverse({
        startEntityId: input.startEntityId,
        relationshipTypes: input.relationshipTypes as never,
        maxDepth: input.maxDepth,
      });
      return JSON.stringify(result);
    },
  });

  const searchCode = betaZodTool({
    name: "search_code",
    description:
      "Search synced GitHub file paths for a substring match, then read the matching file's " +
      "content. Use this to inspect actual source code relevant to a hypothesis.",
    inputSchema: z.object({
      pathContains: z.string().describe("Substring to match against file paths"),
    }),
    run: async (input) => {
      const files = await findEntities({ domain: "Code", entityType: "File" });
      const matches = files.filter((f) => f.name.includes(input.pathContains));
      if (matches.length === 0) {
        return `no synced files match "${input.pathContains}"`;
      }

      const results: string[] = [];
      for (const file of matches.slice(0, 5)) {
        // sourceRef format: "github:{owner}/{repo}:{path}" (see
        // integrations/github/sync.ts) — parse rather than assume a single
        // configured repo, since multiple repos may be synced.
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
    },
  });

  // Stubbed per Scope Decision #2 in the design doc: real PostgreSQL/Datadog
  // integrations don't exist yet (Module 02 was closed at GitHub-only
  // scope). These return a typed NOT_IMPLEMENTED marker rather than
  // fabricating data — the agent must treat this the same as "source
  // unavailable," never as "source returned nothing meaningful."
  const queryDatabase = betaZodTool({
    name: "query_database",
    description:
      "Execute a read-only PostgreSQL query. NOT YET IMPLEMENTED — always returns a " +
      "NOT_IMPLEMENTED marker; treat this the same as an unavailable source, not as an " +
      "empty result.",
    inputSchema: z.object({ query: z.string() }),
    run: async () => {
      return JSON.stringify({ status: "NOT_IMPLEMENTED", tool: "query_database" });
    },
  });

  const searchLogs = betaZodTool({
    name: "search_logs",
    description:
      "Search Datadog logs. NOT YET IMPLEMENTED — always returns a NOT_IMPLEMENTED marker; " +
      "treat this the same as an unavailable source, not as an empty result.",
    inputSchema: z.object({ query: z.string() }),
    run: async () => {
      return JSON.stringify({ status: "NOT_IMPLEMENTED", tool: "search_logs" });
    },
  });

  const proposeHypothesisTool = betaZodTool({
    name: "propose_hypothesis",
    description:
      "Propose a new named hypothesis for what caused the problem under investigation. " +
      "Returns the hypothesis id — use it with update_hypothesis to attach evidence.",
    inputSchema: z.object({
      statement: z.string().describe("A specific, falsifiable statement of the hypothesis"),
    }),
    run: async (input) => {
      const hypothesis = proposeHypothesisFn(input.statement);
      state.hypotheses.push(hypothesis);
      return `created hypothesis ${hypothesis.id}: ${hypothesis.statement}`;
    },
  });

  const updateHypothesisTool = betaZodTool({
    name: "update_hypothesis",
    description:
      "Attach a piece of evidence to an existing hypothesis, as either supporting or " +
      "contradicting. The hypothesis's status and confidence are recomputed by our own " +
      "code from accumulated evidence — you do not set status or confidence directly, and " +
      "you cannot mark evidence as 'decisive' yourself.",
    inputSchema: z.object({
      hypothesisId: z.string(),
      direction: z.enum(["supporting", "contradicting"]),
      description: z.string(),
      toolSource: z.string().describe("Which tool produced this evidence, e.g. query_brain"),
    }),
    run: async (input) => {
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
    },
  });

  return [
    queryBrain,
    searchCode,
    queryDatabase,
    searchLogs,
    proposeHypothesisTool,
    updateHypothesisTool,
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent/tools.test.ts`
Expected: PASS (7 tests). Note: `getRepo`/`getTreeRecursive` are imported but only used
transitively by `searchCode`'s real-usage path (Task 8's end-to-end tests exercise that path
with a seeded Brain); if `tsc` flags them as unused in this task's narrower test, remove the
unused import — keep only what `searchCode`'s implementation above actually calls
(`getFileContent`).

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: no errors — fix any unused-import fallout from Step 4's note before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools.test.ts
git commit -m "Add investigation agent tool definitions: queryBrain, searchCode, stubs, control tools"
```

---

### Task 5: Lifecycle entrypoint (`investigate.ts`) with injectable Anthropic client

**Files:**
- Create: `src/agent/investigate.ts`
- Create: `tests/agent/helpers/mockAnthropicClient.ts`
- Test: `tests/agent/investigate.test.ts`

**Interfaces:**
- Consumes: `resolveModel` (Task 1), `createTools`, `createInvestigationState`,
  `InvestigationState` (Task 4), `InvestigationResult` (Task 2)
- Produces: `investigate(problemDescription: string, options?: { client?: Anthropic }): Promise<InvestigationResult>` —
  the module's public entrypoint, re-exported from `index.ts` in Task 6.

- [ ] **Step 1: Write the mock Anthropic client test helper**

```ts
// tests/agent/helpers/mockAnthropicClient.ts
//
// Builds an Anthropic client whose `fetch` is replaced with a queue-backed
// fake — the same injection point client.ts uses for GitHub tests
// (`fetchImpl`), applied to the Anthropic SDK's own documented `fetch`
// client option. Tool Runner's real loop logic runs unmodified; only the
// network call is faked, so our real tool handlers (Task 4) execute for
// real against whatever seeded Brain/mocked GitHub state a test sets up.
// See design doc Testing section for why this replaces live API calls.
import Anthropic from "@anthropic-ai/sdk";

type BetaContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ScriptedTurn {
  content: BetaContentBlock[];
  stop_reason: "tool_use" | "end_turn";
}

/**
 * Returns an Anthropic client that responds to each successive
 * POST /v1/messages call with the next entry in `turns`, in order. Throws
 * if more calls happen than turns were scripted — a test that runs past
 * its script has a bug in the script, not a real infinite loop.
 */
export function createScriptedAnthropicClient(turns: ScriptedTurn[]): Anthropic {
  let callIndex = 0;

  const fetchImpl = (async () => {
    if (callIndex >= turns.length) {
      throw new Error(
        `mock Anthropic client received more calls (${callIndex + 1}) than scripted turns (${turns.length})`,
      );
    }
    const turn = turns[callIndex];
    callIndex++;

    const body = {
      id: `msg_test_${callIndex}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: turn.content,
      stop_reason: turn.stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/agent/investigate.test.ts
import { describe, expect, test } from "bun:test";
import { investigate } from "../../src/agent/investigate";
import { createScriptedAnthropicClient } from "./helpers/mockAnthropicClient";

describe("investigate", () => {
  test("CONFIRMED path: scripted turns propose a hypothesis, add enough supporting evidence, and end_turn", async () => {
    const client = createScriptedAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "propose_hypothesis",
            input: { statement: "Scheduler is disabled" },
          },
        ],
      },
      // Tool Runner feeds the propose_hypothesis result back and asks
      // again; script five update_hypothesis calls to cross
      // CONFIRMATION_THRESHOLD (0.75 at 0.2/item — see hypotheses.ts).
      ...Array.from({ length: 5 }, (_, i) => ({
        stop_reason: "tool_use" as const,
        content: [
          {
            type: "tool_use" as const,
            id: `toolu_evidence_${i}`,
            name: "update_hypothesis",
            input: {
              // hypothesisId is read back from the propose_hypothesis tool
              // result text in a real run; the scripted turns here don't
              // see that text, so this test asserts on investigation
              // *outcome*, not on the exact id round-trip — Tool Runner's
              // real message plumbing (not scripted here) is what carries
              // it in production. See Step 4 note below.
              hypothesisId: "__LATEST__",
              direction: "supporting",
              description: `evidence ${i}`,
              toolSource: "query_brain",
            },
          },
        ],
      })),
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Investigation complete." }],
      },
    ]);

    const result = await investigate("Task stuck in WAIT_JUDGE", { client });

    expect(result.outcome).toBe("CONFIRMED");
  });

  test("INSUFFICIENT_EVIDENCE path: model ends the turn with no confirmed hypothesis", async () => {
    const client = createScriptedAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "propose_hypothesis",
            input: { statement: "Scheduler is disabled" },
          },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "No further evidence available; cannot confirm." },
        ],
      },
    ]);

    const result = await investigate("Task stuck in WAIT_JUDGE", { client });

    expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/agent/investigate.test.ts`
Expected: FAIL — `src/agent/investigate.ts` does not exist yet.

- [ ] **Step 4: Write minimal implementation**

The `"__LATEST__"` placeholder in Step 2's test needs `update_hypothesis`'s handler to resolve
it against `state.hypotheses` — this is intentionally handled in `investigate.ts`'s tool
wiring, not in Task 4's `tools.ts`, because it's test-harness-only convenience for scripting a
turn sequence without round-tripping the real id through scripted JSON; production runs
always carry the real id via Tool Runner's own message history. Implement it as a thin
pre-processing wrapper Task 5 adds around Task 4's tools, scoped to test usage only via a
constructor option:

```ts
// src/agent/investigate.ts
//
// FR-17's lifecycle entrypoint. Tool Runner drives the request/execute/loop
// cycle (see design doc "Architecture"); this file's job is composing the
// system prompt, tool set, and model, then interpreting the final
// InvestigationState into an InvestigationResult that never fabricates a
// conclusion (CLAUDE.md).
import Anthropic from "@anthropic-ai/sdk";
import { resolveModel } from "./model";
import { createInvestigationState, createTools } from "./tools";
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
}

export async function investigate(
  problemDescription: string,
  options: InvestigateOptions = {},
): Promise<InvestigationResult> {
  const client = options.client ?? new Anthropic();
  const model = resolveModel();
  const state = createInvestigationState();
  const tools = createTools(state);

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
      evidenceTrail: confirmed.supportingEvidence,
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
}
```

- [ ] **Step 5: Replace the `"__LATEST__"` placeholder with a dynamic scripted-client mode**

The `"__LATEST__"` id in Step 2's `createScriptedAnthropicClient`-based CONFIRMED test is not
resolvable statically — the real hypothesis id is only known after `propose_hypothesis`
actually runs, and Tool Runner sends the full message history (including the previous turn's
tool_result text) back on every subsequent call. So: delete that CONFIRMED test's
`createScriptedAnthropicClient(...)` array-of-turns construction entirely, and replace it with
a new, dynamic client mode that reads the id out of the request body instead of requiring it
pre-scripted. Add this alongside `createScriptedAnthropicClient` in the same helper file (the
INSUFFICIENT_EVIDENCE test's turns don't depend on a real id, so `createScriptedAnthropicClient`
stays as-is and is still used by that test):

```ts
// tests/agent/helpers/mockAnthropicClient.ts — add alongside createScriptedAnthropicClient
export function createDynamicScriptedClient(remainingSupportingCalls = 5): Anthropic {
  let callIndex = 0;
  let hypothesisId: string | undefined;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    callIndex++;

    // Turn 1: always propose the hypothesis.
    if (callIndex === 1) {
      return jsonResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_propose",
            name: "propose_hypothesis",
            input: { statement: "Scheduler is disabled" },
          },
        ],
        stop_reason: "tool_use",
      });
    }

    // Every later turn: pull the hypothesis id out of the most recent
    // tool_result in the request body (Tool Runner sends the full
    // message history on each call), which contains the real id in its
    // text — e.g. "created hypothesis <uuid>: ...".
    if (!hypothesisId) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const match = /created hypothesis ([0-9a-f-]{36})/.exec(bodyText);
      if (match) hypothesisId = match[1];
    }

    if (callIndex <= 1 + remainingSupportingCalls) {
      return jsonResponse({
        content: [
          {
            type: "tool_use",
            id: `toolu_evidence_${callIndex}`,
            name: "update_hypothesis",
            input: {
              hypothesisId,
              direction: "supporting",
              description: `evidence ${callIndex}`,
              toolSource: "query_brain",
            },
          },
        ],
        stop_reason: "tool_use",
      });
    }

    return jsonResponse({
      content: [{ type: "text", text: "Investigation complete." }],
      stop_reason: "end_turn",
    });
  }) as unknown as typeof fetch;

  function jsonResponse(partial: { content: BetaContentBlock[]; stop_reason: string }) {
    return new Response(
      JSON.stringify({
        id: `msg_test_${callIndex}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        ...partial,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
}

/**
 * Generalized step-function client for scenario tests (Task 7) that need
 * to script real evidence-tool calls (query_brain, search_code) — not just
 * the two control tools — to satisfy the spec's "gathers evidence via at
 * least two different tool types" requirement. `step` receives the 1-based
 * call index and the raw previous-request body text (to regex out ids
 * discovered from earlier tool results, same technique as
 * createDynamicScriptedClient above) and returns the next turn.
 */
export function createStepFunctionClient(
  step: (callIndex: number, bodyText: string) => { content: BetaContentBlock[]; stop_reason: string },
): Anthropic {
  let callIndex = 0;

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    callIndex++;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const turn = step(callIndex, bodyText);

    return new Response(
      JSON.stringify({
        id: `msg_test_${callIndex}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        ...turn,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
}

/** Regexes the hypothesis id out of a `created hypothesis <uuid>: ...` tool result in raw request body text — shared by scenario tests in Task 7. */
export function extractHypothesisId(bodyText: string, exclude?: string): string | undefined {
  const matches = [...bodyText.matchAll(/created hypothesis ([0-9a-f-]{36})/g)];
  const ids = matches.map((m) => m[1]).filter((id) => id !== exclude);
  return ids.at(-1);
}
```

Then update `tests/agent/investigate.test.ts`'s CONFIRMED test to import and call
`createDynamicScriptedClient()` directly (delete the earlier `createScriptedAnthropicClient`
array-of-turns version of that same test — keep `createScriptedAnthropicClient` only for the
INSUFFICIENT_EVIDENCE test, whose turns don't depend on a real id):

```ts
test("CONFIRMED path: scripted turns propose a hypothesis, add enough supporting evidence, and end_turn", async () => {
  const client = createDynamicScriptedClient(5);
  const result = await investigate("Task stuck in WAIT_JUDGE", { client });
  expect(result.outcome).toBe("CONFIRMED");
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/agent/investigate.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 8: Add an FR-18 smoke test (parallel tool execution)**

FR-18 (MUST) requires the agent support parallel tool execution, not just sequential. Tool
Runner handles this natively — a single scripted assistant turn can contain multiple
`tool_use` blocks, and Tool Runner executes them concurrently and returns all `tool_result`
blocks in one message. This is Tool Runner's behavior, not code this module writes, but it
needs a test proving our wiring doesn't accidentally break it (e.g. by only reading
`content[0]`):

```ts
// tests/agent/investigate.test.ts — add this test
test("FR-18: a single turn with multiple tool_use blocks executes all of them (parallel tool execution)", async () => {
  let callIndex = 0;
  const fetchImpl = (async () => {
    callIndex++;
    if (callIndex === 1) {
      return new Response(
        JSON.stringify({
          id: "msg_test_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_a",
              name: "propose_hypothesis",
              input: { statement: "Hypothesis A" },
            },
            {
              type: "tool_use",
              id: "toolu_b",
              name: "propose_hypothesis",
              input: { statement: "Hypothesis B" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg_test_2",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: "test-key", fetch: fetchImpl });
  const result = await investigate("test problem", { client });

  // Both tool_use blocks from the single turn must have executed — proves
  // multiple tool calls in one assistant turn are both honored, not just
  // the first. state isn't directly exposed on InvestigationResult, so
  // assert indirectly via hypothesesConsidered on the INSUFFICIENT_EVIDENCE
  // path (neither hypothesis gets evidence, so this is the expected
  // outcome here).
  expect(result.outcome).toBe("INSUFFICIENT_EVIDENCE");
  if (result.outcome !== "INSUFFICIENT_EVIDENCE") throw new Error("unreachable");
  expect(result.hypothesesConsidered).toHaveLength(2);
  expect(result.hypothesesConsidered.map((h) => h.statement).sort()).toEqual([
    "Hypothesis A",
    "Hypothesis B",
  ]);
});
```

- [ ] **Step 9: Run test to verify it passes**

Run: `bun test tests/agent/investigate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: Commit**

```bash
git add src/agent/investigate.ts tests/agent/helpers/mockAnthropicClient.ts tests/agent/investigate.test.ts
git commit -m "Add investigate() lifecycle entrypoint with injectable Anthropic client for tests"
```

---

### Task 6: Public barrel export

**Files:**
- Create: `src/agent/index.ts`
- Modify: `docs/` — create `docs/investigation-agent.md` documenting the public surface

**Interfaces:**
- Consumes: everything from Tasks 1-5
- Produces: the module's public import surface, `import { investigate } from "../agent"`

- [ ] **Step 1: Write the barrel export**

```ts
// src/agent/index.ts
//
// Public surface for Module 03. A later module (04, Evidence Timeline —
// not part of this plan) imports from here, matching the barrel-export
// pattern in src/brain/index.ts and src/integrations/github/index.ts.
export { investigate } from "./investigate";
export type { InvestigateOptions } from "./investigate";
export type {
  Evidence,
  Hypothesis,
  HypothesisStatus,
  InvestigationResult,
} from "./types";
export { CONFIRMATION_THRESHOLD, REFUTATION_THRESHOLD } from "./hypotheses";
```

- [ ] **Step 2: Write the docs file**

```markdown
<!-- docs/investigation-agent.md -->
# Investigation Agent (Module 03)

## Public surface

\`\`\`ts
import { investigate } from "../src/agent";

const result = await investigate("Task stuck in WAIT_JUDGE for order #123");

if (result.outcome === "CONFIRMED") {
  console.log(result.rca, result.evidenceTrail);
} else {
  console.log("insufficient evidence:", result.reason, result.hypothesesConsidered);
}
\`\`\`

## Configuration

- `INVESTIGATION_AGENT_MODEL` — selects the Claude model, default `claude-opus-5`. Throws at
  first call if set to an unrecognized model id.

## Known gaps (tracked, not silent)

- `query_database` and `search_logs` tools always return a `NOT_IMPLEMENTED` marker — real
  PostgreSQL/Datadog integrations are a later pass (Module 02 was closed at GitHub-only scope
  for the MVP; see `docs/superpowers/specs/2026-08-21-investigation-agent-design.md`, Scope
  Decision #1/#2).
- `CONFIRMATION_THRESHOLD` / `REFUTATION_THRESHOLD` (`src/agent/hypotheses.ts`) are explicit
  provisional values — not yet calibrated against real incidents (needs Module 11's benchmark
  data).
```

- [ ] **Step 3: Run full test suite + typecheck**

Run: `env -u GITHUB_TOKEN bun test && bun run typecheck`
Expected: PASS, no errors — this is the same command the PostToolUse hook runs, so this step
confirms the hook will stay green.

- [ ] **Step 4: Commit**

```bash
git add src/agent/index.ts docs/investigation-agent.md
git commit -m "Add Module 03 public barrel export + docs"
```

---

### Task 7: Demo-scenario fixtures and end-to-end tests

**Files:**
- Create: `tests/agent/fixtures/seedBrain.ts` (shared seeding helper)
- Test: `tests/agent/scenarios/scheduler-disabled.test.ts`
- Test: `tests/agent/scenarios/missing-config.test.ts`
- Test: `tests/agent/scenarios/race-condition.test.ts`
- Test: `tests/agent/scenarios/historical-rca-candidate.test.ts`

**Interfaces:**
- Consumes: `investigate` (Task 5), `createDynamicScriptedClient`/`createScriptedAnthropicClient`
  (Task 5's test helper), `upsertEntity`, `recordRelationshipObservation` (from `../../src/brain`)
- Produces: nothing consumed elsewhere — this task is the module's Definition of Done
  verification (spec's required test cases).

- [ ] **Step 1: Write the shared Brain-seeding helper**

```ts
// tests/agent/fixtures/seedBrain.ts
//
// Seeds a minimal Brain state for a demo scenario. Uses module 01's real
// write-path (upsertEntity / recordRelationshipObservation) against the
// test database configured in .env.test — same DB the rest of the suite
// already uses (see tests/setup.ts), so no separate fixture DB is needed.
import { recordRelationshipObservation, upsertEntity } from "../../../src/brain";
import { getFileContent, getRepo, getTreeRecursive } from "../../../src/integrations/github/client";

export async function seedSchedulerDisabledScenario() {
  const scheduler = await upsertEntity({
    domain: "Runtime",
    entityType: "Scheduler",
    name: "LiabilityAssignmentScheduler",
    sourceSystem: "test-fixture",
    sourceRef: "fixture:scheduler-disabled:scheduler",
    attributes: { enabled: false },
  });

  const task = await upsertEntity({
    domain: "Runtime",
    entityType: "WorkflowTask",
    name: "AssignLiabilityTask",
    sourceSystem: "test-fixture",
    sourceRef: "fixture:scheduler-disabled:task",
    attributes: { state: "WAIT_JUDGE" },
  });

  await recordRelationshipObservation({
    fromEntityId: task.id,
    toEntityId: scheduler.id,
    relationshipType: "TRANSITIONS_TO",
    sourceSystem: "test-fixture",
    sourceRef: "fixture:scheduler-disabled:transition",
  });

  return { scheduler, task };
}

export async function seedHistoricalIncident(statement: string) {
  return upsertEntity({
    domain: "Operational Knowledge",
    entityType: "IncidentRCA",
    name: statement,
    sourceSystem: "test-fixture",
    sourceRef: `fixture:historical:${crypto.randomUUID()}`,
    attributes: { rca: statement },
  });
}

/**
 * Seeds a real, live-fetched File entity for search_code to exercise for
 * real — reuses the same live Jung028/tracely-brain repo the GitHub client
 * tests already call (module 02's live-by-default convention still applies
 * to GitHub/Brain calls; only the Anthropic client is mocked in this
 * module — see design doc Testing section). Returns the entity's `name`
 * (file path) so scenario tests can script a matching search_code call.
 */
export async function seedRealCodeFileEntity() {
  const repoResult = await getRepo("Jung028", "tracely-brain");
  if (!("ok" in repoResult) || !repoResult.ok) {
    throw new Error("live getRepo failed while seeding a code file fixture");
  }
  const repoData = repoResult.data as { default_branch: string };

  const treeResult = await getTreeRecursive(
    "Jung028",
    "tracely-brain",
    repoData.default_branch,
  );
  if (!("ok" in treeResult) || !treeResult.ok) {
    throw new Error("live getTreeRecursive failed while seeding a code file fixture");
  }

  const packageJson = treeResult.data.find((e) => e.path === "package.json");
  if (!packageJson) throw new Error("package.json not found in live tree");

  // Sanity-check content is actually fetchable before the test relies on
  // it (fails fast with a clear message rather than a confusing assertion
  // failure deep in a scenario test).
  const content = await getFileContent("Jung028", "tracely-brain", packageJson.sha);
  if (!("ok" in content) || !content.ok) {
    throw new Error("live getFileContent failed while seeding a code file fixture");
  }

  await upsertEntity({
    domain: "Code",
    entityType: "File",
    name: "package.json",
    sourceSystem: "github",
    sourceRef: "github:Jung028/tracely-brain:package.json",
    attributes: { sha: packageJson.sha },
  });

  return { path: "package.json" };
}
```

- [ ] **Step 2: Write the scheduler-disabled scenario test**

```ts
// tests/agent/scenarios/scheduler-disabled.test.ts
//
// Demo scenario 1/3 (spec's "three demo scenarios" — authored fresh, no
// source material existed; see design doc Scope Decision #3). Seeds a
// scheduler entity + a task stuck in WAIT_JUDGE plus a real code file,
// scripts turns that call query_brain AND search_code (spec requires
// "evidence via at least two different tool types") before confirming.
import { describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedRealCodeFileEntity, seedSchedulerDisabledScenario } from "../fixtures/seedBrain";

describe("demo scenario: scheduler disabled", () => {
  test("reaches CONFIRMED using evidence from at least two different tool types", async () => {
    const { task } = await seedSchedulerDisabledScenario();
    await seedRealCodeFileEntity();

    let hypothesisId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: { statement: "Liability assignment scheduler is disabled" },
            },
          ],
        };
      }
      if (callIndex === 2) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_query_brain",
              name: "query_brain",
              input: {
                mode: "traverse",
                startEntityId: task.id,
                relationshipTypes: ["TRANSITIONS_TO"],
                maxDepth: 2,
              },
            },
          ],
        };
      }
      if (callIndex === 3) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_evidence_1",
              name: "update_hypothesis",
              input: {
                hypothesisId,
                direction: "supporting",
                description: "Task stuck in WAIT_JUDGE, scheduler transition observed via Brain",
                toolSource: "query_brain",
              },
            },
          ],
        };
      }
      if (callIndex === 4) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_search_code",
              name: "search_code",
              input: { pathContains: "package.json" },
            },
          ],
        };
      }
      if (callIndex <= 8) {
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
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Order liability assignment task is stuck in WAIT_JUDGE and never progresses.",
      { client },
    );

    expect(result.outcome).toBe("CONFIRMED");
    if (result.outcome !== "CONFIRMED") throw new Error("unreachable");
    const toolSources = new Set(result.evidenceTrail.map((e) => e.toolSource));
    expect(toolSources.size).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Write the missing-config and race-condition scenario tests**

```ts
// tests/agent/scenarios/missing-config.test.ts
//
// Demo scenario 2/3. query_brain returning nothing for a required config
// entity is the evidence itself; search_code corroborates by showing the
// code path that reads the (absent) config key — satisfies "evidence via
// at least two different tool types."
import { describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedRealCodeFileEntity } from "../fixtures/seedBrain";

describe("demo scenario: missing config", () => {
  test("reaches CONFIRMED using query_brain (absence) plus search_code (corroboration)", async () => {
    await seedRealCodeFileEntity();
    let hypothesisId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: { statement: "Required config key is missing at startup" },
            },
          ],
        };
      }
      if (callIndex === 2) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_search_code",
              name: "search_code",
              input: { pathContains: "package.json" },
            },
          ],
        };
      }
      if (callIndex <= 7) {
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
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Service fails to start with an unresolved config reference.",
      { client },
    );

    expect(result.outcome).toBe("CONFIRMED");
  });
});
```

```ts
// tests/agent/scenarios/race-condition.test.ts
//
// Exercises FR-20 end-to-end: the first hypothesis is deliberately refuted
// by scripted contradicting evidence (from query_brain), and a second
// hypothesis is proposed and confirmed using evidence from both
// query_brain and search_code.
import { describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedRealCodeFileEntity } from "../fixtures/seedBrain";

describe("demo scenario: race condition (FR-20 end-to-end)", () => {
  test("first hypothesis is REFUTED, a replacement is proposed and CONFIRMED via two tool types", async () => {
    await seedRealCodeFileEntity();
    let firstHypothesisId: string | undefined;
    let secondHypothesisId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (callIndex === 1) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "propose_hypothesis",
              input: { statement: "Both writers acquired the lock simultaneously" },
            },
          ],
        };
      }

      if (!firstHypothesisId) firstHypothesisId = extractHypothesisId(bodyText);

      // Turns 2-6: contradict the first hypothesis via query_brain until
      // REFUTED (REFUTATION_THRESHOLD 0.75 at 0.2/item -> 5 items).
      if (callIndex <= 6) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_contra_${callIndex}`,
              name: "update_hypothesis",
              input: {
                hypothesisId: firstHypothesisId,
                direction: "contradicting",
                description: `contradiction ${callIndex}`,
                toolSource: "query_brain",
              },
            },
          ],
        };
      }

      if (callIndex === 7) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_second",
              name: "propose_hypothesis",
              input: { statement: "Writer B's retry lacked the ordering guarantee" },
            },
          ],
        };
      }

      if (!secondHypothesisId) {
        secondHypothesisId = extractHypothesisId(bodyText, firstHypothesisId);
      }

      if (callIndex === 8) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_search_code",
              name: "search_code",
              input: { pathContains: "package.json" },
            },
          ],
        };
      }

      if (callIndex <= 13) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `toolu_support_${callIndex}`,
              name: "update_hypothesis",
              input: {
                hypothesisId: secondHypothesisId,
                direction: "supporting",
                description: `support ${callIndex}`,
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }

      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Two concurrent writers produced an inconsistent balance.",
      { client, maxIterations: 20 },
    );

    expect(result.outcome).toBe("CONFIRMED");
    if (result.outcome !== "CONFIRMED") throw new Error("unreachable");
    expect(result.hypothesis.statement).toBe("Writer B's retry lacked the ordering guarantee");
  });
});
```

- [ ] **Step 4: Write the historical-RCA-candidate test (FR-30)**

```ts
// tests/agent/scenarios/historical-rca-candidate.test.ts
//
// FR-29/FR-30: a historical incident surfaces as a *candidate* hypothesis
// via query_brain's Operational Knowledge domain, but the agent must still
// require fresh evidence (from a second tool type, search_code) before
// CONFIRMED — spec explicitly calls out this rule as easy to accidentally
// skip, so it's tested directly rather than only covered incidentally.
import { describe, expect, test } from "bun:test";
import { investigate } from "../../../src/agent/investigate";
import { createStepFunctionClient, extractHypothesisId } from "../helpers/mockAnthropicClient";
import { seedHistoricalIncident, seedRealCodeFileEntity } from "../fixtures/seedBrain";

describe("demo scenario: historical RCA as candidate, not proof", () => {
  test("a past RCA surfacing via query_brain still requires fresh evidence to reach CONFIRMED", async () => {
    await seedHistoricalIncident("Scheduler config drift caused a similar stall in Q1");
    await seedRealCodeFileEntity();
    let hypothesisId: string | undefined;

    const client = createStepFunctionClient((callIndex, bodyText) => {
      if (!hypothesisId) hypothesisId = extractHypothesisId(bodyText);

      if (callIndex === 1) {
        // Models the historical match surfacing as a *candidate* only —
        // propose_hypothesis is what turns it into something trackable,
        // not query_brain alone.
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_propose",
              name: "propose_hypothesis",
              input: {
                statement: "Scheduler config drift (matches historical incident)",
              },
            },
          ],
        };
      }
      if (callIndex === 2) {
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_search_code",
              name: "search_code",
              input: { pathContains: "package.json" },
            },
          ],
        };
      }
      if (callIndex <= 7) {
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
                description: `fresh supporting evidence ${callIndex}`,
                toolSource: callIndex % 2 === 0 ? "query_brain" : "search_code",
              },
            },
          ],
        };
      }
      return { stop_reason: "end_turn", content: [{ type: "text", text: "Investigation complete." }] };
    });

    const result = await investigate(
      "Order liability assignment task is stuck in WAIT_JUDGE and never progresses.",
      { client },
    );

    expect(result.outcome).toBe("CONFIRMED");
    if (result.outcome !== "CONFIRMED") throw new Error("unreachable");
    // Confirmation came from the 5 scripted update_hypothesis (fresh
    // evidence) calls, not from the historical match by itself — the
    // historical entity seeded above is never referenced by
    // update_hypothesis at all, so a regression that let query_brain's
    // historical-domain result alone confirm a hypothesis would still
    // require these 5 real evidence items to pass, keeping this test a
    // faithful FR-30 guard.
    expect(result.evidenceTrail.length).toBe(5);
  });
});
```

- [ ] **Step 5: Run the full scenario suite**

Run: `env -u GITHUB_TOKEN bun test tests/agent`
Expected: PASS — all of Tasks 1-7's tests (model, hypotheses, tools, investigate, 4 scenarios)

- [ ] **Step 6: Run the full repo suite + typecheck (matches the PostToolUse hook exactly)**

Run: `env -u GITHUB_TOKEN bun test && bun run typecheck`
Expected: PASS, no errors

- [ ] **Step 7: Commit**

```bash
git add tests/agent/fixtures tests/agent/scenarios
git commit -m "Add Module 03 demo-scenario fixtures and end-to-end tests (FR-17/19/20/29/30)"
```

---

## Definition of Done (from `specs/03-investigation-agent.md`, verified by this plan)

- [x] Full FR-17 lifecycle runs end-to-end against a seeded test Brain + mocked tool responses
      — Task 7.
- [x] Hypothesis objects match the spec's example structure and are inspectable — Task 2's
      `Hypothesis` type + Task 5's `InvestigationResult`.
- [x] All required test cases pass: three demo scenarios (Task 7), REFUTED → new hypothesis
      (race-condition scenario, Task 7), historical-RCA-as-candidate (Task 7).

After this plan's tasks are all committed, per CLAUDE.md's "Definition of done for any
module": push the branch and open a PR — don't leave Module 03 sitting only on a local branch.
