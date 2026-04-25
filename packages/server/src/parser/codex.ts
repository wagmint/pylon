import { readFileSync, openSync, readSync, closeSync } from "fs";

// ─── Codex Event Types ──────────────────────────────────────────────────────

export type CodexEvent =
  | { type: "session_meta"; line: number; timestamp: Date; id: string; cwd: string; source: string; model?: string; gitBranch?: string }
  | { type: "turn_started"; line: number; timestamp: Date }
  | { type: "turn_complete"; line: number; timestamp: Date }
  | { type: "turn_aborted"; line: number; timestamp: Date; reason: string }
  | { type: "user_message"; line: number; timestamp: Date; text: string }
  | { type: "agent_message"; line: number; timestamp: Date; text: string }
  | { type: "agent_reasoning"; line: number; timestamp: Date; text: string }
  | { type: "exec_command"; line: number; timestamp: Date; command: string[]; exitCode: number; status: string }
  | { type: "patch_apply"; line: number; timestamp: Date; files: string[]; success: boolean }
  | { type: "web_search"; line: number; timestamp: Date; query: string; action: string }
  | { type: "view_image"; line: number; timestamp: Date; path: string }
  | {
      type: "token_count";
      line: number;
      timestamp: Date;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      modelContextWindow: number | null;
    }
  | { type: "compaction"; line: number; timestamp: Date; summary: string }
  | { type: "error"; line: number; timestamp: Date; message: string }
  | { type: "shutdown"; line: number; timestamp: Date };

// ─── Parsing ────────────────────────────────────────────────────────────────

/**
 * Parse a Codex rollout JSONL file into typed events.
 *
 * Codex rollout lines have the shape:
 *   { "timestamp": "...", "type": "session_meta"|"event_msg"|"response_item"|"compacted"|"turn_context", "payload": { ... } }
 */
