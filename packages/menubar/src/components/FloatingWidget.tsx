import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TraySeverity, HexcoreAlert } from "../lib/alerts";
import type { DashboardState } from "../lib/types";
import type { FlatBranch } from "../hooks/useSurfacing";
import type { WidgetState } from "../hooks/useWidgetState";
import type { JoinToast } from "../hooks/useDeepLink";
import { FaviconIcon } from "./FaviconIcon";
import { SummaryPill } from "./SummaryPill";
import { ExpandedCard } from "./ExpandedCard";
import { SpeechBubbleTooltip } from "./SpeechBubbleTooltip";

interface TooltipState {
  showTooltip: boolean;
  blockWidgetInteractions: boolean;
  dismiss: () => void;
}

interface FloatingWidgetProps {
  widget: WidgetState;
  tooltip: TooltipState;
  severity: TraySeverity;
  state: DashboardState | null;
  alerts: HexcoreAlert[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  joinToast?: JoinToast | null;
  clearJoinToast?: () => void;
  branches: FlatBranch[];
}

export function FloatingWidget({
  widget,
  tooltip,
  severity,
  state,
  alerts,
  connected,
  loading,
  error,
  joinToast,
  clearJoinToast,
  branches,
}: FloatingWidgetProps) {
  // Drag-or-click: start drag only after 3px of movement, otherwise treat as click
  const handleMouseDown = (e: React.MouseEvent) => {
    if (widget.tier === "card") return; // Card has its own drag handler on the header
    if (e.button !== 0) return;

    const startX = e.screenX;
    const startY = e.screenY;

    const onMove = (moveE: MouseEvent) => {
      if (Math.abs(moveE.screenX - startX) > 3 || Math.abs(moveE.screenY - startY) > 3) {
        cleanup();
        getCurrentWindow().startDragging();
      }
    };

    const onUp = () => {
      cleanup();
      // No significant movement → treat as click
      if (tooltip.showTooltip) {
        tooltip.dismiss();
        return;
      }
      widget.onClickFavicon();
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const handleHoverEnter = () => {
    if (tooltip.blockWidgetInteractions) return;
    widget.onHoverEnter();
  };

  const handleHoverLeave = () => {
    if (tooltip.blockWidgetInteractions) return;
    widget.onHoverLeave();
  };

  return (
    <div
      // Nearly-invisible bg forces macOS to deliver mouse events to transparent window areas
      style={{ background: "rgba(0,0,0,0.01)" }}
      onMouseEnter={handleHoverEnter}
      onMouseLeave={handleHoverLeave}
      onMouseDown={handleMouseDown}
    >
      {tooltip.showTooltip && (
        <div style={{ width: 320, height: 100, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
          <SpeechBubbleTooltip onDismiss={tooltip.dismiss} />
          <div className="flex-shrink-0">
            <FaviconIcon severity={severity} />
          </div>
        </div>
      )}
      {!tooltip.showTooltip && widget.tier === "favicon" && (
        <FaviconIcon severity={severity} />
      )}
      {!tooltip.showTooltip && widget.tier === "pill" && (
        <SummaryPill
          severity={severity}
          state={state}
          connected={connected}
        />
      )}
      {!tooltip.showTooltip && widget.tier === "card" && (
        <ExpandedCard
          severity={severity}
          state={state}
          alerts={alerts}
          connected={connected}
          loading={loading}
          error={error}
          onClose={widget.collapseToFavicon}
          joinToast={joinToast}
          clearJoinToast={clearJoinToast}
          branches={branches}
        />
      )}
    </div>
  );
}
