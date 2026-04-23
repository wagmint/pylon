import { getCurrentWindow } from "@tauri-apps/api/window";
import { useHexcoreSSE } from "./hooks/useHexcoreSSE";
import { useAlerts } from "./hooks/useAlerts";
import { useSurfacing } from "./hooks/useSurfacing";
import { useAutoUpdate } from "./hooks/useAutoUpdate";
import { useDeepLink } from "./hooks/useDeepLink";
import { MenuBarApp } from "./components/MenuBarApp";
import { WidgetApp } from "./components/WidgetApp";
import { OnboardingWindow } from "./components/OnboardingWindow";

const windowLabel = getCurrentWindow().label;

export default function App() {
  if (windowLabel === "onboarding") {
    return <OnboardingWindow />;
  }

  return <MainApp />;
}

function MainApp() {
  useAutoUpdate();
  const { state, surfacing, loading, error, connected } = useHexcoreSSE();
  const { alerts, severity } = useAlerts(state, connected);
  const { branches } = useSurfacing(surfacing, connected);
  const { toast: joinToast, clearToast: clearJoinToast } = useDeepLink(windowLabel === "main");

  if (windowLabel === "widget") {
    return (
      <WidgetApp
        severity={severity}
        state={state}
        alerts={alerts}
        connected={connected}
        loading={loading}
        error={error}
        joinToast={joinToast}
        clearJoinToast={clearJoinToast}
        branches={branches}
      />
    );
  }

  return (
    <MenuBarApp
      state={state}
      alerts={alerts}
      severity={severity}
      connected={connected}
      loading={loading}
      error={error}
      joinToast={joinToast}
      clearJoinToast={clearJoinToast}
      branches={branches}
    />
  );
}
