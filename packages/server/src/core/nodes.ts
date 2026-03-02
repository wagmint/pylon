import type { SessionEvent, TurnNode, TurnCategory, ToolCallSummary, ParsedSession, SessionInfo, Message, TurnSections, DecisionItem, CorrectionItem, TokenUsage } from "../types/index.js";
import type { SystemMeta } from "../parser/jsonl.js";
import { getMessageText, getToolCalls, getToolResults, hasCompaction, getCompactionText, getThinkingText, getSearchPatterns } from "../parser/jsonl.js";

/**
 * Build turn-pair nodes from a flat list of session events.
 *
 * A turn = one user message + all assistant messages until the next user message.
 * This is the fundamental unit of a session timeline.
 */
export function buildTurnNodes(events: SessionEvent[]): TurnNode[] {
  const turns: TurnNode[] = [];
  let currentTurnEvents: SessionEvent[] = [];
  let turnIndex = 0;

  for (const event of events) {
    // New user message with real text = start of a new turn
    // Tool-result-only user messages are part of the current turn (Claude asking for tool results)
    if (event.message.role === "user" && isRealUserMessage(event.message) && currentTurnEvents.length > 0) {
      // Flush previous turn
      const turn = buildSingleTurn(currentTurnEvents, turnIndex);
      if (turn) {
        turns.push(turn);
        turnIndex++;
      }
      currentTurnEvents = [];
    }

    currentTurnEvents.push(event);
  }

  // Flush final turn
  if (currentTurnEvents.length > 0) {
    const turn = buildSingleTurn(currentTurnEvents, turnIndex);
    if (turn) turns.push(turn);
  }

  return turns;
}

/**
 * Build a single TurnNode from a group of events (one user msg + assistant responses).
 */
