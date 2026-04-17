import { describe, expect, it } from "vitest";
import { providerAdapters } from "./index.js";

describe("providerAdapters", () => {
  it("registers every provider with a unique provider id", () => {
    const providers = providerAdapters.map((adapter) => adapter.provider);

    expect(providers).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(new Set(providers).size).toBe(providers.length);
  });
});
