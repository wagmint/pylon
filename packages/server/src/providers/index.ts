import { claudeAdapter } from "./claude/adapter.js";
import { codexAdapter } from "./codex/adapter.js";
import type { AgentProviderAdapter } from "./types.js";

export type {
  AgentProvider,
  AgentProviderAdapter,
  BusyIdleContext,
  CanonicalRawEvent,
  DiscoveryOpts,
  ParsedProviderSession,
  ProviderSessionRef,
  SessionLifecycle,
} from "./types.js";
export { toProviderSessionRef } from "./types.js";
export { claudeAdapter } from "./claude/adapter.js";
export { codexAdapter } from "./codex/adapter.js";

export const providerAdapters: AgentProviderAdapter[] = [
  claudeAdapter,
  codexAdapter,
];
