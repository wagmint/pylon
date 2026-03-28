"use client";

interface PanelHeaderProps {
  title: string;
  count?: string;
  children?: React.ReactNode;
}

export function PanelHeader({ title, count, children }: PanelHeaderProps) {
  return (
    <div className="sticky top-0 z-10 flex h-9 items-center justify-between px-3.5 text-2xs font-semibold tracking-[1.5px] uppercase text-dash-text-muted border-b border-dash-border bg-dash-bg">
      <span>{title}</span>
      <div className="flex items-center gap-2">
        {count && (
          <span className="bg-dash-surface-3 px-1.5 py-0.5 rounded text-dash-text-dim font-normal tracking-normal normal-case">
            {count}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}
