const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:7433";

export interface ControlState {
  generatedAt: string;
  workstreams: ControlWorkstream[];
}

export interface ControlWorkstream {
  id: string;
  projectPath: string;
  canonicalKey: string;
  title: string;
  summary: string | null;
  status: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  counts: {
    tasks: number;
    sessions: number;
    handoffs: number;
    blockers: number;
    decisions: number;
    artifacts: number;
  };
  state: {
    summary: string;
    lastActivityAt: string | null;
    activeTaskCount: number;
    blockedTaskCount: number;
    stalledTaskCount: number;
    completedTaskCount: number;
    sessionCount: number;
    confidence: number;
  } | null;
  evidence: ControlEvidence[];
  tasks: ControlTask[];
  sessions: ControlSession[];
  handoffs: ControlHandoff[];
  blockers: ControlBlocker[];
  decisions: ControlDecision[];
  artifacts: ControlArtifact[];
}

export interface ControlEvidence {
  evidenceType: string;
  sourceTable: string;
  sourceRowId: string | null;
  snippet: string | null;
  confidence: number;
  createdAt?: string;
}

export interface ControlTask {
  row: {
    id: string;
    title: string;
    description: string | null;
    taskType: "explicit" | "inferred";
    status: string;
    confidence: number;
    updatedAt: string;
  };
  groupingBasis: string[];
  sessions: Array<{
    sessionId: string;
    relationshipType: string;
    confidence: number;
  }>;
  evidence: ControlEvidence[];
  moduleAffinities: Array<{
    moduleKey: string;
    score: number;
    confidence: number;
    isDominant: boolean;
  }>;
  blockers: ControlBlocker[];
  decisions: ControlDecision[];
  artifacts: ControlArtifact[];
}

export interface ControlSession {
  row: {
    id: string;
    gitBranch: string | null;
    lastEventAt: string | null;
    endedAt: string | null;
    status: string;
  };
  state: {
    status: string;
    currentGoal: string;
    lastMeaningfulAction: string;
    resumeSummary: string;
    blockedReason: string | null;
    pendingApprovalCount: number;
    lastEventAt: string | null;
  } | null;
  filesInPlay: string[];
  tasks: Array<{
    taskId: string;
    relationshipType: string;
    confidence: number;
  }>;
  handoff: ControlHandoff | null;
  blockers: ControlBlocker[];
  decisions: ControlDecision[];
  artifacts: ControlArtifact[];
}

export interface ControlArtifact {
  row: {
    id: string;
    artifactType: string;
    title: string;
    description: string | null;
    filePath: string | null;
    commitSha: string | null;
    updatedAt: string;
  };
}

export interface ControlDecision {
  row: {
    id: string;
    decisionType: string;
    title: string;
    summary: string | null;
    status: string;
    confidence: number;
    decidedAt: string | null;
  };
  evidence: ControlEvidence[];
}

export interface ControlBlocker {
  row: {
    id: string;
    blockerType: string;
    title: string;
    summary: string | null;
    status: string;
    confidence: number;
    lastSeenAt: string | null;
  };
  evidence: ControlEvidence[];
}

export interface ControlHandoff {
  row: {
    id: string;
    sessionId: string;
    handoffType: string;
    title: string;
    summary: string;
    lastEventAt: string | null;
  };
  openQuestions: string[];
  nextSteps: string[];
  filesInPlay: string[];
  resumePackage: Record<string, unknown> | null;
}

// ─── Analytics Types ─────────────────────────────────────────────────────────

export interface AnalyticsState {
  generatedAt: string;

  fileHeatmap: {
    modules: Array<{
      moduleKey: string;
      touchCount: number;
      writeCount: number;
      readCount: number;
      sessionCount: number;
    }>;
    topFiles: Array<{
      filePath: string;
      moduleKey: string | null;
      writes: number;
      reads: number;
      total: number;
      sessionCount: number;
    }>;
  };

  cost: {
    totals: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      turns: number;
      sessions: number;
    };
    byWorkstream: Array<{
      workstreamTitle: string;
      turns: number;
      sessions: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
    }>;
  };

  activity: {
    daily: Array<{
      day: string;
      turns: number;
      sessions: number;
      outputTokens: number;
    }>;
    recentCommits: Array<{
      message: string | null;
      sha: string | null;
      timestamp: string | null;
      sessionId: string;
    }>;
    recentDecisions: Array<{
      title: string;
      status: string;
      summary: string | null;
      decidedAt: string | null;
    }>;
  };
}

// ─── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getControlState(): Promise<ControlState> {
  return fetchApi<ControlState>("/api/control");
}

export async function getAnalyticsState(): Promise<AnalyticsState> {
  return fetchApi<AnalyticsState>("/api/control/analytics");
}