function buildSingleTurn(events: SessionEvent[], index: number): TurnNode | null {
  if (events.length === 0) return null;

  // Find the first real user message (with actual text, not just tool results)
  const userEvent = events.find((e) => e.message.role === "user" && isRealUserMessage(e.message));
  const rawInstruction = userEvent ? getMessageText(userEvent.message) : "";
  const userInstruction = cleanUserInstruction(rawInstruction);
  const { summary, category } = summarizeInstruction(userInstruction);

  // Collect all assistant data
  const allToolCalls: ToolCallSummary[] = [];
  const toolCounts: Record<string, number> = {};
  const filesChanged = new Set<string>();
  const filesRead = new Set<string>();
  const commands: string[] = [];
  const searches: string[] = [];
  const edits: string[] = [];
  const creates: string[] = [];
  const commitMessages: string[] = [];
  const escalationQuestions: string[] = [];
  let hasCommit = false;
  let commitMessage: string | null = null;
  let commitSha: string | null = null;
  const gitCommitCallIds = new Set<string>();
  let errorCount = 0;
  let turnHasCompaction = false;
  let compactionText: string | null = null;
  let assistantText = "";
  let thinkingText = "";

  // Token usage aggregation
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let model: string | null = null;

  // Plan mode & task tracking
  let hasPlanStart = false;
  let hasPlanEnd = false;
  let planMarkdown: string | null = null;
  let planRejected = false;
  const taskCreates: { taskId: string; subject: string; description: string }[] = [];
  const taskUpdates: { taskId: string; status: string }[] = [];

  // Check first event for planContent from JSONL envelope (set when user approves a plan)
  if (events[0]?.planContent) {
    planMarkdown = events[0].planContent;
  }

  // Track error→fix cycles for corrections
  const errorResults: Array<{ toolId: string; error: string }> = [];
  const toolCallSequence: Array<{ name: string; input: Record<string, unknown>; id: string }> = [];

  for (const event of events) {
    // Check user messages for tool results and errors
    if (event.message.role === "user") {
      const results = getToolResults(event.message);
      for (const result of results) {
        const isError = result.is_error === true;
        if (isError) {
          errorCount++;
          errorResults.push({
            toolId: result.tool_use_id,
            error: extractErrorSummary(result.content),
          });
        }
        // Extract commit SHA from git commit tool results
        if (gitCommitCallIds.has(result.tool_use_id)) {
          const shaMatch = result.content.match(/\[[\w\-\/]+\s+([a-f0-9]{7,})\]/);
          if (shaMatch) commitSha = shaMatch[1];
        }
        // Extract TaskCreate ID from "Task #N created successfully"
        const createMatch = result.content.match(/Task #(\d+) created successfully/);
        if (createMatch) {
          const pending = taskCreates.find(t => !t.taskId);
          if (pending) pending.taskId = createMatch[1];
        }
        // Check if ExitPlanMode was rejected
        if (result.content.includes("tool use was rejected") && hasPlanEnd) {
          planRejected = true;
          planMarkdown = null;
        }
      }
      continue;
    }

    // Process assistant messages
    // Collect thinking text
    const thinking = getThinkingText(event.message);
    if (thinking) {
      thinkingText += (thinkingText ? "\n" : "") + thinking;
    }

    // Collect text preview
    const text = getMessageText(event.message).trim();
    if (text && !assistantText) {
      assistantText = text;
    }

    // Collect search patterns
    const patterns = getSearchPatterns(event.message);
    searches.push(...patterns);

    // Collect tool calls
    const calls = getToolCalls(event.message);
    for (const call of calls) {
      allToolCalls.push({ name: call.name, input: call.input });
      toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
      toolCallSequence.push({ name: call.name, input: call.input, id: call.id });

      // Detect file changes
      if (call.name === "Write") {
        const filePath = extractFilePath(call.input);
        if (filePath) {
          filesChanged.add(filePath);
          creates.push(shortPath(filePath));
        }
      }
      if (call.name === "Edit" || call.name === "NotebookEdit") {
        const filePath = extractFilePath(call.input);
        if (filePath) {
          filesChanged.add(filePath);
          edits.push(shortPath(filePath));
        }
      }

      // Detect file reads
      if (call.name === "Read" || call.name === "Glob" || call.name === "Grep") {
        const filePath = extractFilePath(call.input);
        if (filePath) filesRead.add(filePath);
      }

      // Detect bash commands and git commits
      if (call.name === "Bash") {
        const cmd = extractCommand(call.input);
        if (cmd) {
          commands.push(cmd);
          if (isGitCommit(cmd)) {
            hasCommit = true;
            commitMessage = extractCommitMessage(cmd);
            if (commitMessage) commitMessages.push(commitMessage);
            gitCommitCallIds.add(call.id);
          }
        }
      }

      // Detect escalations (AskUserQuestion)
      if (call.name === "AskUserQuestion") {
        const questions = call.input.questions;
        if (Array.isArray(questions)) {
          for (const q of questions) {
            if (q && typeof q === "object" && "question" in q && typeof (q as Record<string, unknown>).question === "string") {
              escalationQuestions.push((q as Record<string, unknown>).question as string);
            }
          }
        }
      }

      // Detect plan mode
      if (call.name === "EnterPlanMode") {
        hasPlanStart = true;
      }
      if (call.name === "ExitPlanMode") {
        hasPlanEnd = true;
        if (typeof call.input.plan === "string") {
          planMarkdown = call.input.plan;
        }
      }

      // Detect task tracking
      if (call.name === "TaskCreate") {
        const input = call.input as Record<string, unknown>;
        taskCreates.push({
          taskId: "",
          subject: String(input.subject ?? ""),
          description: String(input.description ?? ""),
        });
      }
      if (call.name === "TaskUpdate") {
        const input = call.input as Record<string, unknown>;
        taskUpdates.push({
          taskId: String(input.taskId ?? ""),
          status: String(input.status ?? ""),
        });
      }
    }

    // Check for compaction
    if (hasCompaction(event.message)) {
      turnHasCompaction = true;
      compactionText = getCompactionText(event.message);
    }

    // Aggregate token usage and model from assistant events
    if (event.usage) {
      tokenUsage.inputTokens += event.usage.inputTokens;
      tokenUsage.outputTokens += event.usage.outputTokens;
      tokenUsage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
      tokenUsage.cacheCreationInputTokens += event.usage.cacheCreationInputTokens;
    }
    if (!model && event.model) {
      model = event.model;
    }
  }

  // Build sections
  const sections = buildSections({
    userInstruction,
    summary,
    thinkingText,
    assistantText,
    filesRead: [...filesRead],
    filesChanged: [...filesChanged],
    searches,
    edits,
    creates,
    commands,
    commitMessages,
    errorResults,
    toolCallSequence,
    escalationQuestions,
    errorCount,
    hasCommit,
    turnHasCompaction,
  });

  // Use the first event's real timestamp, fall back to epoch
  const timestamp = events[0]?.timestamp ?? new Date(0);

  return {
    id: `turn-${index}`,
    index,
    timestamp,
    summary,
    category,
    userInstruction: userInstruction.slice(0, 500),
    assistantPreview: assistantText.slice(0, 200),
    sections,
    toolCalls: allToolCalls,
    toolCounts,
    filesChanged: [...filesChanged],
    filesRead: [...filesRead],
    commands,
    hasCommit,
    commitMessage,
    commitSha,
    hasError: errorCount > 0,
    errorCount,
    hasCompaction: turnHasCompaction,
    compactionText,
    hasPlanStart,
    hasPlanEnd,
    planMarkdown,
    planRejected,
    taskCreates,
    taskUpdates,
    tokenUsage,
    model,
    durationMs: null,
    events,
    startLine: events[0].line,
    endLine: events[events.length - 1].line,
  };
}

/**
 * Build a full ParsedSession from a SessionInfo and its events.
 */
export function buildParsedSession(session: SessionInfo, events: SessionEvent[], systemMeta?: SystemMeta): ParsedSession {
  const turns = buildTurnNodes(events);

  // Attach durationMs from system metadata by matching timestamps
  if (systemMeta) {
    for (const dur of systemMeta.turnDurations) {
      // Find the closest turn by timestamp (within 60s)
      let bestTurn: TurnNode | null = null;
      let bestDiff = Infinity;
      for (const turn of turns) {
        const diff = Math.abs(turn.timestamp.getTime() - dur.timestamp.getTime());
        if (diff < bestDiff && diff < 60_000) {
          bestDiff = diff;
          bestTurn = turn;
        }
      }
      if (bestTurn) bestTurn.durationMs = dur.durationMs;
    }
  }

  const allFilesChanged = new Set<string>();
  const allToolsUsed: Record<string, number> = {};
  let totalToolCalls = 0;
  let commits = 0;
  let compactions = 0;
  let errorTurns = 0;
  let correctionTurns = 0;
  const totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const modelCounts = new Map<string, number>();

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

    // Aggregate token usage
    totalTokenUsage.inputTokens += turn.tokenUsage.inputTokens;
    totalTokenUsage.outputTokens += turn.tokenUsage.outputTokens;
    totalTokenUsage.cacheReadInputTokens += turn.tokenUsage.cacheReadInputTokens;
    totalTokenUsage.cacheCreationInputTokens += turn.tokenUsage.cacheCreationInputTokens;

    if (turn.model) {
      modelCounts.set(turn.model, (modelCounts.get(turn.model) ?? 0) + 1);
    }
  }

  // Primary model = most frequently used
  let primaryModel: string | null = null;
  let maxCount = 0;
  for (const [m, c] of modelCounts) {
    if (c > maxCount) { primaryModel = m; maxCount = c; }
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

// ─── Section Extraction ──────────────────────────────────────────────────────

interface SectionInput {
  userInstruction: string;
  summary: string;
  thinkingText: string;
  assistantText: string;
  filesRead: string[];
  filesChanged: string[];
  searches: string[];
  edits: string[];
  creates: string[];
  commands: string[];
  commitMessages: string[];
  errorResults: Array<{ toolId: string; error: string }>;
  toolCallSequence: Array<{ name: string; input: Record<string, unknown>; id: string }>;
  escalationQuestions: string[];
  errorCount: number;
  hasCommit: boolean;
  turnHasCompaction: boolean;
}

function buildSections(input: SectionInput): TurnSections {
  return {
    goal: buildGoalSection(input),
    approach: buildApproachSection(input),
    decisions: buildDecisionsSection(input),
    research: buildResearchSection(input),
    actions: buildActionsSection(input),
    corrections: buildCorrectionsSection(input),
    artifacts: buildArtifactsSection(input),
    escalations: buildEscalationsSection(input),
  };
}

function buildGoalSection(input: SectionInput): TurnSections["goal"] {
  return {
    summary: input.summary || "(no instruction)",
    fullInstruction: input.userInstruction,
  };
}

function buildApproachSection(input: SectionInput): TurnSections["approach"] {
  // Extract approach from thinking text — first few sentences that describe the plan
  let approachSummary = "";
  if (input.thinkingText) {
    approachSummary = extractApproachFromThinking(input.thinkingText);
  }
  if (!approachSummary && input.assistantText) {
    // Fall back to first sentence of assistant text
    approachSummary = extractFirstSentence(input.assistantText);
  }
  if (!approachSummary) {
    approachSummary = "(no approach captured)";
  }

  // Use thinking text if available, otherwise fall back to assistant text
  const detailText = input.thinkingText || input.assistantText;

  return {
    summary: approachSummary.slice(0, 150),
    thinking: detailText.slice(0, 2000),
  };
}

function buildDecisionsSection(input: SectionInput): TurnSections["decisions"] {
  const items: DecisionItem[] = [];

  if (input.thinkingText) {
    items.push(...extractDecisionsFromThinking(input.thinkingText));
  }

  const summary = items.length > 0
    ? items.map((d) => d.choice).join("; ").slice(0, 150)
    : "(no explicit decisions captured)";

  return { summary, items };
}

function buildResearchSection(input: SectionInput): TurnSections["research"] {
  const parts: string[] = [];
  if (input.filesRead.length > 0) parts.push(`Read ${input.filesRead.length} file${input.filesRead.length > 1 ? "s" : ""}`);
  if (input.searches.length > 0) parts.push(`${input.searches.length} search${input.searches.length > 1 ? "es" : ""}`);
  const summary = parts.length > 0 ? parts.join(", ") : "(no research)";

  return {
    summary,
    filesRead: input.filesRead.map(shortPath),
    searches: input.searches,
  };
}

function buildActionsSection(input: SectionInput): TurnSections["actions"] {
  const parts: string[] = [];
  if (input.creates.length > 0) parts.push(`Created ${input.creates.length} file${input.creates.length > 1 ? "s" : ""}`);
  if (input.edits.length > 0) parts.push(`edited ${input.edits.length} file${input.edits.length > 1 ? "s" : ""}`);
  if (input.commands.length > 0) parts.push(`ran ${input.commands.length} command${input.commands.length > 1 ? "s" : ""}`);
  const summary = parts.length > 0 ? parts.join(", ") : "(no actions)";

  return {
    summary,
    edits: input.edits,
    commands: input.commands.map((c) => c.length > 120 ? c.slice(0, 120) + "..." : c),
    creates: input.creates,
  };
}

function buildCorrectionsSection(input: SectionInput): TurnSections["corrections"] {
  const items: CorrectionItem[] = [];

  // Match error results to subsequent tool calls that look like retries/fixes
  for (const err of input.errorResults) {
    // Find the error-producing tool call
    const errCallIdx = input.toolCallSequence.findIndex((t) => t.id === err.toolId);
    if (errCallIdx < 0) {
      items.push({ error: err.error, fix: "(unresolved)" });
      continue;
    }
    const errCall = input.toolCallSequence[errCallIdx];

    // Look for the next tool call of the same type (retry) or an Edit after a Bash error
    let fix = "";
    for (let j = errCallIdx + 1; j < input.toolCallSequence.length && j <= errCallIdx + 5; j++) {
      const next = input.toolCallSequence[j];
      if (next.name === errCall.name) {
        fix = `Retried ${next.name}`;
        break;
      }
      if (next.name === "Edit" || next.name === "Write") {
        const fp = extractFilePath(next.input);
        fix = `Fixed in ${fp ? shortPath(fp) : next.name}`;
        break;
      }
    }
    items.push({ error: err.error, fix: fix || "(continued)" });
  }

  const summary = items.length > 0
    ? `${items.length} error${items.length > 1 ? "s" : ""} → ${items.filter((i) => i.fix !== "(unresolved)").length} fixed`
    : "(no errors)";

  return { summary, items };
}

function buildArtifactsSection(input: SectionInput): TurnSections["artifacts"] {
  const parts: string[] = [];
  if (input.filesChanged.length > 0) parts.push(`${input.filesChanged.length} file${input.filesChanged.length > 1 ? "s" : ""} changed`);
  if (input.commitMessages.length > 0) parts.push(`${input.commitMessages.length} commit${input.commitMessages.length > 1 ? "s" : ""}`);
  if (input.turnHasCompaction) parts.push("compaction");
  const summary = parts.length > 0 ? parts.join(", ") : "(no artifacts)";

  return {
    summary,
    filesChanged: input.filesChanged.map(shortPath),
    commits: input.commitMessages,
  };
}

function buildEscalationsSection(input: SectionInput): TurnSections["escalations"] {
  const summary = input.escalationQuestions.length > 0
    ? `Asked ${input.escalationQuestions.length} question${input.escalationQuestions.length > 1 ? "s" : ""}`
    : "(none)";

  return {
    summary,
    questions: input.escalationQuestions,
  };
}

// ─── Section Helpers ─────────────────────────────────────────────────────────

/** Extract the approach/plan from thinking text — looks for planning language. */
function extractApproachFromThinking(thinking: string): string {
  const lines = thinking.split("\n").filter((l) => l.trim().length > 0);

  // Look for lines with planning intent
  const planPatterns = [
    /^(?:I(?:'ll| will| need to| should| can)|Let me|First,? I|The (?:approach|plan|strategy) is|I'm going to)/i,
    /^(?:Step \d|1\.|My approach)/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (planPatterns.some((p) => p.test(trimmed))) {
      // Found a planning line — take it plus the next line for context
      const idx = lines.indexOf(line);
      const combined = lines.slice(idx, idx + 2).join(" ").trim();
      const sentence = extractFirstSentence(combined);
      if (sentence.length > 15) return sentence;
    }
  }

  // Fallback: first substantive sentence from thinking
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 20 && !trimmed.startsWith("```") && !trimmed.startsWith("//")) {
      return extractFirstSentence(trimmed);
    }
  }

  return "";
}

/** Extract decisions from thinking text — looks for choice/reasoning language. */
function extractDecisionsFromThinking(thinking: string): DecisionItem[] {
  const decisions: DecisionItem[] = [];
  const lines = thinking.split("\n");

  const decisionPatterns = [
    /(?:I'll|I will|Let me|Going to|I(?:'m| am) going to)\s+(?:use|go with|choose|pick|try|opt for|stick with)\s+(.+)/i,
    /(?:instead of|rather than|over)\s+(.+)/i,
    /(?:chose|decided on|picking|using)\s+(.+?)(?:\s+because|\s+since|\s+as\s)/i,
  ];

  const reasonPatterns = [
    /because\s+(.+)/i,
    /since\s+(.+)/i,
    /this (?:is|was) (?:better|simpler|more reliable|faster|cleaner|easier)\s*(?:because|since|as)?\s*(.*)/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    for (const pattern of decisionPatterns) {
      const match = line.match(pattern);
      if (match) {
        const choice = extractFirstSentence(line).slice(0, 120);
        let reasoning = "";

        // Look for reasoning in the same line or next few lines
        for (const rp of reasonPatterns) {
          const rm = line.match(rp);
          if (rm) {
            reasoning = extractFirstSentence(rm[1]).slice(0, 120);
            break;
          }
        }
        if (!reasoning) {
          // Check next line
          const nextLine = (lines[i + 1] ?? "").trim();
          for (const rp of reasonPatterns) {
            const rm = nextLine.match(rp);
            if (rm) {
              reasoning = extractFirstSentence(rm[1]).slice(0, 120);
              break;
            }
          }
        }

        decisions.push({ choice, reasoning });
        break; // One decision per line
      }
    }

    // Cap at 5 decisions per turn
    if (decisions.length >= 5) break;
  }

  return decisions;
}

