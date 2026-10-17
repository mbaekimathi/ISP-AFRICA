import { cn } from "@/lib/cn";

const tones = {
  active: "bg-success/15 text-success",
  due: "bg-warning/15 text-warning",
  critical: "bg-destructive/15 text-destructive",
  paused: "bg-muted text-muted-foreground",
  neutral: "bg-secondary text-secondary-foreground",
} as const;

export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: string;
  tone?: keyof typeof tones;
}) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone])}>
      {children}
    </span>
  );
}