export function parseCodexSessionFileFromContent(content: string): CodexEvent[] {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const events: CodexEvent[] = [];
  // Track pending function_call / custom_tool_call by call_id for pairing with outputs
  const pendingCalls = new Map<string, { name: string; args: unknown; line: number; ts: Date }>();

  for (let i = 0; i < lines.length; i++) {
    try {
      const raw = JSON.parse(lines[i]);
      const result = parseCodexLine(raw, i, pendingCalls);
      if (result) events.push(result);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

export function parseCodexSessionFile(filePath: string): CodexEvent[] {
  return parseCodexSessionFileFromContent(readFileSync(filePath, "utf-8"));
}

/**
 * Read only the first line of a Codex session file to extract session metadata.
 * Used by discovery to get cwd/id without parsing the entire file.
 */
export function readCodexSessionMeta(filePath: string): { id: string; cwd: string } | null {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const newlineIdx = chunk.indexOf("\n");
    // If the first line fits in 4KB, use it; otherwise fall back to full read
    const firstLine = newlineIdx >= 0
      ? chunk.slice(0, newlineIdx)
      : (bytesRead < 4096 ? chunk : readFileSync(filePath, "utf-8").split("\n")[0]);
    if (!firstLine.trim()) return null;

    const raw = JSON.parse(firstLine);
    if (raw.type === "session_meta" && raw.payload) {
      const p = raw.payload;
      // Fields are at payload top level (not nested under payload.meta)
      const id = typeof p.id === "string" ? p.id : null;
      const cwd = typeof p.cwd === "string" ? p.cwd : null;
      if (id && cwd) return { id, cwd };
    }
  } catch {
    // Unreadable or malformed
  }
  return null;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function parseTimestamp(raw: unknown): Date {
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

function parseCodexLine(
  raw: unknown,
  line: number,
  pendingCalls: Map<string, { name: string; args: unknown; line: number; ts: Date }>,
): CodexEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const ts = parseTimestamp(obj.timestamp);
  const type = obj.type;
  const payload = (obj.payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case "session_meta":
      return parseSessionMeta(payload, line, ts);
    case "event_msg":
      return parseEventMsg(payload, line, ts);
    case "response_item":
      return parseResponseItem(payload, line, ts, pendingCalls);
    case "compacted":
      return parseCompacted(payload, line, ts);
    case "turn_context":
      // Extract model from turn_context if present, emit as session_meta update
      if (typeof payload.model === "string") {
        return {
          type: "session_meta", line, timestamp: ts,
          id: "", cwd: "", source: "codex",
          model: payload.model,
        };
      }
      return null;
    default:
      return null;
  }
}

function parseSessionMeta(payload: Record<string, unknown>, line: number, ts: Date): CodexEvent | null {
  // Fields are at payload top level (not nested under payload.meta)
  const id = typeof payload.id === "string" ? payload.id : null;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const source = typeof payload.source === "string" ? payload.source : "codex";

  if (!id) return null;

  const event: CodexEvent = { type: "session_meta", line, timestamp: ts, id, cwd, source };

  // Model may be at payload.model or in turn_context
  const model = typeof payload.model === "string" ? payload.model : undefined;
  if (model) (event as Extract<CodexEvent, { type: "session_meta" }>).model = model;

  // Git branch may be nested under payload.git
  const git = (payload.git ?? {}) as Record<string, unknown>;
  const branch = typeof git.branch === "string" ? git.branch : undefined;
  if (branch) (event as Extract<CodexEvent, { type: "session_meta" }>).gitBranch = branch;

  return event;
}

function parseEventMsg(payload: Record<string, unknown>, line: number, ts: Date): CodexEvent | null {
  const subType = payload.type;

  switch (subType) {
    // Codex uses task_started/task_complete (not turn_started/turn_complete)
    case "turn_started":
    case "task_started":
      return { type: "turn_started", line, timestamp: ts };

    case "turn_complete":
    case "task_complete":
      return { type: "turn_complete", line, timestamp: ts };

    case "user_message": {
      const text = extractText(payload);
      return { type: "user_message", line, timestamp: ts, text };
    }

    case "agent_message": {
      const text = extractText(payload);
      return { type: "agent_message", line, timestamp: ts, text };
    }
    case "agent_reasoning": {
      const text = typeof payload.text === "string" ? payload.text : extractText(payload);
      if (!text.trim()) return null;
      return { type: "agent_reasoning", line, timestamp: ts, text };
    }
    case "turn_aborted": {
      const reason = typeof payload.reason === "string" ? payload.reason : "interrupted";
      return { type: "turn_aborted", line, timestamp: ts, reason };
    }

    case "exec_command_end": {
      const command = extractStringArray(payload.command ?? payload.args);
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : (typeof payload.exitCode === "number" ? payload.exitCode : 0);
      const status = typeof payload.status === "string" ? payload.status : (exitCode === 0 ? "success" : "error");
      return { type: "exec_command", line, timestamp: ts, command, exitCode, status };
    }

    case "patch_apply_end": {
      const files = extractStringArray(payload.files ?? payload.paths);
      const success = payload.success !== false && payload.status !== "error";
      return { type: "patch_apply", line, timestamp: ts, files, success: Boolean(success) };
    }

    case "token_count": {
      // Token data nested in payload.info
      // IMPORTANT: total_token_usage is CUMULATIVE — use last_token_usage for per-request delta
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const usage = (info.last_token_usage ?? {}) as Record<string, unknown>;
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens
        : typeof payload.input_tokens === "number" ? payload.input_tokens : 0;
      const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens
        : typeof payload.output_tokens === "number" ? payload.output_tokens : 0;
      const cachedInputTokens = typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens
        : typeof payload.cached_input_tokens === "number" ? payload.cached_input_tokens : 0;
      const modelContextWindow = typeof info.model_context_window === "number" ? info.model_context_window : null;
      // Skip events with no actual usage data (rate-limit-only events where info is null)
      if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) return null;
      return {
        type: "token_count",
        line,
        timestamp: ts,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        modelContextWindow,
      };
    }

    case "context_compacted": {
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      return { type: "compaction", line, timestamp: ts, summary };
    }

    case "error": {
      const message = typeof payload.message === "string" ? payload.message
        : typeof payload.error === "string" ? payload.error : "Unknown error";
      return { type: "error", line, timestamp: ts, message };
    }

    case "shutdown_complete":
      return { type: "shutdown", line, timestamp: ts };

    default:
      return null;
  }
}

function parseResponseItem(
  payload: Record<string, unknown>,
  line: number,
  ts: Date,
  pendingCalls: Map<string, { name: string; args: unknown; line: number; ts: Date }>,
): CodexEvent | null {
  const itemType = payload.type ?? payload.item_type;

  // Message response item — role + content
  if (itemType === "Message" || itemType === "message") {
    const role = payload.role;
    // Skip developer/system messages (context setup, not conversation)
    if (role === "developer" || role === "system") return null;
    const text = extractText(payload);
    // Skip empty messages (context replay artifacts)
    if (!text.trim()) return null;
    if (role === "user") {
      return { type: "user_message", line, timestamp: ts, text };
    }
    return { type: "agent_message", line, timestamp: ts, text };
  }

  if (itemType === "web_search_call") {
    const actionObj = (payload.action ?? {}) as Record<string, unknown>;
    const action = typeof actionObj.type === "string" ? actionObj.type : "search";
    const query =
      typeof payload.query === "string" ? payload.query
      : typeof payload.text === "string" ? payload.text
      : "web search";
    return { type: "web_search", line, timestamp: ts, query, action };
  }

  // LocalShellCall — command execution (older Codex format)
  if (itemType === "LocalShellCall" || itemType === "local_shell_call") {
    const command = extractStringArray(payload.command ?? payload.args);
    const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : (typeof payload.exitCode === "number" ? payload.exitCode : 0);
    const status = typeof payload.status === "string" ? payload.status : (exitCode === 0 ? "success" : "error");
    return { type: "exec_command", line, timestamp: ts, command, exitCode, status };
  }

  // function_call — newer Codex format: exec_command, write_stdin, etc.
  // Store in pendingCalls; event is emitted when the matching function_call_output arrives.
  if (itemType === "function_call") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const name = typeof payload.name === "string" ? payload.name : "";
    if (name === "view_image") {
      const args = typeof payload.arguments === "string" ? tryParseJson(payload.arguments) : payload.arguments;
      const argObj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const path = typeof argObj.path === "string" ? argObj.path : "";
      return { type: "view_image", line, timestamp: ts, path };
    }
    if (callId && (name === "exec_command" || name === "write_stdin")) {
      const args = typeof payload.arguments === "string" ? tryParseJson(payload.arguments) : payload.arguments;
      pendingCalls.set(callId, { name, args, line, ts });
    }
    return null;
  }

  // function_call_output — pair with pending function_call to emit exec_command
  if (itemType === "function_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (!callId) return null;
    const pending = pendingCalls.get(callId);
    if (!pending) return null;
    pendingCalls.delete(callId);

    if (pending.name === "exec_command") {
      const args = (pending.args ?? {}) as Record<string, unknown>;
      const cmd = typeof args.cmd === "string" ? args.cmd : "";
      const outputText = typeof payload.output === "string" ? payload.output : "";
      const exitCode = extractExitCode(outputText);
      return {
        type: "exec_command", line: pending.line, timestamp: pending.ts,
        command: [cmd],
        exitCode,
        status: exitCode === 0 ? "success" : "error",
      };
    }
    // write_stdin doesn't produce a separate event
    return null;
  }

  // custom_tool_call — apply_patch (file edits)
  if (itemType === "custom_tool_call") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    const name = typeof payload.name === "string" ? payload.name : "";
    if (callId && name === "apply_patch") {
      const input = typeof payload.input === "string" ? payload.input : "";
      pendingCalls.set(callId, { name, args: input, line, ts });
    }
    return null;
  }

  // custom_tool_call_output — pair with pending apply_patch to emit patch_apply
  if (itemType === "custom_tool_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : null;
    if (!callId) return null;
    const pending = pendingCalls.get(callId);
    if (!pending) return null;
    pendingCalls.delete(callId);

    if (pending.name === "apply_patch") {
      const outputRaw = typeof payload.output === "string" ? tryParseJson(payload.output) : payload.output;
      const outputObj = (outputRaw && typeof outputRaw === "object" ? outputRaw : {}) as Record<string, unknown>;
      const outputText = typeof outputObj.output === "string" ? outputObj.output : (typeof payload.output === "string" ? payload.output : "");
      const meta = (outputObj.metadata ?? {}) as Record<string, unknown>;
      const exitCode = typeof meta.exit_code === "number" ? meta.exit_code : 0;
      const success = exitCode === 0 && /success/i.test(outputText);
      const files = extractPatchFiles(pending.args as string, outputText);
      return {
        type: "patch_apply", line: pending.line, timestamp: pending.ts,
        files,
        success,
      };
    }
    return null;
  }

  // Compaction response item
  if (itemType === "Compaction" || itemType === "compaction") {
    const summary = typeof payload.summary === "string" ? payload.summary : "";
    return { type: "compaction", line, timestamp: ts, summary };
  }

  return null;
}

function parseCompacted(payload: Record<string, unknown>, line: number, ts: Date): CodexEvent {
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  return { type: "compaction", line, timestamp: ts, summary };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractText(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;

  // Content may be an array of text blocks (same as Claude)
  if (Array.isArray(payload.content)) {
    return (payload.content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  }

  if (typeof payload.message === "string") return payload.message;
  return "";
}

function extractStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") return [value];
  return [];
}

function tryParseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/** Extract exit code from function_call_output text like "Process exited with code 0" */
function extractExitCode(output: string): number {
  const match = output.match(/Process exited with code (\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Extract file paths from apply_patch input/output.
 *  Input contains "*** Update File: /path/to/file" lines.
 *  Output contains "M /path/to/file" lines. */
function extractPatchFiles(patchInput: string, outputText: string): string[] {
  const files = new Set<string>();
  // From patch input: *** Update File: /path, *** Add File: /path, *** Delete File: /path
  for (const match of patchInput.matchAll(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)/g)) {
    files.add(match[1].trim());
  }
  // From output: M /path, A /path (git-style status prefixes)
  for (const match of outputText.matchAll(/^[MAD]\s+(.+)$/gm)) {
    files.add(match[1].trim());
  }
  return [...files];
}