/** Extract a concise error summary from a tool result. */
function extractErrorSummary(content: string): string {
  // Find the first line with an error indicator
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/(?:Error:|error:|ENOENT|EACCES|fatal:|Exit code|TypeError|SyntaxError|Cannot find)/.test(trimmed)) {
      return trimmed.slice(0, 120);
    }
  }
  return content.slice(0, 120);
}

/** Shorten a file path to just the last 2-3 segments. */
function shortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a user message contains real text content (not just tool results or system notifications).
 * Tool-result-only messages are responses to Claude's tool calls, not new user instructions.
 * System notifications (task-notification, system-reminder) are injected by the system.
 */
function isRealUserMessage(message: Message): boolean {
  const text = getRawUserText(message);
  if (!text) return false;
  // Reject pure system notifications that aren't real user input
  if (isSystemOnlyMessage(text)) return false;
  return true;
}

/** Extract raw text from a user message (string content or text blocks). */
function getRawUserText(message: Message): string | null {
  if (typeof message.content === "string") {
    const trimmed = message.content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(message.content)) {
    const texts = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b)
      .map((b) => b.text.trim())
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join("\n") : null;
  }

  return null;
}

/** Tags that indicate a system-injected message, not real user input. */
const SYSTEM_ONLY_TAGS = [
  "task-notification",
  "system-reminder",
];

