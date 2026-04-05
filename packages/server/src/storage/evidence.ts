import { readFileSync } from "node:fs";
import { buildParsedSession } from "../core/nodes.js";
import { parseSessionFile, parseSystemLines, getMessageText, getToolCalls, getToolResults, hasCompaction, getThinkingText } from "../parser/jsonl.js";
import type { SessionEvent, SessionInfo, TurnNode } from "../types/index.js";
import { getDb } from "./db.js";
import type { IngestionCheckpointProgress } from "./repositories.js";

export interface StoredTurnRow {
  sessionId: string;
  turnIndex: number;
  category: string;
  summary: string;
  startLine: number;
  endLine: number;
}

export interface StoredEventRow {
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

export function replaceClaudeParsedEvidence(session: SessionInfo): IngestionCheckpointProgress {
  const rawContent = readFileSync(session.path, "utf-8");
  const totalLines = rawContent.split("\n").filter((line) => line.trim().length > 0).length;
  const events = parseSessionFile(session.path);
  const systemMeta = parseSystemLines(session.path);
  const parsed = buildParsedSession(session, events, systemMeta);
  const eventTurnIndex = buildEventTurnIndex(parsed.turns);
  const toolCallNameById = buildToolCallNameById(events);
  const db = getDb();

  deleteExistingEvidence(session.id);

  const insertTurn = db.prepare(`
    INSERT INTO turns(
      session_id, turn_index, started_at, start_line, end_line, category, summary,
      user_instruction, assistant_preview, has_commit, has_push, has_pull,
      commit_message, commit_sha, has_error, error_count, has_compaction, compaction_text,
      has_plan_start, has_plan_end, plan_markdown, plan_rejected, model,
      input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      context_window_tokens, duration_ms, sections_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO events(
      session_id, turn_index, line_number, role, event_type, timestamp, text,
      plan_content, model, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
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
    INSERT INTO file_touches(session_id, turn_index, line_number, tool_call_id, file_path, action, source_tool, detail, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    insertTurn.run(
      session.id,
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
    );

    const commitCall = findGitCommitToolCall(turn);
    if (turn.hasCommit) {
      insertCommit.run(
        session.id,
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
        session.id,
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
        session.id,
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
      session.id,
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
      session.id,
      turnIndex,
      event.line,
      event.message.role,
      event.timestamp?.toISOString() ?? null,
      text,
    );

    const calls = getToolCalls(event.message);
    for (const call of calls) {
      insertToolCall.run(
        session.id,
        turnIndex,
        event.line,
        call.id,
        call.name,
        JSON.stringify(call.input),
        event.timestamp?.toISOString() ?? null,
      );

      const touches = deriveFileTouches(call);
      for (const touch of touches) {
        insertFileTouch.run(
          session.id,
          turnIndex,
          event.line,
          call.id,
          touch.filePath,
          touch.action,
          call.name,
          touch.detail,
          event.timestamp?.toISOString() ?? null,
        );
      }

      const command = extractCommand(call.input);
      if (call.name === "Bash" && command) {
        insertCommand.run(
          session.id,
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
        session.id,
        turnIndex,
        event.line,
        result.tool_use_id,
        result.content,
        result.is_error ? 1 : 0,
        event.timestamp?.toISOString() ?? null,
      );

      if (result.is_error) {
        insertError.run(
          session.id,
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
    lastProcessedByteOffset: Buffer.byteLength(rawContent, "utf-8"),
    lastProcessedTimestamp: events.at(-1)?.timestamp?.toISOString() ?? null,
  };
}

export function listStoredTurns(sessionId?: string): StoredTurnRow[] {
  const db = getDb();
  const sql = `
    SELECT
      session_id as sessionId,
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
    const markdownItems = extractPlanMarkdownItems(turn.planMarkdown);
    for (const item of markdownItems) {
      items.push({
        source: "plan_markdown",
        ordinal: item.ordinal,
        taskId: null,
        subject: item.subject,
        description: null,
        status: turn.planRejected ? "rejected" : "planned",
        rawText: item.rawText,
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

function extractPlanMarkdownItems(markdown: string): Array<{ ordinal: number; subject: string; rawText: string }> {
  const items: Array<{ ordinal: number; subject: string; rawText: string }> = [];
  const lines = markdown.split("\n");
  let ordinal = 1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    const numberedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    const content = bulletMatch?.[1] ?? numberedMatch?.[1] ?? null;
    if (!content) continue;
    items.push({
      ordinal,
      subject: content.trim(),
      rawText: trimmed,
    });
    ordinal++;
  }

  if (items.length > 0) return items;

  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    items.push({
      ordinal,
      subject: paragraph.split("\n")[0].trim(),
      rawText: paragraph,
    });
    ordinal++;
  }

  return items;
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
  return /git\s+commit/.test(command);
}

function isGitPush(command: string): boolean {
  return /git\s+push/.test(command);
}

function isGitPull(command: string): boolean {
  return /git\s+pull/.test(command);
}
