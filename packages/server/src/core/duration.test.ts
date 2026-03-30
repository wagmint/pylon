import { describe, it, expect } from "vitest";
import { formatIdleDuration } from "./duration.js";

describe("formatIdleDuration", () => {
  it("returns 1m for 0ms (minimum clamp)", () => {
    expect(formatIdleDuration(0)).toBe("1m");
  });

  it("returns 1m for 30 seconds", () => {
    expect(formatIdleDuration(30_000)).toBe("1m");
  });

  it("returns 1m for exactly 60 seconds", () => {
    expect(formatIdleDuration(60_000)).toBe("1m");
  });

  it("returns 5m for 5 minutes", () => {
    expect(formatIdleDuration(5 * 60_000)).toBe("5m");
  });

  it("returns 59m for 59 minutes", () => {
    expect(formatIdleDuration(59 * 60_000)).toBe("59m");
  });

  it("returns 1h for 60 minutes", () => {
    expect(formatIdleDuration(60 * 60_000)).toBe("1h");
  });

  it("returns 2h for 90 minutes", () => {
    expect(formatIdleDuration(90 * 60_000)).toBe("2h");
  });

  it("returns 1d for 24 hours", () => {
    expect(formatIdleDuration(24 * 60 * 60_000)).toBe("1d");
  });

  it("returns 3d for 72 hours", () => {
    expect(formatIdleDuration(72 * 60 * 60_000)).toBe("3d");
  });
});
