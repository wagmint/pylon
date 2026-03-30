import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { OnboardingStep1 } from "./onboarding/OnboardingStep1";
import { OnboardingStep2 } from "./onboarding/OnboardingStep2";
import { OnboardingStep3 } from "./onboarding/OnboardingStep3";
import { StepIndicator } from "./onboarding/StepIndicator";

const TOTAL_STEPS = 3;

export function OnboardingWindow() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<"right" | "left">("right");
  const [animating, setAnimating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const completeOnboarding = useCallback(async (openDashboard = false) => {
    try {
      await invoke("save_has_completed_onboarding");
    } catch {}
    if (openDashboard) {
      open("http://localhost:7433");
    }
    getCurrentWindow().close();
  }, []);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= TOTAL_STEPS || next === step || animating) return;
      setDirection(next > step ? "right" : "left");
      setAnimating(true);
      setStep(next);
    },
    [step, animating]
  );

  const next = useCallback(() => {
    if (step === TOTAL_STEPS - 1) {
      completeOnboarding(false);
    } else {
      goTo(step + 1);
    }
  }, [step, goTo, completeOnboarding]);

  const back = useCallback(() => goTo(step - 1), [step, goTo]);

  // Keyboard navigation — suppress when input/textarea is focused
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") completeOnboarding(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, back, completeOnboarding]);

  const renderStep = () => {
    switch (step) {
      case 0: return <OnboardingStep1 />;
      case 1: return <OnboardingStep2 />;
      case 2: return <OnboardingStep3 onJoinComplete={() => completeOnboarding(true)} />;
      default: return null;
    }
  };

  return (
    <div className="w-[500px] h-[600px] flex flex-col bg-dash-bg border border-dash-border rounded-2xl overflow-hidden">
      {/* Draggable top bar */}
      <div
        className="h-10 flex items-center justify-center shrink-0 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => {
          if (e.button === 0) getCurrentWindow().startDragging();
        }}
      >
        <div className="flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-dash-text-muted/30" />
          <span className="w-1.5 h-1.5 rounded-full bg-dash-text-muted/30" />
          <span className="w-1.5 h-1.5 rounded-full bg-dash-text-muted/30" />
        </div>
      </div>

      {/* Step content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
      >
        <div
          key={step}
          className={`absolute inset-0 overflow-y-auto ${
            direction === "right" ? "animate-slide-in-right" : "animate-slide-in-left"
          }`}
          onAnimationEnd={() => setAnimating(false)}
        >
          {renderStep()}
        </div>
      </div>

      {/* Footer: indicators + navigation */}
      <div className="shrink-0 px-6 py-4 border-t border-dash-border flex items-center justify-between">
        <div className="w-20">
          {step > 0 && (
            <button
              onClick={back}
              className="text-xs text-dash-text-dim hover:text-dash-text transition-colors"
            >
              Back
            </button>
          )}
        </div>

        <StepIndicator total={TOTAL_STEPS} current={step} onSelect={goTo} />

        <div className="w-20 flex justify-end gap-3">
          {step < TOTAL_STEPS - 1 && (
            <button
              onClick={() => completeOnboarding(false)}
              className="text-xs text-dash-text-muted hover:text-dash-text transition-colors"
            >
              Skip
            </button>
          )}
          <button
            onClick={next}
            className="text-xs font-medium text-dash-blue hover:text-dash-text transition-colors"
          >
            {step === TOTAL_STEPS - 1 ? "Skip \u2192" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
