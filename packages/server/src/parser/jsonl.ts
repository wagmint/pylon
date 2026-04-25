import { readFileSync } from "fs";
import type { SessionEvent, Message, ContentBlock, TokenUsage } from "../types/index.js";

/**
 * Extract timestamp from the JSONL envelope.
 * Every Claude Code JSONL line has a top-level `timestamp` field (ISO 8601).
 */
function extractTimestamp(raw: unknown): Date | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.timestamp === "string") {
    const d = new Date(obj.timestamp);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Extract planContent from the JSONL envelope.
 * Claude Code stores the approved plan markdown as `planContent` on the user message envelope.
 */
function extractPlanContent(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.planContent === "string" && obj.planContent.length > 0) {
    return obj.planContent;
  }
  return null;
}

/**
 * Extract token usage from the JSONL envelope.
 * Claude Code stores usage on assistant message envelopes as `message.usage`.
 */
function extractUsageFromEnvelope(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // Usage may be at top level or inside message
  let usage: unknown = obj.usage;
  if (!usage && obj.message && typeof obj.message === "object") {
    usage = (obj.message as Record<string, unknown>).usage;
  }
  if (!usage || typeof usage !== "object") return null;

  const u = usage as Record<string, unknown>;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
    cacheReadInputTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
    cacheCreationInputTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
  };
}

/**
 * Extract model string from the JSONL envelope.
 */
function extractModelFromEnvelope(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.model === "string") return obj.model;
  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (typeof msg.model === "string") return msg.model;
  }
  return null;
}

/**
 * System metadata lines — parse turn_duration and other system lines.
 */
export interface SystemMeta {
  turnDurations: Array<{ timestamp: Date; durationMs: number }>;
}

export function parseSystemLinesFromContent(content: string): SystemMeta {
  const lines = content.split("\n");
  const turnDurations: Array<{ timestamp: Date; durationMs: number }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "system" && parsed.subtype === "turn_duration") {
        const ts = typeof parsed.timestamp === "string" ? new Date(parsed.timestamp) : null;
        const dur = typeof parsed.durationMs === "number" ? parsed.durationMs : null;
        if (ts && dur !== null) {
          turnDurations.push({ timestamp: ts, durationMs: dur });
        }
      }
    } catch { /* skip */ }
  }

  return { turnDurations };
}

export function parseSystemLines(filePath: string): SystemMeta {
  return parseSystemLinesFromContent(readFileSync(filePath, "utf-8"));
}

/**
 * Extract the session slug (e.g. "golden-soaring-hamster") from a JSONL file.
 * The slug appears on early envelope lines.
 */
export function parseSessionSlug(filePath: string): string | null {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  // Slug is typically in the first few lines
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (!lines[i].trim()) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed === "object" && parsed && typeof parsed.slug === "string") {
        return parsed.slug;
      }
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Parse a Claude Code session JSONL file into a stream of events.
 * Each line in the JSONL is a message event (user or assistant).
 */
export function parseSessionFileFromContent(content: string): SessionEvent[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  const events: SessionEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      const message = normalizeMessage(parsed);
      if (message) {
        const event: SessionEvent = { line: i, message };
        // Extract real timestamp from JSONL envelope
        const ts = extractTimestamp(parsed);
        if (ts) event.timestamp = ts;
        // Preserve planContent from JSONL envelope (set when user approves ExitPlanMode)
        const planContent = extractPlanContent(parsed);
        if (planContent) event.planContent = planContent;
        // Extract usage and model from envelope (before normalizeMessage strips it)
        const usage = extractUsageFromEnvelope(parsed);
        if (usage) event.usage = usage;
        const model = extractModelFromEnvelope(parsed);
        if (model) event.model = model;
        events.push(event);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

export function parseSessionFile(filePath: string): SessionEvent[] {
  return parseSessionFileFromContent(readFileSync(filePath, "utf-8"));
}

/**
 * Normalize various JSONL line formats into a standard Message.
 * Claude Code JSONL may contain different event shapes.
 */
function normalizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;

  // Standard message format: { role: "user"|"assistant", content: ... }
  if (obj.role && (obj.role === "user" || obj.role === "assistant")) {
    return {
      role: obj.role as "user" | "assistant",
      content: normalizeContent(obj.content),
    };
  }

  // Some JSONL formats wrap in a message field
  if (obj.message && typeof obj.message === "object") {
    return normalizeMessage(obj.message);
  }

  // Event wrapper format: { type: "message", message: { ... } }
  if (obj.type === "message" && obj.message) {
    return normalizeMessage(obj.message);
  }

  return null;
}

/**
 * Normalize content field which can be a string or array of content blocks.
 */
function normalizeContent(content: unknown): ContentBlock[] | string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content.filter(isValidContentBlock);
  }

  return [];
}