/** Check if text is purely a system notification (no real user content). */
function isSystemOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  // Pure system tag messages
  for (const tag of SYSTEM_ONLY_TAGS) {
    if (trimmed.startsWith(`<${tag}>`) || trimmed.startsWith(`<${tag}\n`)) return true;
  }
  return false;
}

/**
 * Clean a user instruction for display — strip system tags, convert to human-readable.
 */
function cleanUserInstruction(raw: string): string {
  let text = raw;

  // Strip <system-reminder>...</system-reminder> blocks
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

  // Convert <task-notification> to readable summary
  text = text.replace(
    /<task-notification>[\s\S]*?<summary>(.*?)<\/summary>[\s\S]*?<\/task-notification>/g,
    (_, summary) => `[Background task: ${summary.trim()}]`
  );
  // Fallback for task-notification without summary
  text = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "[Background task completed]");

  // Convert slash commands to readable form
  text = text.replace(
    /<command-name>\/?([^<]+)<\/command-name>/g,
    (_, name) => `/${name.trim()}`
  );
  text = text.replace(/<command-message>[^<]*<\/command-message>\s*/g, "");
  text = text.replace(/<command-args>[^<]*<\/command-args>\s*/g, "");

  // Convert local command output to readable form
  text = text.replace(
    /<local-command-caveat>[^<]*<\/local-command-caveat>\s*/g,
    ""
  );
  text = text.replace(
    /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g,
    (_, output) => `[Command output: ${output.trim().slice(0, 100)}]`
  );

  // Strip any remaining XML-ish tags that look like system injections
  text = text.replace(/<\/?(?:user-prompt-submit-hook|environment-details|context)[^>]*>/g, "");

  // Clean up [Request interrupted] messages
  text = text.replace(/\[Request interrupted by user(?:\s+for tool use)?\]/g, "[Interrupted by user]");

  // Strip "Read the output file..." boilerplate after task notifications
  text = text.replace(/Read the output file to retrieve the result:.*$/gm, "").trim();

  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

