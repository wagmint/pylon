import { describe, it, expect } from "vitest";
import { operatorId, getOperatorColor } from "./config.js";

describe("operatorId", () => {
  it("lowercases the name", () => {
    expect(operatorId("Alice")).toBe("op-alice");
  });

  it("replaces spaces with hyphens", () => {
    expect(operatorId("Alice Smith")).toBe("op-alice-smith");
  });

  it("replaces special characters with hyphens", () => {
    expect(operatorId("alice@corp.com")).toBe("op-alice-corp-com");
  });

  it("handles simple alphanumeric name", () => {
    expect(operatorId("bob42")).toBe("op-bob42");
  });

  it("always prefixes with op-", () => {
    expect(operatorId("x")).toBe("op-x");
  });
});

describe("getOperatorColor", () => {
  it("returns green for index 0", () => {
    expect(getOperatorColor(0)).toBe("#4ADE80");
  });

  it("returns blue for index 1", () => {
    expect(getOperatorColor(1)).toBe("#60A5FA");
  });

  it("returns purple for index 2", () => {
    expect(getOperatorColor(2)).toBe("#A78BFA");
  });

  it("wraps around after palette length", () => {
    expect(getOperatorColor(8)).toBe("#4ADE80"); // same as index 0
  });

  it("wraps correctly for large index", () => {
    expect(getOperatorColor(9)).toBe("#60A5FA"); // same as index 1
  });
});
