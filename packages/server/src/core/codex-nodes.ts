import type {
  ParsedSession, SessionInfo, TurnNode, TurnCategory,
  TurnSections, ToolCallSummary, TokenUsage,
} from "../types/index.js";
import type { CodexEvent } from "../parser/codex.js";

/**
 * Build a ParsedSession from Codex events.
 * Uses explicit turn_started/turn_complete boundaries (simpler than Claude's inference).
 */
export function buildCodexParsedSession(session: SessionInfo, events: CodexEvent[]): ParsedSession {
  const turns = buildCodexTurns(events);

  // Aggregate stats
  const allFilesChanged = new Set<string>();
  const allToolsUsed: Record<string, number> = {};
  let totalToolCalls = 0;
  let commits = 0;
  let compactions = 0;
  let errorTurns = 0;
  let correctionTurns = 0;
  const totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let primaryModel: string | null = null;

  // Extract model from session_meta (including turn_context-derived ones)
  for (const e of events) {
    if (e.type === "session_meta" && (e as Extract<CodexEvent, { type: "session_meta" }>).model) {
      primaryModel = (e as Extract<CodexEvent, { type: "session_meta" }>).model!;
      break;
    }
  }

  for (const turn of turns) {
    for (const f of turn.filesChanged) allFilesChanged.add(f);
    for (const [tool, count] of Object.entries(turn.toolCounts)) {
      allToolsUsed[tool] = (allToolsUsed[tool] ?? 0) + count;
      totalToolCalls += count;
    }
    if (turn.hasCommit) commits++;
    if (turn.hasCompaction) compactions++;
    if (turn.hasError) errorTurns++;
    if (turn.sections.corrections.items.length > 0) correctionTurns++;

    totalTokenUsage.inputTokens += turn.tokenUsage.inputTokens;
    totalTokenUsage.outputTokens += turn.tokenUsage.outputTokens;
    totalTokenUsage.cacheReadInputTokens += turn.tokenUsage.cacheReadInputTokens;
    totalTokenUsage.cacheCreationInputTokens += turn.tokenUsage.cacheCreationInputTokens;

    if (!primaryModel && turn.model) primaryModel = turn.model;
  }

  return {
    session,
    turns,
    stats: {
      totalEvents: events.length,
      totalTurns: turns.length,
      toolCalls: totalToolCalls,
      commits,
      compactions,
      filesChanged: [...allFilesChanged],
      toolsUsed: Object.fromEntries(
        Object.entries(allToolsUsed).sort((a, b) => b[1] - a[1])
      ),
      totalTokenUsage,
      errorTurns,
      correctionTurns,
      primaryModel,
    },
  };
}

// ─── Turn building ──────────────────────────────────────────────────────────

function buildCodexTurns(events: CodexEvent[]): TurnNode[] {
  const turns: TurnNode[] = [];
  let currentTurnEvents: CodexEvent[] = [];
  let turnIndex = 0;
  let inTurn = false;
  let sessionModel: string | null = null;

  for (const event of events) {
    if (event.type === "session_meta") {
      const meta = event as Extract<CodexEvent, { type: "session_meta" }>;
      if (meta.model) sessionModel = meta.model;
      continue; // Don't accumulate meta events into turns
    }

    if (event.type === "turn_started") {
      // If there was a previous unterminated turn, flush it
      if (inTurn && currentTurnEvents.length > 0) {
        const turn = buildSingleCodexTurn(currentTurnEvents, turnIndex, sessionModel);
        if (turn) { turns.push(turn); turnIndex++; }
      }
      currentTurnEvents = [event];
      inTurn = true;
      continue;
    }

    if (event.type === "turn_complete") {
      currentTurnEvents.push(event);
      const turn = buildSingleCodexTurn(currentTurnEvents, turnIndex, sessionModel);
      if (turn) { turns.push(turn); turnIndex++; }
      currentTurnEvents = [];
      inTurn = false;
      continue;
    }

    // Accumulate events within a turn
    if (inTurn) {
      currentTurnEvents.push(event);
    }
    // Events before first turn_started are skipped
  }

  // Unterminated turn at EOF (active session) — flush as in-progress
  if (inTurn && currentTurnEvents.length > 0) {
    const turn = buildSingleCodexTurn(currentTurnEvents, turnIndex, sessionModel);
    if (turn) turns.push(turn);
  }

  return turns;
}

