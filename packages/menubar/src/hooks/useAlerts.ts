import { useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { DashboardState } from "../lib/types";
import {
  deriveAlerts,
  worstSeverity,
  type HexcoreAlert,
  type TraySeverity,
} from "../lib/alerts";

interface UseAlertsResult {
  alerts: HexcoreAlert[];
  severity: TraySeverity;
}

export function useAlerts(
  state: DashboardState | null,
  connected: boolean,
): UseAlertsResult {
  const prevSeverity = useRef<string>("grey");
  const seenAlertIds = useRef<Set<string>>(new Set());
  const initialLoad = useRef(true);

  const alerts = useMemo(() => {
    if (!state) return [];
    return deriveAlerts(state);
  }, [state]);

  const severity: TraySeverity = useMemo(() => {
    if (!connected || !state) return "grey";
    return worstSeverity(alerts, state);
  }, [alerts, connected, state]);

  // Update tray icon when severity changes
  useEffect(() => {
    if (severity !== prevSeverity.current) {
      prevSeverity.current = severity;
      invoke("update_tray_icon", { color: severity }).catch(() => {
        // Tray icon update failed — not critical
      });
    }
  }, [severity]);

  // Send notifications for new red alerts
  const sendAlertNotification = useCallback(
    async (alert: HexcoreAlert) => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          const permission = await requestPermission();
          granted = permission === "granted";
        }
        if (granted) {
          sendNotification({
            title: alert.title,
            body: alert.detail,
          });
        }
      } catch {
        // Notification failed — not critical
      }
    },
    [],
  );

  useEffect(() => {
    if (initialLoad.current) {
      // On first load, just record existing alert IDs without notifying
      initialLoad.current = false;
      for (const alert of alerts) {
        seenAlertIds.current.add(alert.id);
      }
      return;
    }

    for (const alert of alerts) {
      if (alert.severity === "blue" && !seenAlertIds.current.has(alert.id)) {
        sendAlertNotification(alert);
      }
      seenAlertIds.current.add(alert.id);
    }
  }, [alerts, sendAlertNotification]);

  return { alerts, severity };
}
