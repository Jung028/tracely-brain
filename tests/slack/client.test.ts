import { describe, expect, test } from "bun:test";
import { postMessage } from "../../src/slack/client";

describe("postMessage", () => {
  test("not connected: returns a typed failure with no network call when SLACK_BOT_TOKEN is unset", async () => {
    delete process.env.SLACK_BOT_TOKEN;

    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("fetchImpl should never be called when not connected");
    }) as unknown as typeof fetch;

    const result = await postMessage(
      { channel: "C123", text: "hello" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: false, error: "not_connected" });
    expect(called).toBe(false);
  });

  test("success: returns ok:true with the posted message's ts", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await postMessage(
      { channel: "C123", text: "hello", thread_ts: "1700000000.000000" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true, ts: "1700000000.000100" });
  });

  test("Slack API error response: returns the typed failure, not a throw", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await postMessage({ channel: "C_BAD", text: "hello" }, { fetchImpl });

    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  test("network failure: returns a typed failure, not a throw", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await postMessage({ channel: "C123", text: "hello" }, { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("connection refused");
  });

  test("malformed response body: returns a typed failure, not a throw", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const fetchImpl = (async () =>
      new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const result = await postMessage({ channel: "C123", text: "hello" }, { fetchImpl });

    expect(result.ok).toBe(false);
  });
});
