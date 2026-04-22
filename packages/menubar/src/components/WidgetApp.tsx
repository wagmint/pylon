import { useEffect } from "react";
import type { TraySeverity, HexcoreAlert } from "../lib/alerts";
import type { StatusActionState, WorkstreamStatusAction } from "../lib/surfacing-types";
import type { DashboardState } from "../lib/types";
import type { FlatWorkstream, FlatUnassigned } from "../hooks/useSurfacing";
import type { JoinToast } from "../hooks/useDeepLink";
import { useWidgetState } from "../hooks/useWidgetState";
import { useFirstLaunchTooltip } from "../hooks/useFirstLaunchTooltip";
import { FloatingWidget } from "./FloatingWidget";

interface WidgetAppProps {
  severity: TraySeverity;
  state: DashboardState | null;
  alerts: HexcoreAlert[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  joinToast: JoinToast | null;
  clearJoinToast: () => void;
  allWorkstreams: FlatWorkstream[];
  allUnassigned: FlatUnassigned[];
  reportStatus: (hexcoreId: string, workstreamId: string, action: WorkstreamStatusAction) => void;
  statusActions: Map<string, StatusActionState>;
}

export function WidgetApp({ joinToast, clearJoinToast, ...props }: WidgetAppProps) {
  const tooltip = useFirstLaunchTooltip();
  const widget = useWidgetState(tooltip.blockWidgetInteractions);

  // When a join toast appears, expand to card and suppress auto-collapse
  useEffect(() => {
    if (joinToast) {
      widget.expandToCard();
      widget.setSuppressAutoCollapse(true);
    } else {
      widget.setSuppressAutoCollapse(false);
    }
  }, [joinToast]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FloatingWidget
      widget={widget}
      tooltip={tooltip}
      joinToast={joinToast}
      clearJoinToast={clearJoinToast}
      {...props}
    />
  );
}
