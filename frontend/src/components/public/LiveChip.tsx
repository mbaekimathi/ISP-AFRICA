import { cn } from "@/lib/cn";

/** Small pulsing status dot (success token). Solid under reduced motion. */
export function LiveDot({ className }: { className?: string }) {
  return <span className={cn("live-dot", className)} aria-hidden="true" />;
}

/** Compact "Online" chip with a live dot. */
export function LiveChip({ label = "Online", className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold text-foreground shadow-xs",
        className,
      )}
    >
      <LiveDot />
      {label}
    </span>
  );
}
