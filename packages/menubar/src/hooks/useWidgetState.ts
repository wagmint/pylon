import { useState, useRef, useCallback, useEffect } from "react";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

export type WidgetTier = "favicon" | "pill" | "card";

const TIER_SIZES: Record<WidgetTier, { width: number; height: number }> = {
  favicon: { width: 48, height: 48 },
  pill: { width: 200, height: 160 },
  card: { width: 320, height: 400 },
};

export interface WidgetState {
  tier: WidgetTier;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  onClickFavicon: () => void;
  collapseToFavicon: () => void;
  expandToCard: () => void;
  suppressAutoCollapse: boolean;
  setSuppressAutoCollapse: (v: boolean) => void;
}

export function useWidgetState(interactionsBlocked = false): WidgetState {
  const [tier, setTier] = useState<WidgetTier>("favicon");
  const [suppressAutoCollapse, setSuppressAutoCollapse] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizingRef = useRef(false);
  const saveDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, []);

  // Resize window keeping the right edge anchored at the same position.
  // Expanding grows leftward; collapsing shrinks rightward.
  const resizeWindow = useCallback(async (nextTier: WidgetTier) => {
    resizingRef.current = true;

    const win = getCurrentWindow();
    const { width, height } = TIER_SIZES[nextTier];
    const scale = window.devicePixelRatio || 1;

    const pos = await win.outerPosition();
    const size = await win.outerSize();

    const newPhysWidth = width * scale;
    const newPhysHeight = height * scale;
    const widthDelta = newPhysWidth - size.width;

    await win.setSize(new LogicalSize(width, height));

    // Anchor right edge: shift x left by the width increase
    let newX = pos.x - widthDelta;
    let newY = pos.y;

    // Keep on screen — use current monitor bounds (multi-monitor aware)
    const monitor = await currentMonitor();
    if (monitor) {
      const edgePad = 8 * scale; // small margin so content isn't flush with screen edges
      const monX = monitor.position.x;
      const monY = monitor.position.y;
      const monW = monitor.size.width;
      const monH = monitor.size.height;
      if (newX + newPhysWidth > monX + monW - edgePad) newX = monX + monW - newPhysWidth - edgePad;
      if (newY + newPhysHeight > monY + monH - edgePad) newY = monY + monH - newPhysHeight - edgePad;
      if (newX < monX + edgePad) newX = monX + edgePad;
      if (newY < monY) newY = monY;
    }

    await win.setPosition(new PhysicalPosition(newX, newY));

    // Clear resizing flag after a short delay so onMoved doesn't save the resize position
    setTimeout(() => { resizingRef.current = false; }, 200);
  }, []);

  const onHoverEnter = useCallback(() => {
    if (interactionsBlocked) return;
    clearCollapseTimer();
  }, [interactionsBlocked, clearCollapseTimer]);

  const onHoverLeave = useCallback(() => {
    if (interactionsBlocked) return;
    clearCollapseTimer();
  }, [interactionsBlocked, clearCollapseTimer]);

  const onClickFavicon = useCallback(() => {
    if (interactionsBlocked) return;
    clearCollapseTimer();
    if (tier === "favicon" || tier === "pill") {
      setTier("card");
      resizeWindow("card");
      getCurrentWindow().setFocus();
    }
  }, [interactionsBlocked, tier, clearCollapseTimer, resizeWindow]);

  const collapseToFavicon = useCallback(() => {
    clearCollapseTimer();
    setTier("favicon");
    resizeWindow("favicon");
  }, [clearCollapseTimer, resizeWindow]);

  const expandToCard = useCallback(() => {
    if (tier === "card") return;
    clearCollapseTimer();
    setTier("card");
    resizeWindow("card");
    getCurrentWindow().setFocus();
  }, [tier, clearCollapseTimer, resizeWindow]);

  // Save position when the user drags (not during programmatic resize)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onMoved(() => {
        if (resizingRef.current) return;
        if (saveDebounce.current) clearTimeout(saveDebounce.current);
        saveDebounce.current = setTimeout(async () => {
          try {
            const pos = await getCurrentWindow().outerPosition();
            await invoke("save_widget_position", { x: pos.x, y: pos.y });
          } catch {
            // Not critical
          }
        }, 500);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  // Always center on screen at startup
  useEffect(() => {
    (async () => {
      try {
        const win = getCurrentWindow();
        const scale = window.devicePixelRatio || 1;
        const widgetPhysSize = 48 * scale;
        const monitor = await currentMonitor() ?? await primaryMonitor();
        if (monitor) {
          const cx = monitor.position.x + Math.round((monitor.size.width - widgetPhysSize) / 2);
          const cy = monitor.position.y + Math.round((monitor.size.height - widgetPhysSize) / 2);
          await win.setPosition(new PhysicalPosition(cx, cy));
        }
      } catch {
        // Not critical
      }
    })();
  }, []);

  // Listen for focus loss to collapse card (unless suppressed by toast)
  useEffect(() => {
    if (tier !== "card") return;

    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    win.onFocusChanged(({ payload: focused }) => {
      if (!focused && !suppressAutoCollapse) {
        setTier("favicon");
        resizeWindow("favicon");
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, [tier, suppressAutoCollapse, resizeWindow]);

  // Listen for Escape key to collapse card
  useEffect(() => {
    if (tier !== "card") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTier("favicon");
        resizeWindow("favicon");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tier, resizeWindow]);

  return {
    tier,
    onHoverEnter,
    onHoverLeave,
    onClickFavicon,
    collapseToFavicon,
    expandToCard,
    suppressAutoCollapse,
    setSuppressAutoCollapse,
  };
}
