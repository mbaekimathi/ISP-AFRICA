import type { ReactNode } from "react";

export function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </article>
  );
}

export function PreviewFrame({
  children,
  label = "Illustrative product preview",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-lift">
      <div className="flex items-center gap-2 border-b border-border bg-surface-muted px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/80" />
        <p className="ml-2 truncate text-xs font-medium text-muted-foreground">{label} · sample data</p>
      </div>
      {children}
    </div>
  );
}
