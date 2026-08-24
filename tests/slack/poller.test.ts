import { afterEach, describe, expect, test } from "bun:test";
import { pollAndPost } from "../../src/slack/poller";
import { registerSession, unregisterSession } from "../../src/session";
import { createInvestigationState } from "../../src/agent/tools";
import { proposeHypothesis } from "../../src/agent/hypotheses";
import { beginInvestigating, createInvestigation, getInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { PostMessageInput, PostMessageResult } from "../../src/slack/client";

afterEach(async () => {
  await truncateAll();
});

function manualInterval() {
  let callback: (() => void) | null = null;
  const setIntervalImpl = ((cb: () => void) => {
    callback = cb;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const clearIntervalImpl = (() => {
    callback = null;
  }) as typeof clearInterval;
  return { setIntervalImpl, clearIntervalImpl, tick: () => callback?.() };
}

describe("pollAndPost", () => {
  test("posts a progress update only when stepNumber has advanced, then posts the final CONFIRMED result", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(investigation.id);
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const posts: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      posts.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    const { setIntervalImpl, clearIntervalImpl, tick } = manualInterval();

    let resolveResult!: (r: InvestigationResult) => void;
    const resultPromise = new Promise<InvestigationResult>((resolve) => {
      resolveResult = resolve;
    });

    const pollPromise = pollAndPost(
      sessionId,
      investigation.id,
      resultPromise,
      { channel: "C123", thread_ts: "1700000000.000000" },
      { setIntervalImpl, clearIntervalImpl, postMessageImpl },
    );

    // No steps yet — a tick should not post anything.
    tick();
    await Promise.resolve();
    expect(posts).toHaveLength(0);

    // Advance stepNumber and hypotheses — next tick should post exactly one update.
    state.stepNumber = 2;
    state.hypotheses.push(proposeHypothesis("Scheduler is disabled"));
    tick();
    await Promise.resolve();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("2 steps");

    // A tick with no further advancement should not post again.
    tick();
    await Promise.resolve();
    expect(posts).toHaveLength(1);

    // Resolve the investigation as CONFIRMED.
    const confirmedHypothesis = state.hypotheses[0]!;
    resolveResult({
      outcome: "CONFIRMED",
      hypothesis: confirmedHypothesis,
      rca: confirmedHypothesis.statement,
      evidenceTrail: [],
      toolCalls: [],
    });
    await pollPromise;
    unregisterSession(sessionId);

    expect(posts).toHaveLength(2);
    expect(posts[1]!.text).toContain(confirmedHypothesis.statement);
    expect(posts[1]!.text).toContain(`investigation=${investigation.id}`);

    expect(posts[1]!.text).toContain("Status: RCA_IDENTIFIED");

    const stored = await getInvestigation(investigation.id);
    expect(stored!.status).toBe("RCA_IDENTIFIED");
    expect(stored!.result).not.toBeNull();
  });

  test("INSUFFICIENT_EVIDENCE result posts the NOT CONFIRMED report text", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(investigation.id);
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const posts: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      posts.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };
    const { setIntervalImpl, clearIntervalImpl } = manualInterval();

    const resultPromise = Promise.resolve<InvestigationResult>({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });

    await pollAndPost(
      sessionId,
      investigation.id,
      resultPromise,
      { channel: "C123", thread_ts: "1700000000.000000" },
      { setIntervalImpl, clearIntervalImpl, postMessageImpl },
    );
    unregisterSession(sessionId);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("NOT CONFIRMED");
    expect(posts[0]!.text).toContain("Status: MANUAL_REVIEW_REQUIRED");

    const stored = await getInvestigation(investigation.id);
    expect(stored!.status).toBe("MANUAL_REVIEW_REQUIRED");
  });

  test("a failed progress-update postMessage call is logged and does not stop polling or crash", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    await beginInvestigating(investigation.id);
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    let callCount = 0;
    const postMessageImpl = async (): Promise<PostMessageResult> => {
      callCount++;
      return { ok: false, error: "simulated failure" };
    };
    const { setIntervalImpl, clearIntervalImpl, tick } = manualInterval();

    const resultPromise = Promise.resolve<InvestigationResult>({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });

    const pollPromise = pollAndPost(
      sessionId,
      investigation.id,
      resultPromise,
      { channel: "C123", thread_ts: "1700000000.000000" },
      { setIntervalImpl, clearIntervalImpl, postMessageImpl },
    );

    state.stepNumber = 1;
    tick();
    await Promise.resolve();

    await pollPromise;
    unregisterSession(sessionId);

    // One progress post attempt (failed) + one final post attempt (also
    // failed here, same postMessageImpl) — neither throws.
    expect(callCount).toBe(2);
  });

  test("a rejecting resultPromise posts a failure message, clears the interval, and does not reject", async () => {
    const investigation = await createInvestigation({ problemDescription: "test" });
    const sessionId = investigation.id;
    const state = createInvestigationState();
    registerSession(sessionId, state);

    const posts: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      posts.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    const { setIntervalImpl, clearIntervalImpl } = manualInterval();
    let clearIntervalCallCount = 0;
    const trackedClearIntervalImpl: typeof clearInterval = (timer) => {
      clearIntervalCallCount++;
      clearIntervalImpl(timer as never);
    };

    const resultPromise = Promise.reject<InvestigationResult>(
      new Error("Anthropic API rate limited"),
    );

    // This is the same invocation shape handler.ts uses: `void
    // pollAndPost(...)`. If pollAndPost's own returned promise could still
    // reject here, that `void` call would itself become an unhandled
    // rejection and crash the process — so we assert directly that
    // awaiting it never throws.
    await expect(
      pollAndPost(
        sessionId,
        investigation.id,
        resultPromise,
        { channel: "C123", thread_ts: "1700000000.000000" },
        { setIntervalImpl, clearIntervalImpl: trackedClearIntervalImpl, postMessageImpl },
      ),
    ).resolves.toBeUndefined();

    unregisterSession(sessionId);

    expect(clearIntervalCallCount).toBe(1);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("C123");
    expect(posts[0]!.thread_ts).toBe("1700000000.000000");
    expect(posts[0]!.text).toContain("Investigation failed");
    expect(posts[0]!.text).toContain("Anthropic API rate limited");
  });
});
