import { afterEach, describe, expect, test } from "bun:test";
import { handleAppMention } from "../../src/slack/handler";
import { getInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { PostMessageInput, PostMessageResult } from "../../src/slack/client";

afterEach(async () => {
  await truncateAll();
});

describe("handleAppMention", () => {
  test("strips the leading mention token to get the problem description, and persists it", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    let investigateCalled = false;
    const investigateImpl = async (): Promise<InvestigationResult> => {
      investigateCalled = true;
      return { outcome: "INSUFFICIENT_EVIDENCE", hypothesesConsidered: [], reason: "no hypothesis was proposed", toolCalls: [] };
    };

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123> the error rate spiked at 14:03, please investigate",
        ts: "1700000000.000000",
      },
      { postMessageImpl, investigateImpl },
    );

    // Exactly one post — the ack — proves handleAppMention returned without
    // waiting on investigateImpl's promise (it resolved instantly here, so
    // this alone doesn't prove non-blocking under a slow investigateImpl;
    // Step "posts the ack before investigate() resolves" below covers that).
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.channel).toBe("C123");
    expect(postCalls[0]!.thread_ts).toBe("1700000000.000000");
    expect(postCalls[0]!.text).toContain("Investigating");
    expect(postCalls[0]!.text).toContain("Status: INVESTIGATING");

    const idMatch = /investigation=([0-9a-f-]{36})/.exec(postCalls[0]!.text);
    expect(idMatch).toBeTruthy();
    const investigationId = idMatch![1]!;

    const investigation = await getInvestigation(investigationId);
    expect(investigation).toBeDefined();
    expect(investigation!.problemDescription).toBe(
      "the error rate spiked at 14:03, please investigate",
    );
    expect(investigation!.slackChannelId).toBe("C123");
    expect(investigation!.slackThreadTs).toBe("1700000000.000000");

    expect(investigateCalled).toBe(true);
  });

  test("uses thread_ts as the reply target when the mention is already inside a thread", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };
    const investigateImpl = async (): Promise<InvestigationResult> => ({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123> investigate this",
        ts: "1700000000.000050",
        thread_ts: "1700000000.000000",
      },
      { postMessageImpl, investigateImpl },
    );

    expect(postCalls[0]!.thread_ts).toBe("1700000000.000000");
  });

  test("posts the ack before investigate() resolves (does not block on it)", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000100" };
    };

    let resolveInvestigate!: (r: InvestigationResult) => void;
    const pending = new Promise<InvestigationResult>((resolve) => {
      resolveInvestigate = resolve;
    });
    const investigateImpl = async (): Promise<InvestigationResult> => pending;

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123> investigate this",
        ts: "1700000000.000000",
      },
      { postMessageImpl, investigateImpl },
    );

    // handleAppMention already returned even though investigateImpl's
    // promise is still pending — proves it isn't awaited inline.
    expect(postCalls).toHaveLength(1);

    // Clean up: resolve the pending promise so nothing dangles past the test.
    resolveInvestigate({
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    });
  });

  test("a mention with no question text posts a help message and never calls investigate()", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000200" };
    };

    let investigateCalled = false;
    const investigateImpl = async (): Promise<InvestigationResult> => {
      investigateCalled = true;
      return { outcome: "INSUFFICIENT_EVIDENCE", hypothesesConsidered: [], reason: "unreachable", toolCalls: [] };
    };

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123>",
        ts: "1700000000.000300",
      },
      { postMessageImpl, investigateImpl },
    );

    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.channel).toBe("C123");
    expect(postCalls[0]!.thread_ts).toBe("1700000000.000300");
    expect(postCalls[0]!.text).toContain("need a question");
    expect(postCalls[0]!.text).not.toContain("Investigating");

    expect(investigateCalled).toBe(false);
  });

  test("a mention with only whitespace after stripping is also treated as empty", async () => {
    const postCalls: PostMessageInput[] = [];
    const postMessageImpl = async (input: PostMessageInput): Promise<PostMessageResult> => {
      postCalls.push(input);
      return { ok: true, ts: "1700000000.000400" };
    };
    let investigateCalled = false;
    const investigateImpl = async (): Promise<InvestigationResult> => {
      investigateCalled = true;
      return { outcome: "INSUFFICIENT_EVIDENCE", hypothesesConsidered: [], reason: "unreachable", toolCalls: [] };
    };

    await handleAppMention(
      {
        channel: "C123",
        user: "U999",
        text: "<@U0BOT123>    ",
        ts: "1700000000.000500",
      },
      { postMessageImpl, investigateImpl },
    );

    expect(postCalls).toHaveLength(1);
    expect(investigateCalled).toBe(false);
  });
});
