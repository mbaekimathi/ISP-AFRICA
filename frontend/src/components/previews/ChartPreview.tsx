import { chartLabels, chartPoints } from "@/content/landing";

export function ChartPreview() {
  const width = 320;
  const height = 140;
  const max = Math.max(...chartPoints);
  const step = width / (chartPoints.length - 1);
  const coords = chartPoints.map((point, index) => {
    const x = index * step;
    const y = height - (point / max) * (height - 16) - 8;
    return { x, y };
  });
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <figure className="rounded-xl border border-border bg-surface p-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">Subscriber growth</span>
        <span className="text-xs text-muted-foreground">Sample</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-4 h-32 w-full"
        role="img"
        aria-label="Sample chart showing subscriber growth rising across six months"
      >
        <polygon points={area} fill="currentColor" className="text-primary/15" />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="3" className="text-primary" />
      </svg>
      <div className="mt-2 grid grid-cols-6 text-center text-[11px] text-muted-foreground">
        {chartLabels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </figure>
  );
}
