import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { buildParsedSession } from "../core/nodes.js";
import { computeStoredTurnCost, normalizeModelFamily, PRICING_VERSION } from "../core/pricing.js";
import { buildCodexParsedSession } from "../providers/codex/nodes.js";
import { parseCodexSessionFileFromContent, type CodexEvent } from "../providers/codex/parser.js";
import { parseSessionFileFromContent, parseSystemLinesFromContent, getMessageText, getToolCalls, getToolResults, hasCompaction, getThinkingText } from "../parser/jsonl.js";
import type { ParsedSession, SessionEvent, SessionInfo, ToolCallSummary, TurnNode } from "../types/index.js";
import type { ParsedProviderSession, ProviderSessionRef } from "../providers/types.js";
import { toProviderSessionRef } from "../providers/types.js";
import { getDb } from "./db.js";
import type { IngestionCheckpointProgress } from "./repositories.js";

export interface StoredTurnRow {
  sourceType: string;
  sessionId: string;
  turnIndex: number;
  category: string;
  summary: string;
  startLine: number;
  endLine: number;
}

export interface StoredEventRow {
  sourceType: string;
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  role: string;
  eventType: string;
  timestamp: string | null;
}

export interface StoredMessageRow {
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  role: string;
  text: string;
}

export interface StoredToolCallRow {
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  callId: string;
  toolName: string;
}

