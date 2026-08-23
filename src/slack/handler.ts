// FR-32/33: the only place this module's Slack-specific code meets
// modules 03/06's investigation lifecycle. No investigation logic here —
// this only orchestrates: create the record, ack, kick off investigate()
// without blocking, hand off progress/completion to the poller.
import { investigate } from "../agent";
import type { InvestigateOptions } from "../agent";
import type { InvestigationResult } from "../agent/types";
import { createInvestigation } from "../investigations";
import { postMessage } from "./client";
import type { PostMessageResult, PostMessageInput } from "./client";
import { pollAndPost } from "./poller";

// app_mention events fire only when this app itself is mentioned, so the
// leading <@ANYID> token is always this bot — no need for a separately
// configured bot user id env var to know which id to strip.
const LEADING_MENTION_RE = /^<@[^>]+>\s*/;

export interface AppMentionEvent {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export interface HandleAppMentionOptions {
  investigateImpl?: (problem: string, options?: InvestigateOptions) => Promise<InvestigationResult>;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}

export async function handleAppMention(
  event: AppMentionEvent,
  opts: HandleAppMentionOptions = {},
): Promise<void> {
  const investigateImpl = opts.investigateImpl ?? investigate;
  const postMessageImpl = opts.postMessageImpl ?? postMessage;
  const baseUrl = opts.baseUrl ?? "http://localhost:4300";

  const problemDescription = event.text.replace(LEADING_MENTION_RE, "").trim();
  const threadTs = event.thread_ts ?? event.ts;

  const investigation = await createInvestigation({
    problemDescription,
    slackChannelId: event.channel,
    slackThreadTs: threadTs,
  });

  const link = `${baseUrl}/?investigation=${investigation.id}`;
  await postMessageImpl({
    channel: event.channel,
    thread_ts: threadTs,
    text: `Investigating — I'll post updates here. Full view: ${link}`,
  });

  const resultPromise = investigateImpl(problemDescription, { sessionId: investigation.id });

  // Deliberately not awaited — the poller owns the rest of this
  // investigation's lifecycle, including posting the final result.
  void pollAndPost(
    investigation.id,
    investigation.id,
    resultPromise,
    { channel: event.channel, thread_ts: threadTs },
    { postMessageImpl },
  );
}
