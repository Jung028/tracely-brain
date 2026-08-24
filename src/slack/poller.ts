// FR-33's "progress posted as the investigation proceeds, not just a
// final message" — polls module 06's live-state registry on an
// injectable interval and posts a thread update whenever stepNumber has
// advanced, until the investigation resolves, then persists the final
// result (via src/investigations) and posts it.
import { getInvestigationState } from "../session";
import { completeInvestigation } from "../investigations";
import { buildFailureReport, renderFailureReport } from "../failure";
import { buildTimeline } from "../timeline/build";
import type { InvestigationResult } from "../agent/types";
import { postMessage } from "./client";
import type { PostMessageInput, PostMessageResult } from "./client";

const DEFAULT_INTERVAL_MS = 4000;

export interface PollAndPostOptions {
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  postMessageImpl?: (input: PostMessageInput) => Promise<PostMessageResult>;
  baseUrl?: string;
}

export async function pollAndPost(
  sessionId: string,
  investigationId: string,
  resultPromise: Promise<InvestigationResult>,
  slackTarget: { channel: string; thread_ts: string },
  opts: PollAndPostOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;
  const postMessageImpl = opts.postMessageImpl ?? postMessage;
  const baseUrl = opts.baseUrl ?? "http://localhost:4300";

  let lastStepNumber = 0;

  function logIfFailed(result: PostMessageResult, context: string): void {
    if (!result.ok) {
      console.error(`slack poller: ${context} post failed: ${result.error}`);
    }
  }

  const timer = setIntervalImpl(() => {
    const snapshot = getInvestigationState(sessionId);
    if (!snapshot) return; // already resolved; the final post below handles completion
    if (snapshot.stepNumber > lastStepNumber) {
      lastStepNumber = snapshot.stepNumber;
      const hypothesesWord = snapshot.hypotheses.length === 1 ? "hypothesis" : "hypotheses";
      void postMessageImpl({
        channel: slackTarget.channel,
        thread_ts: slackTarget.thread_ts,
        text: `Still investigating… (${snapshot.stepNumber} steps so far, ${snapshot.hypotheses.length} ${hypothesesWord} under consideration)`,
      }).then((result) => logIfFailed(result, "progress"));
    }
  }, intervalMs);

  try {
    const result = await resultPromise;

    const timeline = buildTimeline(result.toolCalls);
    const completed = await completeInvestigation(investigationId, { result, timeline });
    if (!completed.ok) {
      console.error(
        `slack poller: completeInvestigation failed for ${investigationId}: ${completed.error}`,
      );
    }
    const statusLine = completed.ok ? `\nStatus: ${completed.investigation.status}` : "";

    const link = `${baseUrl}/?investigation=${investigationId}`;
    const finalText =
      result.outcome === "CONFIRMED"
        ? `✅ Root cause confirmed: ${result.rca}\nFull view: ${link}${statusLine}`
        : `${renderFailureReport(buildFailureReport(result))}\nFull view: ${link}${statusLine}`;

    const finalResult = await postMessageImpl({
      channel: slackTarget.channel,
      thread_ts: slackTarget.thread_ts,
      text: finalText,
    });
    logIfFailed(finalResult, "final result");
  } catch (err) {
    // resultPromise (ultimately investigate()) rejected, or something in
    // the success path above threw unexpectedly. This is an UNEXPECTED
    // failure of a dependency — not an EXPECTED typed failure — so it's
    // caught and handled here rather than left to crash the process
    // (Bun terminates on an unhandled rejection, which would take down
    // both the Slack webhook and the web UI). This function must never
    // reject once this fix lands.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`slack poller: investigation ${investigationId} failed: ${message}`);
    try {
      const failureResult = await postMessageImpl({
        channel: slackTarget.channel,
        thread_ts: slackTarget.thread_ts,
        text: `Investigation failed: ${message}. Check server logs.`,
      });
      logIfFailed(failureResult, "failure");
    } catch (postErr) {
      // Even the failure-notification post must not escape as an
      // unhandled rejection.
      console.error(
        `slack poller: failed to post failure notification for investigation ${investigationId}: ${
          postErr instanceof Error ? postErr.message : String(postErr)
        }`,
      );
    }
  } finally {
    // Always clean up the polling interval, regardless of outcome, so it
    // never leaks.
    clearIntervalImpl(timer);
  }
}
