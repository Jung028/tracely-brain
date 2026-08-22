// Low-level GitHub REST API client: connection, auth, response
// classification. Read-only — every request in this file is a GET. No write
// (POST/PATCH/DELETE) call to GitHub exists here, and none should ever be
// added (see the module plan's "GitHub access is read-only" constraint).
//
// Every "expected" failure mode (not connected, expired auth, insufficient
// permissions, source unavailable, query failure) resolves to a typed
// `ConnectionFailure` value — nothing in this file throws for those cases.
// Only a genuinely unexpected bug (e.g. a programming error) is allowed to
// propagate as an exception.
import type { ConnectionFailure, GitHubTreeEntry } from "./types";

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubFetchOptions {
  /**
   * Injectable fetch implementation, defaulting to the global `fetch`.
   * Exists purely so tests can simulate responses (network failure,
   * malformed body, non-rate-limit 403) that can't be reliably triggered
   * against the live API.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Reads the GitHub token from the environment. Returns `null` if unset or
 * empty, which is what lets callers detect "not connected" before making
 * any network call.
 */
export function getGitHubToken(): string | null {
  const token = process.env.GITHUB_TOKEN;
  return token && token.length > 0 ? token : null;
}

/** Best-effort extraction of GitHub's `{ "message": "..." }` error body shape. */
async function readErrorBody(
  response: Response,
): Promise<{ raw: string; message?: string }> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { raw: "" };
  }

  if (!raw) {
    return { raw };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
    ) {
      return { raw, message: (parsed as { message: string }).message };
    }
  } catch {
    // Body wasn't JSON — fall through and use the raw text.
  }

  return { raw };
}

/**
 * Classifies a non-ok GitHub `Response` into a typed `ConnectionFailure`.
 * Returns `null` if the response is ok (2xx) — the caller then proceeds to
 * read the body itself.
 */
export async function classifyGitHubResponse(
  response: Response,
): Promise<ConnectionFailure | null> {
  if (response.ok) {
    return null;
  }

  if (response.status === 401) {
    const { message } = await readErrorBody(response);
    return { status: "auth_expired", detail: message ?? response.statusText };
  }

  if (response.status === 403) {
    // GitHub returns 403 for both "rate limited" and "insufficient
    // permissions" — the `x-ratelimit-remaining: 0` header is the only
    // reliable discriminator. Rate limiting is transient/retryable
    // (unavailable); a genuine permissions denial is not.
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      return { status: "unavailable", detail: "rate limited" };
    }
    const { message, raw } = await readErrorBody(response);
    return {
      status: "insufficient_permissions",
      detail: message ?? raw ?? response.statusText,
    };
  }

  if (response.status === 404) {
    return { status: "query_failed", detail: `not found: ${response.url}` };
  }

  const { raw } = await readErrorBody(response);
  return { status: "query_failed", detail: `${response.status} ${raw}` };
}

/**
 * Shared GET + auth + classify + JSON-parse plumbing used by both
 * `getRepo` and `getTreeRecursive`.
 */
async function fetchGitHubJson(
  url: string,
  opts?: GitHubFetchOptions,
): Promise<{ ok: true; data: unknown } | ConnectionFailure> {
  const token = getGitHubToken();
  if (!token) {
    return { status: "not_connected" };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
  } catch (err) {
    return {
      status: "unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const failure = await classifyGitHubResponse(response);
  if (failure) {
    return failure;
  }

  try {
    const data: unknown = await response.json();
    return { ok: true, data };
  } catch (err) {
    return {
      status: "query_failed",
      detail: `malformed response body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * GET /repos/{owner}/{repo}
 */
export async function getRepo(
  owner: string,
  repo: string,
  opts?: GitHubFetchOptions,
): Promise<{ ok: true; data: unknown } | ConnectionFailure> {
  return fetchGitHubJson(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, opts);
}

/**
 * GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 */
export async function getTreeRecursive(
  owner: string,
  repo: string,
  sha: string,
  opts?: GitHubFetchOptions,
): Promise<{ ok: true; data: GitHubTreeEntry[] } | ConnectionFailure> {
  const result = await fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    opts,
  );

  if (!("ok" in result)) {
    return result;
  }

  const rawData = result.data as { tree?: unknown; truncated?: unknown } | null;
  const rawTree = rawData?.tree;

  if (!Array.isArray(rawTree)) {
    return {
      status: "query_failed",
      detail: "malformed tree response: missing tree array",
    };
  }

  if (rawData?.truncated === true) {
    return {
      status: "query_failed",
      detail:
        "tree truncated by GitHub; repo too large for a single tree fetch",
    };
  }

  const entries: GitHubTreeEntry[] = rawTree.map((entry) => {
    const e = entry as {
      path: string;
      type: "blob" | "tree";
      sha: string;
      size?: number;
    };
    return {
      path: e.path,
      type: e.type,
      sha: e.sha,
      ...(typeof e.size === "number" ? { size: e.size } : {}),
    };
  });

  return { ok: true, data: entries };
}

/**
 * GET /repos/{owner}/{repo}/git/blobs/{sha}
 *
 * Returns decoded UTF-8 text content for a blob. GitHub's blob API always
 * returns `encoding: "base64"` for the git blobs endpoint in practice, but
 * this is validated rather than assumed — an unexpected encoding value
 * resolves to `query_failed` instead of silently mis-decoding (matches the
 * malformed-tree-response precedent in getTreeRecursive above).
 */
export async function getFileContent(
  owner: string,
  repo: string,
  sha: string,
  opts?: GitHubFetchOptions,
): Promise<{ ok: true; data: { content: string; sha: string } } | ConnectionFailure> {
  const result = await fetchGitHubJson(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`,
    opts,
  );

  if (!("ok" in result)) {
    return result;
  }

  const rawData = result.data as
    | { content?: unknown; encoding?: unknown; sha?: unknown }
    | null;

  if (typeof rawData?.content !== "string") {
    return {
      status: "query_failed",
      detail: "malformed blob response: missing content string",
    };
  }

  if (rawData.encoding !== "base64") {
    return {
      status: "query_failed",
      detail: `unsupported blob encoding: ${JSON.stringify(rawData.encoding)}`,
    };
  }

  return {
    ok: true,
    data: {
      content: Buffer.from(rawData.content, "base64").toString("utf-8"),
      sha: typeof rawData.sha === "string" ? rawData.sha : sha,
    },
  };
}