/**
 * Generate a short summary and category from a cleaned user instruction.
 */
function summarizeInstruction(text: string): { summary: string; category: TurnCategory } {
  const trimmed = text.trim();

  // Empty / no real content
  if (!trimmed) {
    return { summary: "(continuation)", category: "continuation" };
  }

  // System-generated patterns
  if (trimmed.startsWith("[Interrupted")) {
    return { summary: "Interrupted", category: "interruption" };
  }
  if (trimmed.startsWith("[Background task")) {
    return { summary: trimmed.slice(1, trimmed.indexOf("]")), category: "system" };
  }
  if (trimmed.startsWith("[Command output")) {
    const output = trimmed.match(/\[Command output: (.*?)\]/)?.[1] ?? "command output";
    return { summary: output.slice(0, 80), category: "command" };
  }

  // Slash commands
  if (trimmed.startsWith("/")) {
    return { summary: trimmed.split("\n")[0].slice(0, 40), category: "command" };
  }

  // Very short continuations: "yes", "ok", "continue", "try again", etc.
  if (trimmed.length <= 20) {
    const lower = trimmed.toLowerCase();
    const continuationWords = ["yes", "ok", "okay", "continue", "go", "sure", "yeah", "yep", "do it", "try again", "yes save it", "yes please"];
    if (continuationWords.some((w) => lower === w || lower.startsWith(w + " "))) {
      return { summary: trimmed, category: "continuation" };
    }
  }

  // Terminal paste / context sharing (starts with common prompt patterns or has lots of $)
  if (/^\(base\)|^\$|^MacBook|^➜|^root@/.test(trimmed) || trimmed.startsWith("(base)")) {
    const firstLine = trimmed.split("\n")[0].slice(0, 80);
    return { summary: `Terminal: ${firstLine}`, category: "context" };
  }

  // "This session is being continued from..." — context resumption
  if (trimmed.startsWith("This session is being continued")) {
    return { summary: "Session continuation with context", category: "context" };
  }

  // Markdown plan/document — extract first heading
  const headingMatch = trimmed.match(/^#+ +(.+)/m);
  if (headingMatch && trimmed.length > 200) {
    return { summary: headingMatch[1].slice(0, 80), category: "task" };
  }

  // Now categorize by content
  const lower = trimmed.toLowerCase();
  const firstSentence = extractFirstSentence(trimmed);

  // Questions
  if (firstSentence.endsWith("?") || /^(how|what|why|when|where|which|can you explain|do you|is there|does)/i.test(trimmed)) {
    return { summary: firstSentence.slice(0, 80), category: "question" };
  }

  // Feedback/fix patterns
  if (/^(fix|this is wrong|that's wrong|change|update|modify|instead|actually|no,|but )/i.test(trimmed)) {
    return { summary: firstSentence.slice(0, 80), category: "feedback" };
  }

  // Task patterns
  if (/^(implement|build|create|add|write|make|set up|install|deploy|run|start|configure|can you)/i.test(trimmed)) {
    return { summary: firstSentence.slice(0, 80), category: "task" };
  }

  // Export/save patterns
  if (/^(export|save|capture|import|read|load|pull|fetch)/i.test(trimmed)) {
    return { summary: firstSentence.slice(0, 80), category: "task" };
  }

  // If first sentence is very short and there's more content, try to grab more context
  if (firstSentence.length < 30 && trimmed.length > firstSentence.length + 10) {
    const extended = extractFirstSentence(trimmed.slice(firstSentence.length).trim());
    if (extended.length > 5) {
      const combined = firstSentence + " " + extended;
      return { summary: combined.slice(0, 80), category: "conversation" };
    }
  }

  // Default: use first sentence, categorize as conversation
  return { summary: firstSentence.slice(0, 80), category: "conversation" };
}

/** Extract the first sentence (up to first period, question mark, or newline). */
function extractFirstSentence(text: string): string {
  // Take first line
  const firstLine = text.split("\n")[0].trim();

  // Try to find sentence boundary
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd < 120) {
    return firstLine.slice(0, sentenceEnd + 1);
  }

  // No sentence boundary found — truncate at word boundary
  if (firstLine.length > 80) {
    const truncated = firstLine.slice(0, 80);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated) + "...";
  }

  return firstLine;
}

function extractFilePath(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.notebook_path === "string") return input.notebook_path;
  return null;
}

function extractCommand(input: Record<string, unknown>): string | null {
  if (typeof input.command === "string") return input.command;
  return null;
}

function isGitCommit(cmd: string): boolean {
  return /git\s+commit/.test(cmd);
}

function extractCommitMessage(cmd: string): string | null {
  // Match heredoc style first (most common in Claude Code):
  // git commit -m "$(cat <<'EOF'\nmessage\n\nCo-Authored-By: ...\nEOF\n)"
  const heredocMatch = cmd.match(/cat\s+<<'?EOF'?\n([\s\S]*?)\n\s*EOF/);
  if (heredocMatch) {
    // Take first non-empty line as the commit message summary
    const lines = heredocMatch[1].trim().split("\n");
    const summary = lines.find((l) => l.trim().length > 0 && !l.startsWith("Co-Authored-By:"));
    return summary?.trim() ?? null;
  }

  // Match: git commit -m "message" or git commit -m 'message'
  const match = cmd.match(/git\s+commit\s+.*?-m\s+["']([^"']+)["']/);
  if (match) return match[1];

  return null;
}


