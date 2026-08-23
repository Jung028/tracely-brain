// Slack Web API client — currently just chat.postMessage, the only Slack
// write this module needs. Same "typed failure surface, never throw for
// an expected failure" convention as src/integrations/github/client.ts,
// including its injectable-fetchImpl test seam.
export interface SlackFetchOptions {
  fetchImpl?: typeof fetch;
}

function getSlackBotToken(): string | null {
  const token = process.env.SLACK_BOT_TOKEN;
  return token && token.length > 0 ? token : null;
}

export interface PostMessageInput {
  channel: string;
  text: string;
  thread_ts?: string;
}

export type PostMessageResult = { ok: true; ts: string } | { ok: false; error: string };

export async function postMessage(
  input: PostMessageInput,
  opts?: SlackFetchOptions,
): Promise<PostMessageResult> {
  const token = getSlackBotToken();
  if (!token) {
    return { ok: false, error: "not_connected" };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: `malformed response body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = body as { ok?: unknown; ts?: unknown; error?: unknown };
  if (parsed.ok === true && typeof parsed.ts === "string") {
    return { ok: true, ts: parsed.ts };
  }
  return {
    ok: false,
    error: typeof parsed.error === "string" ? parsed.error : "unknown_error",
  };
}
