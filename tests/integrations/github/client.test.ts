// Tests for the GitHub API client's connection/auth/classification behavior
// (module 02, Task 1). A mix of live calls against the real
// `Jung028/tracely-brain` repo (using the real PAT loaded from .env.test)
// and injected-fetch tests for the failure modes that can't be reliably
// triggered against the live API (insufficient permissions, network
// unavailability).
import { afterEach, describe, expect, test } from "bun:test";
import {
  getFileContent,
  getRepo,
  getTreeRecursive,
} from "../../../src/integrations/github/client";
import type { GitHubTreeEntry } from "../../../src/integrations/github/types";

// GITHUB_TOKEN is loaded from .env.test by Bun before this file runs. Save
// it once so every test that mutates process.env.GITHUB_TOKEN can restore
// it afterwards, regardless of how the test exits.
const REAL_TOKEN = process.env.GITHUB_TOKEN;

afterEach(() => {
  if (REAL_TOKEN === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = REAL_TOKEN;
  }
});

describe("getRepo", () => {
  test("not connected: returns status not_connected with no network call when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN;

    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("fetchImpl should never be called when not connected");
    }) as unknown as typeof fetch;

    const result = await getRepo("Jung028", "tracely-brain", { fetchImpl });

    expect(result).toEqual({ status: "not_connected" });
    expect(called).toBe(false);
  });

  test("auth expired: live 401 with a deliberately invalid token", async () => {
    process.env.GITHUB_TOKEN = "ghp_deliberately_invalid_token_0000000000";

    const result = await getRepo("Jung028", "tracely-brain");

    expect(result).toMatchObject({ status: "auth_expired" });
    if ("ok" in result || result.status !== "auth_expired") {
      throw new Error("unreachable");
    }
    expect(typeof result.detail).toBe("string");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  test("query failed: live 404 for a repo that does not exist", async () => {
    const result = await getRepo("Jung028", "this-repo-does-not-exist-12345");

    expect(result).toMatchObject({ status: "query_failed" });
  });

  test("insufficient permissions: injected 403 without a rate-limit header", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ message: "Must have admin rights to Repository." }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;

    const result = await getRepo("Jung028", "tracely-brain", { fetchImpl });

    expect(result).toMatchObject({
      status: "insufficient_permissions",
      detail: "Must have admin rights to Repository.",
    });
  });

  test("unavailable: injected fetch throws (network failure)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await getRepo("Jung028", "tracely-brain", { fetchImpl });

    expect(result).toMatchObject({ status: "unavailable", detail: "ECONNREFUSED" });
  });

  test("unavailable: injected 403 with x-ratelimit-remaining: 0 is distinguished from insufficient_permissions", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "0",
        },
      })) as unknown as typeof fetch;

    const result = await getRepo("Jung028", "tracely-brain", { fetchImpl });

    expect(result).toEqual({ status: "unavailable", detail: "rate limited" });
  });

  test("happy path: live getRepo returns ok with the repo's full_name", async () => {
    const result = await getRepo("Jung028", "tracely-brain");

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result) || !result.ok) throw new Error("unreachable");
    const data = result.data as { full_name?: string };
    expect(data.full_name).toBe("Jung028/tracely-brain");
  });
});

describe("getTreeRecursive", () => {
  test("happy path: live tree contains known files from this repo", async () => {
    const repoResult = await getRepo("Jung028", "tracely-brain");
    expect("ok" in repoResult && repoResult.ok).toBe(true);
    if (!("ok" in repoResult) || !repoResult.ok) throw new Error("unreachable");
    const repoData = repoResult.data as { default_branch: string };

    const treeResult = await getTreeRecursive(
      "Jung028",
      "tracely-brain",
      repoData.default_branch,
    );

    expect("ok" in treeResult && treeResult.ok).toBe(true);
    if (!("ok" in treeResult) || !treeResult.ok) throw new Error("unreachable");

    const paths = treeResult.data.map((entry: GitHubTreeEntry) => entry.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("CLAUDE.md");
  });

  test("not connected: returns status not_connected with no network call when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN;

    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("fetchImpl should never be called when not connected");
    }) as unknown as typeof fetch;

    const result = await getTreeRecursive("Jung028", "tracely-brain", "main", {
      fetchImpl,
    });

    expect(result).toEqual({ status: "not_connected" });
    expect(called).toBe(false);
  });

  test("malformed response: injected 200 body with no tree array -> query_failed, not a silent empty sync", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sha: "abc123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await getTreeRecursive("Jung028", "tracely-brain", "main", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });

  test("malformed response: injected 200 body where tree is not an array -> query_failed", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tree: "not-an-array" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await getTreeRecursive("Jung028", "tracely-brain", "main", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });

  test("truncated response: injected 200 body with truncated: true -> query_failed, not a partial silent sync", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          tree: [{ path: "a.txt", type: "blob", sha: "deadbeef" }],
          truncated: true,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch;

    const result = await getTreeRecursive("Jung028", "tracely-brain", "main", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });
});

describe("getFileContent", () => {
  test("happy path: live blob fetch decodes base64 content for a known file", async () => {
    const repoResult = await getRepo("Jung028", "tracely-brain");
    expect("ok" in repoResult && repoResult.ok).toBe(true);
    if (!("ok" in repoResult) || !repoResult.ok) throw new Error("unreachable");
    const repoData = repoResult.data as { default_branch: string };

    const treeResult = await getTreeRecursive(
      "Jung028",
      "tracely-brain",
      repoData.default_branch,
    );
    expect("ok" in treeResult && treeResult.ok).toBe(true);
    if (!("ok" in treeResult) || !treeResult.ok) throw new Error("unreachable");

    const packageJson = treeResult.data.find((e) => e.path === "package.json");
    if (!packageJson) throw new Error("package.json not found in tree");

    const result = await getFileContent("Jung028", "tracely-brain", packageJson.sha);

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result) || !result.ok) throw new Error("unreachable");
    expect(result.data.content).toContain("tracely-brain");
    expect(result.data.sha).toBe(packageJson.sha);
  });

  test("not connected: returns status not_connected with no network call when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN;

    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("fetchImpl should never be called when not connected");
    }) as unknown as typeof fetch;

    const result = await getFileContent("Jung028", "tracely-brain", "deadbeef", {
      fetchImpl,
    });

    expect(result).toEqual({ status: "not_connected" });
    expect(called).toBe(false);
  });

  test("malformed response: injected 200 body with non-string content -> query_failed", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ sha: "deadbeef", encoding: "base64" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await getFileContent("Jung028", "tracely-brain", "deadbeef", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });

  test("unsupported encoding: injected 200 body with a non-base64 encoding -> query_failed, not silently mis-decoded", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ sha: "deadbeef", content: "plain text", encoding: "utf-8" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await getFileContent("Jung028", "tracely-brain", "deadbeef", {
      fetchImpl,
    });

    expect(result).toMatchObject({ status: "query_failed" });
  });
});