function isValidContentBlock(block: unknown): block is ContentBlock {
  if (!block || typeof block !== "object") return false;
  const obj = block as Record<string, unknown>;
  return (
    obj.type === "text" ||
    obj.type === "tool_use" ||
    obj.type === "tool_result" ||
    obj.type === "compaction" ||
    obj.type === "thinking"
  );
}

// ─── Extraction helpers ──────────────────────────────────────────────────────

/**
 * Get all text content from a message (concatenates all text blocks).
 */
export function getMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;

  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Get all tool_use blocks from a message.
 */
export function getToolCalls(
  message: Message
): Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> {
  if (typeof message.content === "string") return [];

  return message.content.filter(
    (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
      b.type === "tool_use"
  );
}

/**
 * Get all tool_result blocks from a message.
 * Normalizes content to string (some JSONL has content as array of text blocks).
 */
export function getToolResults(
  message: Message
): Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> {
  if (typeof message.content === "string") return [];

  return message.content
    .filter((b) => b.type === "tool_result")
    .map((b) => {
      const raw = b as unknown as Record<string, unknown>;
      let content: string;
      if (typeof raw.content === "string") {
        content = raw.content;
      } else if (Array.isArray(raw.content)) {
        content = (raw.content as Array<Record<string, unknown>>)
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
      } else {
        content = String(raw.content ?? "");
      }
      const result: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean } = {
        type: "tool_result" as const,
        tool_use_id: String(raw.tool_use_id ?? ""),
        content,
      };
      if (typeof raw.is_error === "boolean") {
        result.is_error = raw.is_error;
      }
      return result;
    });
}

/**
 * Check if a message contains a compaction block.
 */
export function hasCompaction(message: Message): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some((b) => b.type === "compaction");
}

/**
 * Get the compaction summary text if present.
 */
export function getCompactionText(message: Message): string | null {
  if (typeof message.content === "string") return null;

  const block = message.content.find(
    (b): b is { type: "compaction"; content: string } => b.type === "compaction"
  );

  return block?.content ?? null;
}

/**
 * Get all thinking block text from a message.
 */
export function getThinkingText(message: Message): string {
  if (typeof message.content === "string") return "";

  return message.content
    .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n");
}

/**
 * Get search patterns from Grep/Glob tool calls in a message.
 */
export function getSearchPatterns(
  message: Message
): string[] {
  if (typeof message.content === "string") return [];

  const patterns: string[] = [];
  const calls = getToolCalls(message);
  for (const call of calls) {
    if (call.name === "Grep" && typeof call.input.pattern === "string") {
      patterns.push(call.input.pattern);
    }
    if (call.name === "Glob" && typeof call.input.pattern === "string") {
      patterns.push(call.input.pattern);
    }
  }
  return patterns;
}

/**
 * Get basic stats about a parsed session.
 */
export function getSessionStats(events: SessionEvent[]) {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let compactions = 0;
  const toolsUsed = new Map<string, number>();

  for (const event of events) {
    if (event.message.role === "user") userMessages++;
    if (event.message.role === "assistant") assistantMessages++;

    const calls = getToolCalls(event.message);
    toolCalls += calls.length;
    for (const call of calls) {
      toolsUsed.set(call.name, (toolsUsed.get(call.name) ?? 0) + 1);
    }

    if (hasCompaction(event.message)) compactions++;
  }

  return {
    totalEvents: events.length,
    userMessages,
    assistantMessages,
    toolCalls,
    compactions,
    toolsUsed: Object.fromEntries(
      [...toolsUsed.entries()].sort((a, b) => b[1] - a[1])
    ),
  };
}