export interface StoredToolResultRow {
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface StoredFileTouchRow {
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  filePath: string | null;
  moduleKey: string | null;
  action: string;
  sourceTool: string;
  detail: string | null;
}

export interface StoredCommandRow {
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  toolCallId: string;
  commandText: string;
  isGitCommit: boolean;
  isGitPush: boolean;
  isGitPull: boolean;
}

export interface StoredCommitRow {
  sessionId: string;
  turnIndex: number;
  lineNumber: number;
  commandToolCallId: string | null;
  commitMessage: string | null;
  commitSha: string | null;
}

export interface StoredApprovalRow {
  sessionId: string;
  turnIndex: number;
  lineNumber: number;
  approvalType: string;
  status: string;
  detail: string | null;
}

export interface StoredErrorRow {
  sessionId: string;
  turnIndex: number | null;
  lineNumber: number;
  toolUseId: string | null;
  toolName: string | null;
  message: string;
}

export interface StoredPlanItemRow {
  sessionId: string;
  turnIndex: number;
  lineNumber: number;
  source: string;
  ordinal: number | null;
  taskId: string | null;
  subject: string;
  description: string | null;
  status: string | null;
  rawText: string | null;
}

export interface ReplaceParsedEvidenceInput {
  ref: ProviderSessionRef;
  parsed?: ParsedProviderSession;
}

export function replaceParsedEvidence(input: ReplaceParsedEvidenceInput): IngestionCheckpointProgress {
  const { ref } = input;
  if (ref.provider === "codex") {
    return replaceCodexParsedEvidence(input);
  }
  return replaceClaudeProviderEvidence(input);
}

function replaceClaudeProviderEvidence(input: ReplaceParsedEvidenceInput): IngestionCheckpointProgress {
  const { ref } = input;
  let events: SessionEvent[];
  let totalLines: number;
  let parsed: ParsedSession;
  let byteLength: number;

  if (input.parsed?.claudeEvents) {
    // Fast path: events already parsed by cache layer
    events = input.parsed.claudeEvents;
    totalLines = input.parsed.totalLines!;
    parsed = input.parsed.parsed;
    byteLength = input.parsed.sourceByteLength!;
  } else {
    // Fallback: read from disk (rebuild, CLI via replaceClaudeParsedEvidence)
    const rawContent = readFileSync(ref.sourcePath, "utf-8");
    totalLines = rawContent.split("\n").filter((line) => line.trim().length > 0).length;
    events = parseSessionFileFromContent(rawContent);
    const systemMeta = parseSystemLinesFromContent(rawContent);
    parsed = input.parsed?.parsed ?? buildParsedSession(ref, events, systemMeta);
    byteLength = Buffer.byteLength(rawContent, "utf-8");
  }

  const eventTurnIndex = buildEventTurnIndex(parsed.turns);
  const toolCallNameById = buildToolCallNameById(events);
  const db = getDb();

  deleteExistingEvidence(ref.id);

  insertParsedTurns(ref, parsed);
  const insertEvent = prepareInsertEvent();
  const insertMessage = db.prepare(`
    INSERT INTO messages(session_id, turn_index, line_number, role, timestamp, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls(session_id, turn_index, line_number, call_id, tool_name, input_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolResult = db.prepare(`
    INSERT INTO tool_results(session_id, turn_index, line_number, tool_use_id, content, is_error, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFileTouch = db.prepare(`
    INSERT INTO file_touches(session_id, turn_index, line_number, tool_call_id, file_path, module_key, action, source_tool, detail, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCommand = db.prepare(`
    INSERT INTO commands(session_id, turn_index, line_number, tool_call_id, command_text, is_git_commit, is_git_push, is_git_pull, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCommit = db.prepare(`
    INSERT INTO commits(session_id, turn_index, line_number, command_tool_call_id, commit_message, commit_sha, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertApproval = db.prepare(`
    INSERT INTO approvals(session_id, turn_index, line_number, approval_type, status, detail, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertError = db.prepare(`
    INSERT INTO errors(session_id, turn_index, line_number, tool_use_id, tool_name, message, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPlanItem = db.prepare(`
    INSERT INTO plan_items(session_id, turn_index, line_number, source, ordinal, task_id, subject, description, status, raw_text, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const turn of parsed.turns) {
    const commitCall = findGitCommitToolCall(turn);
    if (turn.hasCommit) {
      insertCommit.run(
        ref.id,
        turn.index,
        turn.startLine,
        commitCall?.id ?? null,
        turn.commitMessage,
        turn.commitSha,
        turn.timestamp.toISOString(),
      );
    }

    const approvals = deriveApprovals(turn);
    for (const approval of approvals) {
      insertApproval.run(
        ref.id,
        turn.index,
        turn.startLine,
        approval.approvalType,
        approval.status,
        approval.detail,
        turn.timestamp.toISOString(),
      );
    }

    const planItems = derivePlanItems(turn);
    for (const item of planItems) {
      insertPlanItem.run(
        ref.id,
        turn.index,
        turn.startLine,
        item.source,
        item.ordinal,
        item.taskId,
        item.subject,
        item.description,
        item.status,
        item.rawText,
        turn.timestamp.toISOString(),
      );
    }
  }

  for (const event of events) {
    const turnIndex = eventTurnIndex.get(event.line) ?? null;
    const text = getMessageText(event.message);
    insertEvent.run(
      ref.provider,
      ref.id,
      turnIndex,
      event.line,
      event.message.role,
      deriveEventType(event),
      event.timestamp?.toISOString() ?? null,
      text,
      event.planContent ?? null,
      event.model ?? null,
      event.usage?.inputTokens ?? 0,
      event.usage?.outputTokens ?? 0,
      event.usage?.cacheReadInputTokens ?? 0,
      event.usage?.cacheCreationInputTokens ?? 0,
      JSON.stringify(event.message),
    );

    insertMessage.run(
      ref.id,
      turnIndex,
      event.line,
      event.message.role,
      event.timestamp?.toISOString() ?? null,
      text,
    );

    const calls = getToolCalls(event.message);
    for (const call of calls) {
      insertToolCall.run(
        ref.id,
        turnIndex,
        event.line,
        call.id,
        call.name,
        JSON.stringify(call.input),
        event.timestamp?.toISOString() ?? null,
      );

      const touches = deriveFileTouches(call);
      for (const touch of touches) {
        const moduleKey = deriveModuleKey(ref.projectPath, touch.filePath);
        insertFileTouch.run(
          ref.id,
          turnIndex,
          event.line,
          call.id,
          touch.filePath,
          moduleKey,
          touch.action,
          call.name,
          touch.detail,
          event.timestamp?.toISOString() ?? null,
        );
      }

      const command = extractCommand(call.input);
      if (call.name === "Bash" && command) {
        insertCommand.run(
          ref.id,
          turnIndex,
          event.line,
          call.id,
          command,
          isGitCommit(command) ? 1 : 0,
          isGitPush(command) ? 1 : 0,
          isGitPull(command) ? 1 : 0,
          event.timestamp?.toISOString() ?? null,
        );
      }
    }

    const results = getToolResults(event.message);
    for (const result of results) {
      insertToolResult.run(
        ref.id,
        turnIndex,
        event.line,
        result.tool_use_id,
        result.content,
        result.is_error ? 1 : 0,
        event.timestamp?.toISOString() ?? null,
      );

      if (result.is_error) {
        insertError.run(
          ref.id,
          turnIndex,
          event.line,
          result.tool_use_id || null,
          toolCallNameById.get(result.tool_use_id) ?? null,
          extractErrorSummary(result.content),
          event.timestamp?.toISOString() ?? null,
        );
      }
    }
  }

  return {
    lastProcessedLine: totalLines,
    lastProcessedByteOffset: byteLength,
    lastProcessedTimestamp: events.at(-1)?.timestamp?.toISOString() ?? null,
  };
}

export function replaceClaudeParsedEvidence(session: SessionInfo): IngestionCheckpointProgress {
  return replaceParsedEvidence({ ref: toProviderSessionRef("claude", session) });
}

function replaceCodexParsedEvidence(input: ReplaceParsedEvidenceInput): IngestionCheckpointProgress {
  const { ref } = input;
  let events: CodexEvent[];
  let totalLines: number;
  let parsed: ParsedSession;
  let byteLength: number;

  if (input.parsed?.codexEvents) {
    // Fast path: events already parsed by cache layer
    events = input.parsed.codexEvents;
    totalLines = input.parsed.totalLines!;
    parsed = input.parsed.parsed;
    byteLength = input.parsed.sourceByteLength!;
  } else {
    // Fallback: read from disk (rebuild, CLI)
    const rawContent = readFileSync(ref.sourcePath, "utf-8");
    totalLines = rawContent.split("\n").filter((line) => line.trim().length > 0).length;
    events = parseCodexSessionFileFromContent(rawContent);
    parsed = input.parsed?.parsed ?? buildCodexParsedSession(ref, events);
    byteLength = Buffer.byteLength(rawContent, "utf-8");
  }

  const eventTurnIndex = buildEventTurnIndex(parsed.turns);
  const db = getDb();

  deleteExistingEvidence(ref.id);
  insertParsedTurns(ref, parsed);
  updateSessionProviderMetadata(ref, parsed);

  const insertEvent = prepareInsertEvent();
  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls(session_id, turn_index, line_number, call_id, tool_name, input_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFileTouch = db.prepare(`
    INSERT INTO file_touches(session_id, turn_index, line_number, tool_call_id, file_path, module_key, action, source_tool, detail, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCommand = db.prepare(`
    INSERT INTO commands(session_id, turn_index, line_number, tool_call_id, command_text, is_git_commit, is_git_push, is_git_pull, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCommit = db.prepare(`
    INSERT INTO commits(session_id, turn_index, line_number, command_tool_call_id, commit_message, commit_sha, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertError = db.prepare(`
    INSERT INTO errors(session_id, turn_index, line_number, tool_use_id, tool_name, message, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const event of events) {
    const turnIndex = eventTurnIndex.get(event.line) ?? null;
    insertEvent.run(
      ref.provider,
      ref.id,
      turnIndex,
      event.line,
      deriveCodexRole(event),
      event.type,
      event.timestamp.toISOString(),
      codexEventText(event),
      null,
      event.type === "session_meta" ? event.model ?? null : null,
      event.type === "token_count" ? event.inputTokens : 0,
      event.type === "token_count" ? event.outputTokens : 0,
      event.type === "token_count" ? event.cachedInputTokens : 0,
      0,
      JSON.stringify(serializeCodexEvent(event)),
    );

    if (event.type === "exec_command") {
      const commandText = event.command.join(" ");
      const callId = `codex-exec-${event.line}`;
      insertToolCall.run(
        ref.id,
        turnIndex,
        event.line,
        callId,
        "exec_command",
        JSON.stringify({ command: commandText, exitCode: event.exitCode, status: event.status }),
        event.timestamp.toISOString(),
      );
      insertCommand.run(
        ref.id,
        turnIndex,
        event.line,
        callId,
        commandText,
        isGitCommit(commandText) ? 1 : 0,
        isGitPush(commandText) ? 1 : 0,
        isGitPull(commandText) ? 1 : 0,
        event.timestamp.toISOString(),
      );
      if (event.exitCode === 0 && isGitCommit(commandText)) {
        insertCommit.run(
          ref.id,
          turnIndex ?? 0,
          event.line,
          callId,
          extractCodexCommitMessage(commandText),
          null,
          event.timestamp.toISOString(),
        );
      }
      if (event.exitCode !== 0) {
        insertError.run(
          ref.id,
          turnIndex,
          event.line,
          callId,
          "exec_command",
          `Command failed (exit ${event.exitCode}): ${commandText}`,
          event.timestamp.toISOString(),
        );
      }
    } else if (event.type === "patch_apply") {
      const callId = `codex-patch-${event.line}`;
      insertToolCall.run(
        ref.id,
        turnIndex,
        event.line,
        callId,
        "patch_apply",
        JSON.stringify({ files: event.files, success: event.success }),
        event.timestamp.toISOString(),
      );
      for (const filePath of event.files) {
        insertFileTouch.run(
          ref.id,
          turnIndex,
          event.line,
          callId,
          filePath,
          deriveModuleKey(ref.projectPath, filePath),
          "edit",
          "patch_apply",
          event.success ? null : "patch failed",
          event.timestamp.toISOString(),
        );
      }
      if (!event.success) {
        insertError.run(
          ref.id,
          turnIndex,
          event.line,
          callId,
          "patch_apply",
          `Patch failed: ${event.files.join(", ")}`,
          event.timestamp.toISOString(),
        );
      }
    } else if (event.type === "error") {
      insertError.run(
        ref.id,
        turnIndex,
        event.line,
        null,
        null,
        event.message,
        event.timestamp.toISOString(),
      );
    }
  }

  return {
    lastProcessedLine: totalLines,
    lastProcessedByteOffset: byteLength,
    lastProcessedTimestamp: events.at(-1)?.timestamp?.toISOString() ?? null,
  };
}

function insertParsedTurns(ref: ProviderSessionRef, parsed: ParsedSession): void {
  const db = getDb();
  const insertTurn = db.prepare(`
    INSERT INTO turns(
      source_type, session_id, turn_index, started_at, start_line, end_line, category, summary,
      user_instruction, assistant_preview, has_commit, has_push, has_pull,
      commit_message, commit_sha, has_error, error_count, has_compaction, compaction_text,
      has_plan_start, has_plan_end, plan_markdown, plan_rejected, model,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      context_window_tokens, duration_ms, sections_json,
      cost_usd, model_family, pricing_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const turn of parsed.turns) {
    insertTurn.run(
      ref.provider,
      ref.id,
      turn.index,
      turn.timestamp.toISOString(),
      turn.startLine,
      turn.endLine,
      turn.category,
      turn.summary,
      turn.userInstruction,
      turn.assistantPreview,
      turn.hasCommit ? 1 : 0,
      turn.hasPush ? 1 : 0,
      turn.hasPull ? 1 : 0,
      turn.commitMessage,
      turn.commitSha,
      turn.hasError ? 1 : 0,
      turn.errorCount,
      turn.hasCompaction ? 1 : 0,
      turn.compactionText,
      turn.hasPlanStart ? 1 : 0,
      turn.hasPlanEnd ? 1 : 0,
      turn.planMarkdown,
      turn.planRejected ? 1 : 0,
      turn.model,
      turn.tokenUsage.inputTokens,
      turn.tokenUsage.outputTokens,
      turn.tokenUsage.cacheReadInputTokens,
      turn.tokenUsage.cacheCreationInputTokens,
      turn.contextWindowTokens,
      turn.durationMs,
      JSON.stringify(turn.sections),
      computeStoredTurnCost(turn.model, turn.tokenUsage),
      normalizeModelFamily(turn.model),
      PRICING_VERSION,
    );
  }
}

function prepareInsertEvent() {
  return getDb().prepare(`
    INSERT INTO events(
      source_type, session_id, turn_index, line_number, role, event_type, timestamp, text,
      plan_content, model, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

export function listStoredTurns(sessionId?: string): StoredTurnRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      source_type as sourceType,
      turn_index as turnIndex,
      category,
      summary,
      start_line as startLine,
      end_line as endLine
    FROM turns
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, turn_index ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredTurnRow[];
}

export function listStoredEvents(sessionId?: string): StoredEventRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      source_type as sourceType,
      turn_index as turnIndex,
      line_number as lineNumber,
      role,
      event_type as eventType,
      timestamp
    FROM events
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredEventRow[];
}

export function listStoredMessages(sessionId?: string): StoredMessageRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      role,
      text
    FROM messages
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredMessageRow[];
}

export function listStoredToolCalls(sessionId?: string): StoredToolCallRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      call_id as callId,
      tool_name as toolName
    FROM tool_calls
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredToolCallRow[];
}

export function listStoredToolResults(sessionId?: string): StoredToolResultRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      tool_use_id as toolUseId,
      content,
      is_error as isError
    FROM tool_results
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredToolResultRow[];
}

export function listStoredFileTouches(sessionId?: string): StoredFileTouchRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      file_path as filePath,
      module_key as moduleKey,
      action,
      source_tool as sourceTool,
      detail
    FROM file_touches
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredFileTouchRow[];
}

export function listStoredCommands(sessionId?: string): StoredCommandRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      tool_call_id as toolCallId,
      command_text as commandText,
      is_git_commit as isGitCommit,
      is_git_push as isGitPush,
      is_git_pull as isGitPull
    FROM commands
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredCommandRow[];
}

export function listStoredCommits(sessionId?: string): StoredCommitRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      command_tool_call_id as commandToolCallId,
      commit_message as commitMessage,
      commit_sha as commitSha
    FROM commits
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, turn_index ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredCommitRow[];
}

export function listStoredApprovals(sessionId?: string): StoredApprovalRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      approval_type as approvalType,
      status,
      detail
    FROM approvals
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, turn_index ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredApprovalRow[];
}

export function listStoredErrors(sessionId?: string): StoredErrorRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      tool_use_id as toolUseId,
      tool_name as toolName,
      message
    FROM errors
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, line_number ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredErrorRow[];
}

export function listStoredPlanItems(sessionId?: string): StoredPlanItemRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
      turn_index as turnIndex,
      line_number as lineNumber,
      source,
      ordinal,
      task_id as taskId,
      subject,
      description,
      status,
      raw_text as rawText
    FROM plan_items
    ${sessionId ? "WHERE session_id = ?" : ""}
    ORDER BY session_id ASC, turn_index ASC, id ASC
  `;
  return (sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all()) as StoredPlanItemRow[];
}

function deleteExistingEvidence(sessionId: string): void {
  const db = getDb();
  const tables = [
    "turns",
    "events",
    "messages",
    "tool_calls",
    "tool_results",
    "file_touches",
    "commands",
    "commits",
    "approvals",
    "errors",
    "plan_items",
  ];
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
  }
}

function buildEventTurnIndex(turns: TurnNode[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const turn of turns) {
    for (let line = turn.startLine; line <= turn.endLine; line++) {
      map.set(line, turn.index);
    }
  }
  return map;
}

function buildToolCallNameById(events: SessionEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events) {
    for (const call of getToolCalls(event.message)) {
      map.set(call.id, call.name);
    }
  }
  return map;
}

function deriveEventType(event: SessionEvent): string {
  if (hasCompaction(event.message)) return "compaction";
  if (getToolCalls(event.message).length > 0) return "tool_call";
  if (getToolResults(event.message).length > 0) return "tool_result";
  if (getThinkingText(event.message)) return "thinking";
  return event.message.role === "assistant" ? "assistant_message" : "user_message";
}

function deriveFileTouches(call: { name: string; input: Record<string, unknown> }): Array<{
  filePath: string | null;
  action: string;
  detail: string | null;
}> {
  const path = extractFilePath(call.input);
  switch (call.name) {
    case "Read":
      return [{ filePath: path, action: "read", detail: null }];
    case "Write":
      return [{ filePath: path, action: "write", detail: null }];
    case "Edit":
    case "NotebookEdit":
    case "MultiEdit":
      return [{ filePath: path, action: "edit", detail: null }];
    case "Glob":
      return [{
        filePath: typeof call.input.path === "string" ? call.input.path : path,
        action: "search",
        detail: typeof call.input.pattern === "string" ? call.input.pattern : null,
      }];
    case "Grep":
      return [{
        filePath: typeof call.input.path === "string" ? call.input.path : path,
        action: "search",
        detail: typeof call.input.pattern === "string" ? call.input.pattern : null,
      }];
    default:
      return [];
  }
}

function deriveModuleKey(projectPath: string, filePath: string | null): string | null {
  if (!filePath) return null;

  const normalizedProjectPath = normalizePath(projectPath);
  const normalizedFilePath = normalizePath(filePath);
  if (!normalizedFilePath) return null;

  let relativePath = normalizedFilePath;
  if (isAbsolute(normalizedFilePath)) {
    const candidate = normalizePath(relative(normalizedProjectPath, normalizedFilePath));
    if (!candidate || candidate.startsWith("..")) {
      return null;
    }
    relativePath = candidate;
  }

  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const directorySegments = segments.slice(0, -1);
  const noiseSegments = new Set([
    "src",
    "lib",
    "app",
    "packages",
    "dist",
    "build",
    "test",
    "tests",
    "__tests__",
  ]);

  const meaningfulSegments = directorySegments.filter((segment) => !noiseSegments.has(segment.toLowerCase()));
  if (meaningfulSegments.length === 0) return null;

  return meaningfulSegments.slice(0, 2).join("/");
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function deriveApprovals(turn: TurnNode): Array<{
  approvalType: string;
  status: string;
  detail: string | null;
}> {
  const approvals: Array<{ approvalType: string; status: string; detail: string | null }> = [];
  if (turn.hasPlanEnd || turn.planMarkdown || turn.planRejected) {
    approvals.push({
      approvalType: "plan",
      status: turn.planRejected ? "rejected" : "approved",
      detail: turn.planMarkdown ? summarizePlan(turn.planMarkdown) : null,
    });
  }
  return approvals;
}

function derivePlanItems(turn: TurnNode): Array<{
  source: string;
  ordinal: number | null;
  taskId: string | null;
  subject: string;
  description: string | null;
  status: string | null;
  rawText: string | null;
}> {
  const items: Array<{
    source: string;
    ordinal: number | null;
    taskId: string | null;
    subject: string;
    description: string | null;
    status: string | null;
    rawText: string | null;
  }> = [];

  if (turn.planMarkdown) {
    const groupedPlanItem = extractGroupedPlanItem(turn.planMarkdown);
    if (groupedPlanItem) {
      items.push({
        source: "plan_markdown",
        ordinal: 1,
        taskId: null,
        subject: groupedPlanItem.subject,
        description: groupedPlanItem.description,
        status: turn.planRejected ? "rejected" : "planned",
        rawText: groupedPlanItem.rawText,
      });
    }
  }

  for (const task of turn.taskCreates) {
    items.push({
      source: "task_create",
      ordinal: null,
      taskId: task.taskId || null,
      subject: task.subject,
      description: task.description || null,
      status: "created",
      rawText: task.description || task.subject,
    });
  }

  for (const task of turn.taskUpdates) {
    items.push({
      source: "task_update",
      ordinal: null,
      taskId: task.taskId || null,
      subject: task.taskId ? `Task ${task.taskId}` : "Task update",
      description: null,
      status: task.status || null,
      rawText: task.status || null,
    });
  }

  return items;
}

function extractGroupedPlanItem(markdown: string): {
  subject: string;
  description: string | null;
  rawText: string;
} | null {
  const bullets = markdown
    .split("\n")
    .map((line) => line.trim())
    .map((trimmed) => {
      const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);
      const numberedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
      return bulletMatch?.[1] ?? numberedMatch?.[1] ?? null;
    })
    .filter((item): item is string => Boolean(item && item.trim()));

  const meaningfulBullets = bullets.filter((bullet) => !isOperationalPlanBullet(bullet));
  if (meaningfulBullets.length > 0) {
    const subject = meaningfulBullets[0].trim();
    return {
      subject,
      description: markdown.trim(),
      rawText: markdown.trim(),
    };
  }

  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length > 0) {
    return {
      subject: paragraphs[0].split("\n")[0].trim(),
      description: markdown.trim(),
      rawText: markdown.trim(),
    };
  }

  return null;
}

function isOperationalPlanBullet(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  const commandPrefixes = [
    "run ",
    "start ",
    "stop ",
    "restart ",
    "typecheck",
    "test ",
    "verify ",
    "check ",
    "confirm ",
    "open ",
    "launch ",
    "cd ",
  ];
  if (commandPrefixes.some((prefix) => normalized.startsWith(prefix))) return true;
  if (/^(npm|pnpm|yarn|bun|git|cargo|go|python|uv)\b/.test(normalized)) return true;
  return false;
}

function summarizePlan(markdown: string): string {
  const firstLine = markdown
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 200) ?? "";
}

function findGitCommitToolCall(turn: TurnNode): { id: string; input: Record<string, unknown> } | null {
  for (const event of turn.events) {
    for (const call of getToolCalls(event.message)) {
      const command = extractCommand(call.input);
      if (call.name === "Bash" && command && isGitCommit(command)) {
        return { id: call.id, input: call.input };
      }
    }
  }
  return null;
}

function deriveCodexRole(event: CodexEvent): string {
  switch (event.type) {
    case "user_message":
      return "user";
    case "agent_message":
    case "agent_reasoning":
      return "assistant";
    case "exec_command":
    case "patch_apply":
    case "web_search":
    case "view_image":
      return "tool";
    default:
      return "system";
  }
}

function codexEventText(event: CodexEvent): string {
  switch (event.type) {
    case "session_meta":
      return event.cwd || event.id;
    case "turn_aborted":
      return event.reason;
    case "user_message":
    case "agent_message":
    case "agent_reasoning":
      return event.text;
    case "exec_command":
      return event.command.join(" ");
    case "patch_apply":
      return event.files.join("\n");
    case "web_search":
      return event.query || event.action;
    case "view_image":
      return event.path;
    case "token_count":
      return `input=${event.inputTokens} output=${event.outputTokens} cached=${event.cachedInputTokens}`;
    case "compaction":
      return event.summary;
    case "error":
      return event.message;
    default:
      return "";
  }
}

function serializeCodexEvent(event: CodexEvent): Record<string, unknown> {
  return {
    ...event,
    timestamp: event.timestamp.toISOString(),
  };
}

function updateSessionProviderMetadata(ref: ProviderSessionRef, parsed: ParsedSession): void {
  const db = getDb();
  const row = db.prepare(`
    SELECT metadata_json as metadataJson
    FROM sessions
    WHERE id = ?
  `).get(ref.id) as { metadataJson: string | null } | undefined;
  let metadata: Record<string, unknown> = {};
  if (row?.metadataJson) {
    try {
      const parsedMetadata = JSON.parse(row.metadataJson);
      if (parsedMetadata && typeof parsedMetadata === "object") {
        metadata = parsedMetadata as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
  }

  metadata.provider = ref.provider;
  metadata.path = ref.sourcePath;
  metadata.sizeBytes = ref.sourceSizeBytes;
  if (parsed.codexRuntime) {
    metadata.codexRuntime = {
      ...parsed.codexRuntime,
      lastEventAt: parsed.codexRuntime.lastEventAt?.toISOString() ?? null,
      lastToolActivityAt: parsed.codexRuntime.lastToolActivityAt?.toISOString() ?? null,
    };
  }

  db.prepare(`
    UPDATE sessions
    SET metadata_json = ?
    WHERE id = ?
  `).run(JSON.stringify(metadata), ref.id);
}

function extractCommand(input: Record<string, unknown>): string | null {
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return null;
}

function extractFilePath(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return null;
}

function extractErrorSummary(content: string): string {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/(?:Error:|error:|ENOENT|EACCES|fatal:|Exit code|TypeError|SyntaxError|Cannot find)/.test(trimmed)) {
      return trimmed.slice(0, 500);
    }
  }
  return content.trim().slice(0, 500) || "Unknown error";
}

function isGitCommit(command: string): boolean {
  return /\bgit\b(?:\s+-\S+(?:\s+\S+)*)?\s+\bcommit\b/.test(command);
}

function extractCodexCommitMessage(command: string): string | null {
  const match = command.match(/\bgit\b(?:\s+-\S+(?:\s+\S+)*)?\s+\bcommit\b\s+.*?-m\s+["']([^"']+)["']/);
  return match?.[1] ?? null;
}

function isGitPush(command: string): boolean {
  return /git\s+push/.test(command);
}

function isGitPull(command: string): boolean {
  return /git\s+pull/.test(command);
}
