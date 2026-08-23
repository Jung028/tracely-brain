import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../../src/slack/verify";

const SIGNING_SECRET = "test-signing-secret";

function sign(timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  test("accepts a correctly-signed, fresh request", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T123";
    const signature = sign(timestamp, rawBody);

    expect(
      verifySlackSignature({ timestamp, signature, rawBody, signingSecret: SIGNING_SECRET }),
    ).toBe(true);
  });

  test("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(timestamp, "token=abc&team_id=T123");

    expect(
      verifySlackSignature({
        timestamp,
        signature,
        rawBody: "token=abc&team_id=T999",
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("rejects a signature computed with the wrong secret", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T123";
    const base = `v0:${timestamp}:${rawBody}`;
    const wrongSignature = `v0=${createHmac("sha256", "wrong-secret").update(base).digest("hex")}`;

    expect(
      verifySlackSignature({
        timestamp,
        signature: wrongSignature,
        rawBody,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("rejects a stale timestamp (older than 5 minutes)", () => {
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = "token=abc&team_id=T123";
    const signature = sign(staleTimestamp, rawBody);

    expect(
      verifySlackSignature({
        timestamp: staleTimestamp,
        signature,
        rawBody,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });

  test("rejects when signingSecret is empty (not configured)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = "token=abc&team_id=T123";
    const signature = sign(timestamp, rawBody);

    expect(
      verifySlackSignature({ timestamp, signature, rawBody, signingSecret: "" }),
    ).toBe(false);
  });

  test("rejects a non-numeric timestamp instead of throwing", () => {
    const rawBody = "token=abc&team_id=T123";
    expect(
      verifySlackSignature({
        timestamp: "not-a-number",
        signature: "v0=whatever",
        rawBody,
        signingSecret: SIGNING_SECRET,
      }),
    ).toBe(false);
  });
});
