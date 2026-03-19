"use client";

import { useState } from "react";
import type { RelayTargetInfo, ActiveProject } from "../types";

export interface PendingOnboarding {
  claimId: string;
  hexcoreName: string;
  hexcoreId: string;
  joinUrl: string;
}

export interface RelayPanelProps {
  targets: RelayTargetInfo[];
  activeProjects: ActiveProject[];
  pendingOnboarding: PendingOnboarding | null;
  onConnect: (link: string) => Promise<{ error?: string; needsOnboarding?: boolean }>;
  onRemove: (hexcoreId: string) => void;
  onToggleProject: (hexcoreId: string, projectPath: string, include: boolean) => void;
  onOpenJoinUrl: () => void;
  onCancelOnboarding: () => void;
  onClose: () => void;
}

export function RelayPanel({
  targets,
  activeProjects,
  pendingOnboarding,
  onConnect,
  onRemove,
  onToggleProject,
  onOpenJoinUrl,
  onCancelOnboarding,
  onClose,
}: RelayPanelProps) {
  const [link, setLink] = useState("");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    if (!link.trim()) return;
    setConnecting(true);
    setConnectError(null);
    const result = await onConnect(link.trim());
    setConnecting(false);
    if (result.error) {
      setConnectError(result.error);
    } else {
      setLink("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleConnect();
  };

  return (
    <div className="flex flex-col h-full bg-dash-surface border-l border-dash-border font-mono text-[11px]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-10 border-b border-dash-border shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-[9px] font-semibold tracking-[1.5px] uppercase text-dash-text-muted">
            Relay
          </span>
          <a
            href="https://www.hexcore.app/docs/hexcore/cloud-relay"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-dash-blue/10 border border-dash-blue/20 text-dash-blue hover:bg-dash-blue/20 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polygon points="512,232 746,367 746,657 512,792 278,657 278,367" fill="none" stroke="#22AAF8" strokeWidth="48" opacity="0.9" />
              <polygon points="512,418 618,479 618,601 512,662 406,601 406,479" fill="#4BCFFF" />
            </svg>
            <span className="text-[9px] font-semibold tracking-wider">HEXCORE</span>
          </a>
        </div>
        <button
          onClick={onClose}
          className="text-dash-text-muted hover:text-dash-text transition-colors px-1"
        >
          &times;
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-4">
        {/* Onboarding card — shown when waiting for user to join via web */}
        {pendingOnboarding && (
          <OnboardingCard
            onboarding={pendingOnboarding}
            onOpenJoinUrl={onOpenJoinUrl}
            onCancel={onCancelOnboarding}
          />
        )}

        {/* Connect section — hidden during onboarding */}
        {!pendingOnboarding && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="hexcore+wss://..."
                className="flex-1 bg-dash-bg border border-dash-border rounded px-2 py-1 text-[11px] font-mono text-dash-text placeholder:text-dash-text-muted focus:outline-none focus:border-dash-blue"
              />
              <button
                onClick={handleConnect}
                disabled={connecting || !link.trim()}
                className="px-3 py-1 bg-dash-surface-3 border border-dash-border rounded text-[10px] text-dash-text-dim hover:text-dash-text hover:bg-dash-surface-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {connecting ? "..." : "Connect"}
              </button>
            </div>
            {connectError && (
              <div className="text-dash-red text-[10px]">{connectError}</div>
            )}
          </div>
        )}

        {/* Target cards */}
        {targets.length === 0 && !pendingOnboarding ? (
          <div className="text-center text-dash-text-muted text-xs py-6">
            No relay targets. Paste a connect link to get started.
          </div>
        ) : (
          <div className="space-y-3">
            {targets.map((target) => (
              <TargetCard
                key={target.hexcoreId}
                target={target}
                activeProjects={activeProjects}
                onRemove={onRemove}
                onToggleProject={onToggleProject}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OnboardingCard({
  onboarding,
  onOpenJoinUrl,
  onCancel,
}: {
  onboarding: PendingOnboarding;
  onOpenJoinUrl: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border border-dash-blue/30 rounded bg-dash-bg p-4 space-y-3">
      <div className="space-y-1">
        <div className="text-dash-text font-semibold text-xs">
          Join &ldquo;{onboarding.hexcoreName}&rdquo;
        </div>
        <div className="text-dash-text-dim text-[10px]">
          Sign in at hexcore.app to continue
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onOpenJoinUrl}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-dash-blue/10 border border-dash-blue/30 rounded text-[10px] text-dash-blue hover:bg-dash-blue/20 transition-colors"
        >
          Open Hexcore
          <span className="text-[9px]">&rarr;</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-dash-text-muted flex items-center gap-1.5">
            Waiting
            <span className="inline-block w-1 h-1 rounded-full bg-dash-blue animate-dash-pulse" />
          </span>
        </div>
      </div>

      <button
        onClick={onCancel}
        className="text-[9px] text-dash-text-muted hover:text-dash-text transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function TargetCard({
  target,
  activeProjects,
  onRemove,
  onToggleProject,
}: {
  target: RelayTargetInfo;
  activeProjects: ActiveProject[];
  onRemove: (hexcoreId: string) => void;
  onToggleProject: (hexcoreId: string, projectPath: string, include: boolean) => void;
}) {
  const statusDot = {
    connected: "bg-dash-green",
    connecting: "bg-dash-yellow animate-dash-pulse",
    disconnected: "bg-dash-text-muted",
    auth_expired: "bg-dash-red",
  }[target.status];

  const statusLabel = {
    connected: "connected",
    connecting: "connecting",
    disconnected: "disconnected",
    auth_expired: "reconnect required",
  }[target.status];
  const isAuthExpired = target.status === "auth_expired";

  return (
    <div className="border border-dash-border rounded bg-dash-bg p-3 space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
          <span className="text-dash-text truncate font-semibold">{target.hexcoreName}</span>
          <span className="text-dash-text-muted text-[9px] shrink-0">
            {target.hexcoreId.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[9px] ${isAuthExpired ? "text-dash-red" : "text-dash-text-muted"}`}>
            {statusLabel}
          </span>
          <button
            onClick={() => onRemove(target.hexcoreId)}
            className="text-[9px] text-dash-red/60 hover:text-dash-red transition-colors"
          >
            Remove
          </button>
        </div>
      </div>

      {isAuthExpired && (
        <div className="pt-1 border-t border-dash-border text-[10px] text-dash-red">
          This connection expired. Paste a new connect link to restore sync.
        </div>
      )}

      {/* Project toggles */}
      {!isAuthExpired && activeProjects.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-dash-border">
          {activeProjects.map((proj) => {
            const included = target.projects.includes(proj.projectPath);
            return (
              <div
                key={proj.projectPath}
                className="flex items-center justify-between gap-2 py-0.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-dash-text-dim truncate" title={proj.projectPath}>
                    {abbreviatePath(proj.projectPath)}
                  </span>
                  <span className="text-[9px] text-dash-text-muted shrink-0">
                    {proj.sessionCount} session{proj.sessionCount !== 1 ? "s" : ""}
                  </span>
                </div>
                <button
                  onClick={() => onToggleProject(target.hexcoreId, proj.projectPath, !included)}
                  className={`w-7 h-4 rounded-full relative transition-colors shrink-0 ${
                    included ? "bg-dash-green/40" : "bg-dash-surface-3"
                  }`}
                >
                  <span
                    className={`block w-3 h-3 rounded-full absolute top-0.5 transition-all ${
                      included
                        ? "left-3.5 bg-dash-green"
                        : "left-0.5 bg-dash-text-muted"
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function abbreviatePath(p: string): string {
  // Replace home directory prefix with ~
  const home =
    typeof process !== "undefined"
      ? process.env?.HOME || process.env?.USERPROFILE || ""
      : "";
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}
