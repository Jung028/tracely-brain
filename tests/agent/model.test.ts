import { afterEach, describe, expect, test } from "bun:test";
import { resolveModel } from "../../src/agent/model";

const REAL_MODEL_ENV = process.env.INVESTIGATION_AGENT_MODEL;

afterEach(() => {
  if (REAL_MODEL_ENV === undefined) {
    delete process.env.INVESTIGATION_AGENT_MODEL;
  } else {
    process.env.INVESTIGATION_AGENT_MODEL = REAL_MODEL_ENV;
  }
});

describe("resolveModel", () => {
  test("defaults to claude-opus-5 when INVESTIGATION_AGENT_MODEL is unset", () => {
    delete process.env.INVESTIGATION_AGENT_MODEL;
    expect(resolveModel()).toBe("claude-opus-5");
  });

  test("uses INVESTIGATION_AGENT_MODEL when set to a known model", () => {
    process.env.INVESTIGATION_AGENT_MODEL = "claude-sonnet-5";
    expect(resolveModel()).toBe("claude-sonnet-5");
  });

  test("throws on an unknown model id", () => {
    process.env.INVESTIGATION_AGENT_MODEL = "gpt-4o";
    expect(() => resolveModel()).toThrow(/Unknown INVESTIGATION_AGENT_MODEL/);
  });
});
