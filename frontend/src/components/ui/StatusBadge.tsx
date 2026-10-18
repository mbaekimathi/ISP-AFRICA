import { cn } from "@/lib/cn";

type Tone = {
  chip: string;
  live?: boolean;
};

export type StatusTone =
  | "active"
  | "online"
  | "due"
  | "expired"
  | "overdue"
  | "suspended"
  | "paused"
  | "disabled"
  | "offline"
  | "critical"
  | "error"
  | "blocked"
  | "pending"
  | "neutral";

const tones: Record<StatusTone, Tone> = {
  /* success */
  active: { chip: "border-success-border/60 bg-success-soft/70 text-success", live: true },
  online: { chip: "border-success-border/60 bg-success-soft/70 text-success", live: true },
  /* warning */
  due: { chip: "border-warning-border/60 bg-warning-soft/70 text-warning" },
  expired: { chip: "border-warning-border/60 bg-warning-soft/70 text-warning" },
  overdue: { chip: "border-warning-border/60 bg-warning-soft/70 text-warning" },
  /* warning, strong */
  suspended: { chip: "border-warning bg-warning text-warning-foreground" },
  /* muted */
  paused: { chip: "border-border bg-muted text-muted-foreground" },
  disabled: { chip: "border-border bg-muted text-muted-foreground" },
  offline: { chip: "border-border bg-muted text-muted-foreground" },
  /* destructive */
  critical: { chip: "border-destructive-border/60 bg-destructive-soft/70 text-destructive" },
  error: { chip: "border-destructive-border/60 bg-destructive-soft/70 text-destructive" },
  blocked: { chip: "border-destructive-border/60 bg-destructive-soft/70 text-destructive" },
  /* info */
  pending: { chip: "border-info-border/60 bg-info-soft/70 text-info" },
  /* neutral */
  neutral: { chip: "border-border bg-secondary text-secondary-foreground" },
};

function StatusDot({ live }: { live?: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0" aria-hidden="true">
      {live ? (
        <span className="animate-badge-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
      ) : null}
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: string;
  tone?: StatusTone;
}) {
  const t = tones[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-caption font-semibold",
        t.chip,
      )}
    >
      <StatusDot live={t.live} />
      {children}
    </span>
  );
}
