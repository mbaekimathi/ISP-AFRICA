import type { CSSProperties } from "react";

/* Static live-monitoring replica — reuses .live-panel/.live-meter, sample values only. */
const SAMPLE = {
  router: "Core router",
  meters: [
    { label: "CPU load", value: "38%", meter: "38%", tone: "ok" },
    { label: "Uplink use", value: "72%", meter: "72%", tone: "warn" },
    { label: "Memory", value: "44%", meter: "44%", tone: "ok" },
  ],
  stats: [
    { label: "Clients online", value: "42" },
    { label: "Uptime", value: "8d 3h" },
    { label: "Latency", value: "12 ms" },
  ],
};

export function LiveMonitorPreview() {
  return (
    <div className="h-full bg-surface-muted p-6 text-left">
      <div className="live-panel">
        <div className="live-panel-header">
          <h2>
            <span className="live-dot" aria-hidden="true" />
            {SAMPLE.router} — live
          </h2>
          <span className="text-xs text-muted-foreground">Sample</span>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-[1.2fr_1fr]">
          <ul className="grid content-start gap-4">
            {SAMPLE.meters.map((meter) => (
              <li key={meter.label}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium text-foreground">{meter.label}</span>
                  <span className="text-xs text-muted-foreground">{meter.value}</span>
                </div>
                <div className="live-meter mt-1.5" data-tone={meter.tone}>
                  <span style={{ "--meter": meter.meter } as CSSProperties} />
                </div>
              </li>
            ))}
          </ul>
          <ul className="grid content-start gap-3">
            {SAMPLE.stats.map((stat) => (
              <li
                key={stat.label}
                className="rounded-xl border border-border bg-surface px-4 py-3 shadow-xs"
              >
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {stat.label}
                </p>
                <p className="mt-0.5 text-lg font-semibold tracking-tight text-foreground">{stat.value}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
