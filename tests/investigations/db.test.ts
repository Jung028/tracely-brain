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
