import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { LiveDot } from "@/components/public/LiveChip";
import { cn } from "@/lib/cn";

/** Static token-based stand-in shown if a preview cannot render. */
function PreviewFallback() {
  return (
    <div className="grid h-full content-start gap-3 bg-surface-muted p-5">
      <div className="h-8 w-2/5 rounded-lg bg-surface shadow-xs" />
      <div className="grid grid-cols-3 gap-3">
        <div className="h-16 rounded-lg bg-surface shadow-xs" />
        <div className="h-16 rounded-lg bg-surface shadow-xs" />
        <div className="h-16 rounded-lg bg-surface shadow-xs" />
      </div>
      <div className="h-24 rounded-lg bg-surface shadow-xs" />
    </div>
  );
}

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <PreviewFallback /> : this.props.children;
  }
}

type PreviewFrameProps = {
  /** Text-only address label in the top bar. */
  label: string;
  /** Describes the preview; static replicas are hidden from assistive tech. */
  ariaLabel: string;
  /** Design canvas the replica is drawn at; it is scaled to fit. */
  designWidth: number;
  designHeight: number;
  /** Interactive demos accept clicks/keys and stay in the a11y tree. */
  interactive?: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * Framed product preview. Mounts its content only once scrolled near view,
 * reserves aspect-ratio so nothing shifts. Static replicas stay inert and
 * hidden from assistive tech; interactive demos receive events and keep
 * their own semantics.
 */
export function PreviewFrame({
  label,
  ariaLabel,
  designWidth,
  designHeight,
  interactive = false,
  children,
  className,
}: PreviewFrameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    if (typeof IntersectionObserver !== "function") {
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setScale(stage.clientWidth / designWidth);
    measure();
    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [designWidth, mounted]);

  return (
    <div
      ref={frameRef}
      role={interactive ? "group" : "img"}
      aria-label={ariaLabel}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-surface shadow-card",
        "dark:border-accent/25 dark:shadow-glow-md",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface-muted px-3 py-2">
        <span className="flex shrink-0 gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
          <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded-md bg-surface px-3 py-1 text-center text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-foreground">
          <LiveDot />
          {interactive ? "Try it — demo" : "Live preview"}
        </span>
      </div>
      <div ref={stageRef} className="relative" style={{ aspectRatio: `${designWidth}/${designHeight}` }}>
        {mounted ? (
          <div
            ref={(node) => {
              if (node && !interactive) node.inert = true;
            }}
            aria-hidden={interactive ? undefined : true}
            className={cn("absolute left-0 top-0", !interactive && "pointer-events-none")}
            style={{
              width: designWidth,
              height: designHeight,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <PreviewBoundary>{children}</PreviewBoundary>
          </div>
        ) : (
          <div className="skeleton absolute inset-0" />
        )}
      </div>
    </div>
  );
}