function buildSingleCodexTurn(events: CodexEvent[], index: number, sessionModel: string | null): TurnNode | null {
  if (events.length === 0) return null;

  // Extract user message
  const userMsg = events.find((e): e is Extract<CodexEvent, { type: "user_message" }> => e.type === "user_message");
  const userText = userMsg?.text ?? "";
  const userInstruction = cleanCodexInstruction(userText);
  let { summary, category } = summarizeCodexInstruction(userInstruction);

  // Extract agent messages
  const agentMsgs = events.filter((e): e is Extract<CodexEvent, { type: "agent_message" }> => e.type === "agent_message");
  const reasoningEvents = events.filter((e): e is Extract<CodexEvent, { type: "agent_reasoning" }> => e.type === "agent_reasoning");
  const assistantPreview = (agentMsgs[0]?.text ?? stripMarkdownEmphasis(reasoningEvents[0]?.text ?? "")).slice(0, 200);

  // Extract commands
  const execEvents = events.filter((e): e is Extract<CodexEvent, { type: "exec_command" }> => e.type === "exec_command");
  const commands: string[] = [];
  let hasCommit = false;
  let commitMessage: string | null = null;
  let commitSha: string | null = null;
  let errorCount = 0;

  const toolCounts: Record<string, number> = {};

  for (const exec of execEvents) {
    const cmdStr = exec.command.join(" ");
    commands.push(cmdStr);
    toolCounts["shell_command"] = (toolCounts["shell_command"] ?? 0) + 1;

    if (/git\s+commit/.test(cmdStr)) {
      hasCommit = true;
      commitMessage = extractCodexCommitMessage(cmdStr);
    }

    if (exec.exitCode !== 0) {
      errorCount++;
    }
  }

  // Extract file patches
  const patchEvents = events.filter((e): e is Extract<CodexEvent, { type: "patch_apply" }> => e.type === "patch_apply");
  const filesChanged: string[] = [];
  for (const patch of patchEvents) {
    filesChanged.push(...patch.files);
    toolCounts["file_patch"] = (toolCounts["file_patch"] ?? 0) + 1;
    if (!patch.success) errorCount++;
  }

  // Extract errors
  const errorEvents = events.filter((e): e is Extract<CodexEvent, { type: "error" }> => e.type === "error");
  errorCount += errorEvents.length;

  const abortedEvent = events.find((e): e is Extract<CodexEvent, { type: "turn_aborted" }> => e.type === "turn_aborted");
  if (abortedEvent) {
    summary = "Interrupted";
    category = "interruption";
  }

  const webSearchEvents = events.filter((e): e is Extract<CodexEvent, { type: "web_search" }> => e.type === "web_search");
  const imageEvents = events.filter((e): e is Extract<CodexEvent, { type: "view_image" }> => e.type === "view_image");
  const searchTerms = webSearchEvents.map((e) => e.query || e.action).filter(Boolean);
  const filesRead = imageEvents.map((e) => e.path).filter(Boolean);

  // Extract token usage — only use the LAST token_count per turn
  // Codex emits a stale pre-request token_count then the real post-request one
  const tokenEvents = events.filter((e): e is Extract<CodexEvent, { type: "token_count" }> => e.type === "token_count");
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const lastTokenEvent = tokenEvents[tokenEvents.length - 1];
  const contextWindowTokens = lastTokenEvent?.modelContextWindow ?? null;
  if (lastTokenEvent) {
    tokenUsage.inputTokens = lastTokenEvent.inputTokens;
    tokenUsage.outputTokens = lastTokenEvent.outputTokens;
    tokenUsage.cacheReadInputTokens = lastTokenEvent.cachedInputTokens;
  }

  // Compaction
  const compactionEvents = events.filter((e): e is Extract<CodexEvent, { type: "compaction" }> => e.type === "compaction");
  const hasCompaction = compactionEvents.length > 0;
  const compactionText = compactionEvents[0]?.summary ?? null;

  // Duration from turn_started to turn_complete
  const turnStarted = events.find((e) => e.type === "turn_started");
  const turnComplete = events.find((e) => e.type === "turn_complete");
  const durationMs = (turnStarted && turnComplete)
    ? turnComplete.timestamp.getTime() - turnStarted.timestamp.getTime()
    : null;

  // Build tool calls list
  const toolCalls: ToolCallSummary[] = [];
  for (const exec of execEvents) {
    toolCalls.push({ name: "shell_command", input: { command: exec.command.join(" ") } });
  }
  for (const patch of patchEvents) {
    toolCalls.push({ name: "file_patch", input: { files: patch.files } });
  }

  // Build corrections from error→fix sequences
  const corrections = buildCodexCorrections(events);
  if (abortedEvent) {
    corrections.push({
      error: `Turn ${abortedEvent.reason || "interrupted"}`,
      fix: "(user interrupted)",
    });
  }

  // Infer task lifecycle for Codex turns so intent mapping can treat Codex
  // sessions similarly to Claude sessions (which have TaskCreate/TaskUpdate).
  // For codex, any turn that produces actual work (commands, file patches, commits)
  // should create an inferred task, not just "task"/"feedback" categories.
  const hasWork = filesChanged.length > 0 || commands.length > 0 || hasCommit;
  const shouldCreateTask = category === "task" || category === "feedback" || hasWork;
  const isTurnComplete = events.some((e) => e.type === "turn_complete");
  const inferredTaskId = `codex-${index + 1}`;
  const inferredSubject = summary || userInstruction.slice(0, 80) || `Codex task ${index + 1}`;
  const inferredStatus =
    isTurnComplete
      ? (hasCommit || (hasWork && errorCount === 0) ? "completed" : "pending")
      : (hasWork ? "in_progress" : "pending");
  const taskCreates = shouldCreateTask
    ? [{ taskId: inferredTaskId, subject: inferredSubject, description: userInstruction.slice(0, 240) }]
    : [];
  const taskUpdates = shouldCreateTask
    ? [{
        taskId: inferredTaskId,
        status: inferredStatus,
      }]
    : [];

  // Sections — simplified for Codex
  const sections: TurnSections = {
    goal: { summary: summary || "(no instruction)", fullInstruction: userInstruction },
    approach: { summary: assistantPreview.slice(0, 150) || "(no approach captured)", thinking: "" },
    decisions: { summary: "(no explicit decisions captured)", items: [] },
    research: {
      summary: buildResearchSummary(filesRead, searchTerms),
      filesRead: filesRead.map(shortPath),
      searches: searchTerms.map((s) => stripMarkdownEmphasis(s)),
    },
    actions: buildCodexActionsSection(commands, filesChanged),
    corrections: {
      summary: corrections.length > 0
        ? `${corrections.length} error${corrections.length > 1 ? "s" : ""} → ${corrections.filter((c) => c.fix !== "(unresolved)").length} fixed`
        : "(no errors)",
      items: corrections,
    },
    artifacts: {
      summary: buildArtifactsSummary(filesChanged, commitMessage ? [commitMessage] : [], hasCompaction),
      filesChanged: filesChanged.map(shortPath),
      commits: commitMessage ? [commitMessage] : [],
    },
    escalations: { summary: "(none)", questions: [] },
  };

  const timestamp = events[0]?.timestamp ?? new Date(0);

  return {
    id: `turn-${index}`,
    index,
    timestamp,
    summary,
    category,
    userInstruction: userInstruction.slice(0, 500),
    assistantPreview,
    sections,
    toolCalls,
    toolCounts,
    filesChanged,
    filesRead,
    commands,
    hasCommit,
    commitMessage,
    commitSha,
    hasError: errorCount > 0,
    errorCount,
    hasCompaction,
    compactionText,
    hasPlanStart: false,
    hasPlanEnd: false,
    planMarkdown: null,
    planRejected: false,
    taskCreates,
    taskUpdates,
    tokenUsage,
    model: sessionModel ?? "codex",
    contextWindowTokens,
    durationMs,
    events: [], // SessionEvent is Claude-specific
    startLine: events[0].line,
    endLine: events[events.length - 1].line,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function cleanCodexInstruction(raw: string): string {
  return raw.replace(/\n{3,}/g, "\n\n").trim();
}

function summarizeCodexInstruction(text: string): { summary: string; category: TurnCategory } {
  const trimmed = text.trim();
  if (!trimmed) return { summary: "(continuation)", category: "continuation" };

  const firstLine = trimmed.split("\n")[0].trim();

  // Short continuations
  if (trimmed.length <= 20) {
    const lower = trimmed.toLowerCase();
    const continuationWords = ["yes", "ok", "okay", "continue", "go", "sure", "yeah", "yep", "do it", "try again"];
    if (continuationWords.some((w) => lower === w || lower.startsWith(w + " "))) {
      return { summary: trimmed, category: "continuation" };
    }
  }

  // Questions
  if (firstLine.endsWith("?") || /^(how|what|why|when|where|which|can you explain)/i.test(trimmed)) {
    return { summary: firstLine.slice(0, 80), category: "question" };
  }

  // Feedback
  if (/^(fix|this is wrong|change|update|modify|instead|actually|no,)/i.test(trimmed)) {
    return { summary: firstLine.slice(0, 80), category: "feedback" };
  }

  // Task
  if (/^(implement|build|create|add|write|make|set up|install|deploy|run|start|configure)/i.test(trimmed)) {
    return { summary: firstLine.slice(0, 80), category: "task" };
  }

  // Default
  const summary = firstLine.length > 80
    ? firstLine.slice(0, 80).replace(/\s+\S*$/, "") + "..."
    : firstLine;
  return { summary, category: "conversation" };
}

function extractCodexCommitMessage(cmd: string): string | null {
  // Heredoc style
  const heredocMatch = cmd.match(/cat\s+<<'?EOF'?\n([\s\S]*?)\n\s*EOF/);
  if (heredocMatch) {
    const lines = heredocMatch[1].trim().split("\n");
    const summary = lines.find((l) => l.trim().length > 0 && !l.startsWith("Co-Authored-By:"));
    return summary?.trim() ?? null;
  }

  // Simple -m style
  const match = cmd.match(/git\s+commit\s+.*?-m\s+["']([^"']+)["']/);
  if (match) return match[1];

  return null;
}

function buildCodexCorrections(events: CodexEvent[]): Array<{ error: string; fix: string }> {
  const items: Array<{ error: string; fix: string }> = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    let errorMsg: string | null = null;

    if (event.type === "error") {
      errorMsg = event.message.slice(0, 120);
    } else if (event.type === "exec_command" && event.exitCode !== 0) {
      errorMsg = `Command failed (exit ${event.exitCode}): ${event.command.join(" ").slice(0, 100)}`;
    } else if (event.type === "patch_apply" && !event.success) {
      errorMsg = `Patch failed: ${event.files.join(", ").slice(0, 100)}`;
    }

    if (!errorMsg) continue;

    // Look for a fix in the next few events
    let fix = "(unresolved)";
    for (let j = i + 1; j < events.length && j <= i + 5; j++) {
      const next = events[j];
      if (next.type === "exec_command" && next.exitCode === 0) {
        fix = `Retried command successfully`;
        break;
      }
      if (next.type === "patch_apply" && next.success) {
        fix = `Fixed in ${next.files.join(", ").slice(0, 80)}`;
        break;
      }
    }

    items.push({ error: errorMsg, fix });
  }

  return items;
}

function buildCodexActionsSection(commands: string[], filesChanged: string[]): TurnSections["actions"] {
  const parts: string[] = [];
  if (filesChanged.length > 0) parts.push(`${filesChanged.length} file${filesChanged.length > 1 ? "s" : ""} patched`);
  if (commands.length > 0) parts.push(`ran ${commands.length} command${commands.length > 1 ? "s" : ""}`);
  const summary = parts.length > 0 ? parts.join(", ") : "(no actions)";

  return {
    summary,
    edits: filesChanged.map(shortPath),
    commands: commands.map((c) => c.length > 120 ? c.slice(0, 120) + "..." : c),
    creates: [],
  };
}

function buildArtifactsSummary(filesChanged: string[], commits: string[], hasCompaction: boolean): string {
  const parts: string[] = [];
  if (filesChanged.length > 0) parts.push(`${filesChanged.length} file${filesChanged.length > 1 ? "s" : ""} changed`);
  if (commits.length > 0) parts.push(`${commits.length} commit${commits.length > 1 ? "s" : ""}`);
  if (hasCompaction) parts.push("compaction");
  return parts.length > 0 ? parts.join(", ") : "(no artifacts)";
}

function buildResearchSummary(filesRead: string[], searches: string[]): string {
  const parts: string[] = [];
  if (filesRead.length > 0) parts.push(`read ${filesRead.length} image${filesRead.length > 1 ? "s" : ""}`);
  if (searches.length > 0) parts.push(`${searches.length} web search${searches.length > 1 ? "es" : ""}`);
  return parts.length > 0 ? parts.join(", ") : "(no research)";
}

function stripMarkdownEmphasis(text: string): string {
  return text.replace(/\*\*/g, "").trim();
}

function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}
