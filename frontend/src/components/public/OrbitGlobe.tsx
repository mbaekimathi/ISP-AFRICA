import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Orbit decoration around a globe: accent glow plus three dashed orbit rings
 * at different 3D tilts, each carrying a glowing node. Transform/opacity
 * animations only; rings freeze at their tilted rest state under
 * prefers-reduced-motion and still read as a finished orbital diagram.
 */
export function OrbitGlobe({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("orbit-scene", className)}>
      <div className="orbit-sphere-glow" aria-hidden="true" />
      <div className="orbit-center">{children}</div>
      <div className="orbit orbit-a" aria-hidden="true">
        <span className="orbit-node" />
      </div>
      <div className="orbit orbit-b" aria-hidden="true">
        <span className="orbit-node orbit-node-soft" />
      </div>
      <div className="orbit orbit-c" aria-hidden="true">
        <span className="orbit-node" />
      </div>
    </div>
  );
}
