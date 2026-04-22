import type { SuggestionPayload } from "./types.js";

export interface StoredSuggestion {
  hexcoreId: string;
  suggestion: SuggestionPayload;
  /** Set when the operator has responded. Kept until hexcore confirms resolution. */
  respondedAt: string | null;
}

class SuggestionStore {
  private suggestions = new Map<string, StoredSuggestion>();

  upsert(hexcoreId: string, suggestion: SuggestionPayload): void {
    const existing = this.suggestions.get(suggestion.id);
    this.suggestions.set(suggestion.id, {
      hexcoreId,
      suggestion,
      respondedAt: existing?.respondedAt ?? null,
    });
  }

  /** Mark a suggestion as responded (user acted). Does not remove from store. */
  markResponded(id: string): void {
    const entry = this.suggestions.get(id);
    if (entry) {
      entry.respondedAt = new Date().toISOString();
    }
  }

  /** Clear respondedAt to unlock retry after hexcore rejected the response. */
  clearResponded(id: string): void {
    const entry = this.suggestions.get(id);
    if (entry) {
      entry.respondedAt = null;
    }
  }

  remove(id: string): void {
    this.suggestions.delete(id);
  }

  removeMany(ids: string[]): void {
    for (const id of ids) {
      this.suggestions.delete(id);
    }
  }

  /** All suggestions, including those awaiting hexcore confirmation. */
  getAll(): StoredSuggestion[] {
    return [...this.suggestions.values()];
  }

  /** Only suggestions the operator has not yet responded to. */
  getPending(): StoredSuggestion[] {
    return [...this.suggestions.values()].filter((s) => s.respondedAt === null);
  }

  getById(id: string): StoredSuggestion | undefined {
    return this.suggestions.get(id);
  }

  get count(): number {
    return this.suggestions.size;
  }
}

export const suggestionStore = new SuggestionStore();
