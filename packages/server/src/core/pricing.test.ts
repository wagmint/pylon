import { describe, it, expect } from "vitest";
import { getModelPricing, computeTurnCost, shortModelName } from "./pricing.js";
import type { TokenUsage } from "../types/index.js";

describe("getModelPricing", () => {
  it("returns default (Sonnet 4) pricing for null model", () => {
    const p = getModelPricing(null);
    expect(p.input).toBe(3e-6);
  });

  it("returns Opus pricing for claude-opus-4-6", () => {
    const p = getModelPricing("claude-opus-4-6");
    expect(p.input).toBe(15e-6);
    expect(p.output).toBe(75e-6);
  });

  it("returns Sonnet pricing for claude-sonnet-4", () => {
    const p = getModelPricing("claude-sonnet-4");
    expect(p.input).toBe(3e-6);
    expect(p.output).toBe(15e-6);
  });

  it("returns Haiku pricing for claude-haiku-4-5", () => {
    const p = getModelPricing("claude-haiku-4-5");
    expect(p.input).toBe(0.8e-6);
  });

  it("returns Codex pricing for gpt-5.1-codex", () => {
    const p = getModelPricing("gpt-5.1-codex");
    expect(p.input).toBe(1.25e-6);
    expect(p.output).toBe(10e-6);
  });

  it("returns Codex Mini pricing for gpt-5.1-codex-mini", () => {
    const p = getModelPricing("gpt-5.1-codex-mini");
    expect(p.input).toBe(0.25e-6);
  });

  it("returns o3-pro pricing", () => {
    const p = getModelPricing("o3-pro");
    expect(p.input).toBe(20e-6);
    expect(p.output).toBe(80e-6);
  });

  it("returns default pricing for unknown model", () => {
    const p = getModelPricing("totally-unknown-model");
    expect(p.input).toBe(3e-6); // Sonnet 4 default
  });

  it("is case-insensitive", () => {
    const p = getModelPricing("Claude-Opus-4-6");
    expect(p.input).toBe(15e-6);
  });

  it("matches by prefix — claude-sonnet-4-20250514 matches claude-sonnet-4", () => {
    const p = getModelPricing("claude-sonnet-4-20250514");
    expect(p.input).toBe(3e-6);
  });
});

describe("computeTurnCost", () => {
  const zeroUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  it("returns 0 for zero tokens", () => {
    expect(computeTurnCost("claude-sonnet-4", zeroUsage)).toBe(0);
  });

  it("computes cost correctly for Sonnet 4 with typical usage", () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 0,
    };
    // 1000 * 3e-6 + 500 * 15e-6 + 2000 * 0.3e-6 + 0
    // = 0.003 + 0.0075 + 0.0006 = 0.0111
    const cost = computeTurnCost("claude-sonnet-4", usage);
    expect(cost).toBeCloseTo(0.0111, 6);
  });

  it("computes cost correctly for Opus with heavy cache read", () => {
    const usage: TokenUsage = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 0,
    };
    // 500 * 15e-6 + 200 * 75e-6 + 100000 * 1.5e-6
    // = 0.0075 + 0.015 + 0.15 = 0.1725
    const cost = computeTurnCost("claude-opus-4-6", usage);
    expect(cost).toBeCloseTo(0.1725, 6);
  });

  it("uses default pricing for null model", () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const cost = computeTurnCost(null, usage);
    expect(cost).toBeCloseTo(1000 * 3e-6, 10);
  });
});

describe("shortModelName", () => {
  it("maps claude-opus-4-6 to Opus 4.6", () => {
    expect(shortModelName("claude-opus-4-6")).toBe("Opus 4.6");
  });

  it("maps claude-sonnet-4-20250514 to Sonnet 4", () => {
    expect(shortModelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
  });

  it("maps claude-sonnet-3-5-xxx to Sonnet 3.5", () => {
    expect(shortModelName("claude-sonnet-3-5-20241022")).toBe("Sonnet 3.5");
  });

  it("maps claude-sonnet-3.5-xxx to Sonnet 3.5 (dot variant)", () => {
    expect(shortModelName("claude-sonnet-3.5-20241022")).toBe("Sonnet 3.5");
  });

  it("maps claude-haiku-4-5 to Haiku 4.5", () => {
    expect(shortModelName("claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("maps gpt-5.1-codex to Codex 5.1", () => {
    expect(shortModelName("gpt-5.1-codex")).toBe("Codex 5.1");
  });

  it("maps gpt-5.1-codex-mini to Codex Mini 5.1", () => {
    expect(shortModelName("gpt-5.1-codex-mini")).toBe("Codex Mini 5.1");
  });

  it("maps codex-mini to Codex Mini", () => {
    expect(shortModelName("codex-mini")).toBe("Codex Mini");
  });

  it("maps o3-pro to o3-pro", () => {
    expect(shortModelName("o3-pro")).toBe("o3-pro");
  });

  it("maps gpt-4.1-mini to GPT-4.1 Mini", () => {
    expect(shortModelName("gpt-4.1-mini")).toBe("GPT-4.1 Mini");
  });

  it("returns original string for unknown model", () => {
    expect(shortModelName("my-custom-model")).toBe("my-custom-model");
  });

  it("is case-insensitive", () => {
    expect(shortModelName("Claude-Opus-4-6")).toBe("Opus 4.6");
  });
});
