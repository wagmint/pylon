"use client";

import { useState, useRef, useCallback, type ReactNode } from "react";

interface TipProps {
  text: string;
  children: ReactNode;
  /** Use "inline" when inside a flex row with siblings, "block" for full-width rows */
  display?: "block" | "inline";
}

/**
 * Lightweight hover tooltip. Shows after a short delay, positioned above the target.
 */
export function Tip({ text, children, display = "block" }: TipProps) {
  const [visible, setVisible] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback(() => {
    timeout.current = setTimeout(() => setVisible(true), 400);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(timeout.current);
    setVisible(false);
  }, []);

  const cls = display === "inline" ? "relative inline-flex" : "relative";

  return (
    <div className={cls} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <div className="absolute bottom-full left-0 mb-1.5 px-2 py-1 rounded text-2xs leading-tight text-dash-text bg-dash-surface-3 border border-dash-border z-50 pointer-events-none shadow-lg max-w-[200px]">
          {text}
        </div>
      )}
    </div>
  );
}
