import { describe, expect, it } from "vitest";
import type { AgentProviderAdapter, ProviderSessionRef } from "./types.js";

export interface ProviderAdapterContractFixture {
  name: string;
  adapter: AgentProviderAdapter;
  discover: () => Promise<ProviderSessionRef[]>;
}

export function describeProviderAdapterContract(
  fixture: ProviderAdapterContractFixture,
): void {
  describe(`${fixture.name} provider adapter contract`, () => {
    it("discovers provider-aware session refs with source provenance", async () => {
      const sessions = await fixture.discover();

      expect(sessions.length).toBeGreaterThan(0);
      for (const session of sessions) {
        expect(session.provider).toBe(fixture.adapter.provider);
        expect(session.sourcePath).toBe(session.path);
        expect(session.sourceMtime).toBeInstanceOf(Date);
        expect(session.sourceSizeBytes).toBe(session.sizeBytes);
      }
    });

    it("parses discovered sessions into canonical parsed sessions", async () => {
      const sessions = await fixture.discover();
      expect(sessions.length).toBeGreaterThan(0);

      const result = await fixture.adapter.parseSession(sessions[0]);

      expect(result.parsed.session.id).toBe(sessions[0].id);
      expect(result.parsed.turns.length).toBeGreaterThan(0);
      expect(Array.isArray(result.rawEvents)).toBe(true);
      expect(result.providerMetadata).toEqual(expect.any(Object));
    });
  });
}
