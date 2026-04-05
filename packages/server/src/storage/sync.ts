import { listProjects, listSessions } from "../discovery/sessions.js";
import {
  ensureClaudeIngestionCheckpoint,
  markMissingClaudeTranscriptSourcesInactive,
  upsertClaudeSession,
  upsertClaudeTranscriptSource,
} from "./repositories.js";

export function syncClaudeSessionsToStorage(): { projectCount: number; sessionCount: number } {
  const projects = listProjects();
  const seenSessionIds: string[] = [];

  for (const project of projects) {
    const sessions = listSessions(project.encodedName);
    for (const session of sessions) {
      const transcriptSourceId = upsertClaudeTranscriptSource(session);
      ensureClaudeIngestionCheckpoint(transcriptSourceId);
      upsertClaudeSession(session, transcriptSourceId);
      seenSessionIds.push(session.id);
    }
  }

  markMissingClaudeTranscriptSourcesInactive(seenSessionIds);

  return {
    projectCount: projects.length,
    sessionCount: seenSessionIds.length,
  };
}
