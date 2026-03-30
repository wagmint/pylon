import { useState, useRef, useCallback, useEffect } from "react";
import { GlowHex } from "../GlowHex";
import {
  resolveInviteInput,
  executeJoinFlow,
  type JoinParams,
  type JoinPhase,
} from "../../lib/join";

type Phase = "idle" | "validating" | "ready" | "joining" | "success" | "error";

interface Props {
  onJoinComplete?: () => void;
}

export function OnboardingStep3({ onJoinComplete }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [input, setInput] = useState("");
  const [params, setParams] = useState<JoinParams | null>(null);
  const [joinPhase, setJoinPhase] = useState<JoinPhase | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const validate = useCallback(async (value: string) => {
    // Cancel any in-flight request
    abortRef.current?.abort();

    const trimmed = value.trim();
    if (!trimmed) {
      setPhase("idle");
      setParams(null);
      setErrorMsg("");
      return;
    }

    setPhase("validating");
    setErrorMsg("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resolved = await resolveInviteInput(trimmed, controller.signal);
      if (controller.signal.aborted) return;
      setParams(resolved);
      setPhase("ready");
    } catch (err) {
      if (controller.signal.aborted) return;
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : "Invalid invite");
    }
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => validate(value), 300);
    },
    [validate]
  );

  const handleJoin = useCallback(async () => {
    if (!params || phase !== "ready") return;

    setPhase("joining");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const result = await executeJoinFlow(
      params,
      (p) => setJoinPhase(p),
      controller.signal
    );

    if (controller.signal.aborted) return;

    if (result.ok) {
      setPhase("success");
      setTimeout(() => onJoinComplete?.(), 1500);
    } else {
      setPhase("error");
      setErrorMsg(result.error || "Failed to join");
    }
  }, [params, phase, onJoinComplete]);

  const handleTryAgain = useCallback(() => {
    setPhase("idle");
    setInput("");
    setParams(null);
    setErrorMsg("");
    setJoinPhase(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const phaseLabel: Record<JoinPhase, string> = {
    "waiting-for-server": "Starting server...",
    "creating-claim": "Setting up...",
    "browser-auth": "Complete sign-in in browser...",
    polling: "Waiting for confirmation...",
    done: "Done!",
  };

  return (
    <div className="flex flex-col items-center text-center px-8 pt-8 pb-4 gap-6">
      <GlowHex
        severity={phase === "success" ? "green" : phase === "error" ? "red" : "blue"}
        size={16}
        className="animate-dash-breathe"
      />

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-dash-text">Join a Team</h2>
        <p className="text-sm text-dash-text-dim leading-relaxed">
          Paste an invite link to connect your Hexdeck to a team.
        </p>
      </div>

      <div className="w-full space-y-3">
        {/* Input */}
        {phase !== "success" && (
          <input
            type="text"
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onPaste={(e) => {
              // Validate immediately on paste instead of waiting for debounce
              const pasted = e.clipboardData.getData("text");
              setTimeout(() => validate(pasted), 0);
            }}
            placeholder="Paste invite link or token..."
            disabled={phase === "joining"}
            className="w-full px-4 py-3 rounded-lg bg-dash-surface border border-dash-border text-sm text-dash-text placeholder:text-dash-text-muted focus:outline-none focus:border-dash-blue transition-colors disabled:opacity-50"
            autoFocus
          />
        )}

        {/* Validating spinner */}
        {phase === "validating" && (
          <div className="flex items-center justify-center gap-2 py-2">
            <div className="w-3 h-3 border-2 border-dash-blue border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-dash-text-dim">Looking up invite...</span>
          </div>
        )}

        {/* Team card (ready / joining) */}
        {(phase === "ready" || phase === "joining") && params && (
          <div className="w-full bg-dash-surface rounded-lg px-5 py-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-dash-blue/20 flex items-center justify-center">
                <span className="text-sm font-semibold text-dash-blue">
                  {params.hexcoreName.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="text-left">
                <p className="text-sm font-medium text-dash-text">
                  {params.hexcoreName}
                </p>
                {params.memberCount != null && (
                  <p className="text-xs text-dash-text-dim">
                    {params.memberCount} {params.memberCount === 1 ? "member" : "members"}
                  </p>
                )}
              </div>
            </div>

            <button
              onClick={handleJoin}
              disabled={phase === "joining"}
              className="w-full py-2.5 rounded-md bg-dash-green/20 text-dash-green text-xs font-medium hover:bg-dash-green/30 transition-colors disabled:opacity-50 disabled:cursor-default"
            >
              {phase === "joining"
                ? (joinPhase ? phaseLabel[joinPhase] : "Joining...")
                : `Join ${params.hexcoreName}`}
            </button>
          </div>
        )}

        {/* Success */}
        {phase === "success" && params && (
          <div className="w-full bg-dash-surface rounded-lg px-5 py-6 flex flex-col items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-dash-green/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-dash-green" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm font-medium text-dash-text">
              Connected to {params.hexcoreName}!
            </p>
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="w-full text-center space-y-2 py-2">
            <p className="text-xs text-dash-red">{errorMsg}</p>
            <button
              onClick={handleTryAgain}
              className="text-xs text-dash-text-dim hover:text-dash-text transition-colors underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
