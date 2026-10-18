import { cn } from "@/lib/cn";

type BackgroundGlowProps = {
  className?: string;
  /** Show the faint dot grid under the brand glow. */
  grid?: boolean;
};

/** Faint dot-grid + radial brand glow with a radial fade mask. Decorative. */
export function BackgroundGlow({ className, grid = true }: BackgroundGlowProps) {
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden="true">
      <div className="absolute inset-0 network-glow" />
      {grid ? <div className="absolute inset-0 network-grid opacity-70" /> : null}
    </div>
  );
}
