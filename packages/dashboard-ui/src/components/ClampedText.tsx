"use client";

import { createPortal } from "react-dom";
import { useRef, useState, useCallback, useEffect } from "react";

interface ClampedTextProps {
  text: string;
  lines: number;
  className?: string;
}

export function ClampedText({ text, lines, className = "" }: ClampedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  const checkTruncation = useCallback(() => {
    const el = ref.current;
    if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    checkTruncation();
  }, [text, checkTruncation]);

  function onEnter(e: React.MouseEvent) {
    if (!isTruncated) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ x: rect.left, y: rect.bottom + 4 });
  }

  function onLeave() {
    setTooltip(null);
  }

  return (
    <>
      <p
        ref={ref}
        className={className}
        style={{ WebkitLineClamp: lines, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {text}
      </p>
      {tooltip &&
        createPortal(
          <div
            style={{ position: "fixed", left: tooltip.x, top: tooltip.y, zIndex: 99999, maxWidth: 300 }}
            className="px-2 py-1.5 rounded bg-dash-surface-3 border border-dash-border shadow-lg"
          >
            <p className={`${className} break-words`} style={{ display: "block", overflow: "visible", WebkitLineClamp: "unset", WebkitBoxOrient: "unset" as never }}>
              {text}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
