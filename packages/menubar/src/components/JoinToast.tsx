import { open } from "@tauri-apps/plugin-shell";
import type { JoinToast as JoinToastType } from "../hooks/useDeepLink";

function getDashboardUrl(hexcoreId: string, wsUrl?: string): string {
  if (!wsUrl) return `https://hexcore.app/dashboard/${hexcoreId}`;
  // ws://localhost:3010/ws → http://localhost:3000
  // wss://relay.hexcore.app/ws → https://hexcore.app
  const httpBase = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/ws\/?$/, "");
  if (httpBase.includes("hexcore.app")) {
    return `${httpBase.replace(/^(https?:\/\/)relay\./, "$1")}/dashboard/${hexcoreId}`;
  }
  // Dev: relay is on :3010, web app is on :3000
  return `${httpBase.replace(/:\d+$/, ":3000")}/dashboard/${hexcoreId}`;
}

interface JoinToastProps {
  toast: JoinToastType;
  onDismiss: () => void;
}

export function JoinToast({ toast, onDismiss }: JoinToastProps) {
  if (toast.type === "error") {
    return (
      <div className="mx-3 mt-2 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-red-400">Join Failed</span>
          <button onClick={onDismiss} className="text-[10px] text-dash-text-muted hover:text-dash-text">
            dismiss
          </button>
        </div>
        <p className="text-[11px] text-dash-text-dim mt-1">{toast.message}</p>
      </div>
    );
  }

  return (
    <div className="mx-3 mt-2 bg-dash-green/8 border border-dash-green/20 rounded-lg px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-dash-green" />
          <span className="text-xs font-medium text-dash-green">{toast.message}</span>
        </div>
        <button onClick={onDismiss} className="text-[10px] text-dash-text-muted hover:text-dash-text">
          dismiss
        </button>
      </div>
      <div className="mt-1.5 pl-3.5 flex flex-col gap-1">
        {toast.hexcoreId && (
          <button
            onClick={() => open(getDashboardUrl(toast.hexcoreId!, toast.wsUrl))}
            className="text-[11px] text-dash-blue hover:text-dash-text transition-colors text-left"
          >
            View team dashboard &rarr;
          </button>
        )}
        <button
          onClick={() => open("http://localhost:7433")}
          className="text-[11px] text-dash-blue hover:text-dash-text transition-colors text-left"
        >
          Manage projects
        </button>
      </div>
    </div>
  );
}
