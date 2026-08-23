import { afterEach, describe, expect, test } from "bun:test";
import { completeInvestigation, createInvestigation, getInvestigation } from "../../src/investigations";
import { truncateAll } from "../db-helpers";
import type { InvestigationResult } from "../../src/agent/types";
import type { InvestigationTimeline } from "../../src/timeline/types";

afterEach(async () => {
  await truncateAll();
});

describe("createInvestigation", () => {
  test("creates a record with status IN_PROGRESS and no result yet", async () => {
    const investigation = await createInvestigation({
      problemDescription: "Elevated error rate starting at 14:03",
      slackChannelId: "C123",
      slackThreadTs: "1700000000.000100",
    });

    expect(investigation.id).toBeTruthy();
    expect(investigation.status).toBe("IN_PROGRESS");
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

describe("completeInvestigation", () => {
  const fakeTimeline: InvestigationTimeline = { steps: [] };

  test("CONFIRMED outcome sets status CONFIRMED and stores the result", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    const result: InvestigationResult = {
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

    const completed = await completeInvestigation(created.id, { result, timeline: fakeTimeline });

    expect(completed.status).toBe("CONFIRMED");
    expect(completed.result).toEqual({ result, timeline: fakeTimeline });
  });

  test("INSUFFICIENT_EVIDENCE outcome sets status INSUFFICIENT_EVIDENCE", async () => {
    const created = await createInvestigation({ problemDescription: "test" });
    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    };

    const completed = await completeInvestigation(created.id, { result, timeline: fakeTimeline });

    expect(completed.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  test("throws for an id that doesn't exist", async () => {
    const result: InvestigationResult = {
      outcome: "INSUFFICIENT_EVIDENCE",
      hypothesesConsidered: [],
      reason: "no hypothesis was proposed",
      toolCalls: [],
    };

    await expect(
      completeInvestigation("00000000-0000-0000-0000-000000000000", { result, timeline: fakeTimeline }),
    ).rejects.toThrow();
  });
});
