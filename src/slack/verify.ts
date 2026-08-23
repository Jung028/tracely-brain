// Slack's documented request-signing scheme: HMAC-SHA256 of
// "v0:{timestamp}:{rawBody}" using the app's signing secret, compared
// against the X-Slack-Signature header with constant-time comparison.
// Also enforces a 5-minute timestamp window (replay protection), per
// Slack's own guidance. Never throws — every invalid input (bad secret,
// malformed timestamp, tampered body) resolves to `false`.
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

export function verifySlackSignature(params: {
  timestamp: string;
  signature: string;
  rawBody: string;
  signingSecret: string;
}): boolean {
  const { timestamp, signature, rawBody, signingSecret } = params;
  if (!signingSecret) return false;

  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum)) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampNum);
  if (ageSeconds > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;

  return timingSafeEqual(expectedBuf, actualBuf);
}
