import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

type ViewMode = "day" | "period" | "month" | "year";

type UsageClient = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  routerName: string;
  sessions?: number;
  bytesIn: number;
  bytesOut: number;
};

type UsagePoint = {
  key: string;
  label: string;
  bytesIn: number;
  bytesOut: number;
};

type UsageReport = {
  view: { mode: ViewMode; label: string; start: string; end: string };
  clients: UsageClient[];
  total: number;
  rangeBytesIn: number;
  rangeBytesOut: number;
  series: UsagePoint[];
};

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function localDay(offset = 0) {
  const now = new Date();
  const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function UsageTrendChart({ points }: { points: UsagePoint[] }) {
  const width = 720;
  const height = 260;
  const top = 18;
  const left = 56;
  const right = 14;
  const bottom = 30;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const peak = Math.max(1, ...points.map((point) => Math.max(point.bytesIn, point.bytesOut)));
  const x = (index: number) => left + (points.length <= 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const y = (value: number) => top + innerH - (value / peak) * innerH;
  const line = (read: (point: UsagePoint) => number) =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(read(point)).toFixed(1)}`).join(" ");
  const area = `${line((point) => point.bytesIn)} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const empty = points.every((point) => point.bytesIn + point.bytesOut === 0);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" aria-hidden="true" />
          Download
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
          Upload
        </span>
      </div>
      {empty ? (
        <p className="mt-6 text-sm text-muted-foreground">No usage was accounted in this range.</p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mt-3 h-auto w-full"
          role="img"
          aria-label="Download and upload trend for the selected range"
        >
          {[0.25, 0.5, 0.75, 1].map((fraction) => (
            <g key={fraction}>
              <line
                x1={left}
                x2={width - right}
                y1={y(peak * fraction)}
                y2={y(peak * fraction)}
                stroke="var(--border)"
                strokeDasharray="3 4"
              />
              <text x={left - 8} y={y(peak * fraction) + 3.5} textAnchor="end" fontSize="10" fill="var(--muted-foreground)">
                {bytes(peak * fraction)}
              </text>
            </g>
          ))}
          <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} stroke="var(--border)" />
          <path d={area} fill="var(--accent)" opacity="0.1" />
          <path d={line((point) => point.bytesIn)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
          <path d={line((point) => point.bytesOut)} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
          {points.map((point, index) => (
            <g key={point.key}>
              <circle cx={x(index)} cy={y(point.bytesIn)} r="2.5" fill="var(--accent)">
                <title>{`${point.label}: ↓ ${bytes(point.bytesIn)} · ↑ ${bytes(point.bytesOut)}`}</title>
              </circle>
              <circle cx={x(index)} cy={y(point.bytesOut)} r="2.5" fill="var(--primary)">
                <title>{`${point.label}: ↓ ${bytes(point.bytesIn)} · ↑ ${bytes(point.bytesOut)}`}</title>
              </circle>
              {index % labelEvery === 0 || index === points.length - 1 ? (
                <text
                  x={x(index)}
                  y={height - 10}
                  textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                  fontSize="10"
                  fill="var(--muted-foreground)"
                >
                  {point.label}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

export function ClientUsagePage({ kind }: { kind: "pppoe" | "hotspot" }) {
  const label = kind === "pppoe" ? "PPPoE" : "Hotspot";
  usePageMeta(kind === "pppoe" ? "PPPoE-usage — ISP CENTRIC" : "Hotspot-usage — ISP CENTRIC", `Usage for ${label} clients.`);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ViewMode>("month");
  const [day, setDay] = useState(localDay());
  const [from, setFrom] = useState(localDay(-29));
  const [to, setTo] = useState(localDay());
  const [month, setMonth] = useState(localDay().slice(0, 7));
  const [year, setYear] = useState(String(new Date().getFullYear()));

  useEffect(() => {
    const params = new URLSearchParams({ view: mode });
    if (mode === "day") {
      if (!day) return;
      params.set("date", day);
    } else if (mode === "period") {
      if (from) params.set("start", from);
      if (to) params.set("end", to);
    } else if (mode === "month") {
      if (!month) return;
      params.set("month", month);
    } else {
      if (!/^\d{4}$/.test(year)) return;
      params.set("year", year);
    }
    const path = kind === "pppoe" ? "/api/pppoe/usage" : "/api/hotspot/usage";
    setLoading(true);
    apiRequest<UsageReport>(`${path}?${params.toString()}`)
      .then((body) => {
        setReport(body);
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : `${label} usage could not be loaded.`);
      })
      .finally(() => setLoading(false));
  }, [kind, label, mode, day, from, to, month, year]);

  const peak = Math.max(1, ...(report?.clients.map((client) => client.bytesIn + client.bytesOut) ?? [1]));

  return (
    <div className="page-shell py-8">
      <PageHeader
        title={kind === "pppoe" ? "PPPoE-usage" : "Hotspot-usage"}
        description={`Download and upload trend for every ${label} client. Pick a day, a custom period, a month, or a year.`}
      />
      {message ? (
        <p className="mt-4 notice" role="alert">
          {message}
        </p>
      ) : null}
      <form className="toolbar mt-6 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => event.preventDefault()}>
        <label className="grid gap-1.5 text-sm font-medium">
          View
          <select className="field" value={mode} onChange={(event) => setMode(event.target.value as ViewMode)}>
            <option value="day">Day</option>
            <option value="period">Custom period</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </label>
        {mode === "day" ? (
          <label className="grid gap-1.5 text-sm font-medium">
            Day
            <input type="date" className="field" value={day} onChange={(event) => setDay(event.target.value)} />
          </label>
        ) : null}
        {mode === "period" ? (
          <>
            <label className="grid gap-1.5 text-sm font-medium">
              From
              <input type="date" className="field" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              To
              <input type="date" className="field" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </>
        ) : null}
        {mode === "month" ? (
          <label className="grid gap-1.5 text-sm font-medium">
            Month
            <input type="month" className="field" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
        ) : null}
        {mode === "year" ? (
          <label className="grid gap-1.5 text-sm font-medium">
            Year
            <input
              type="number"
              className="field"
              min={2000}
              max={new Date().getFullYear()}
              inputMode="numeric"
              value={year}
              onChange={(event) => setYear(event.target.value)}
            />
          </label>
        ) : null}
      </form>
      {!report && loading && !message ? <p className="mt-6 text-sm text-muted-foreground">Loading usage…</p> : null}
      {report ? (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">{kind === "hotspot" ? "Guest devices" : "Clients"}</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{report.total}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Download</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(report.rangeBytesIn)}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Upload</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(report.rangeBytesOut)}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Combined</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(report.rangeBytesIn + report.rangeBytesOut)}</p>
            </article>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Showing usage for {report.view.label}.</p>
          <section className={`mt-4 rounded-xl border border-border bg-surface p-5 transition-opacity ${loading ? "opacity-60" : ""}`}>
            <h2 className="font-semibold">
              Usage trend · {report.view.mode === "day" ? "per hour" : report.view.mode === "year" ? "per month" : "per day"}
            </h2>
            <div className="mt-3">
              <UsageTrendChart points={report.series} />
            </div>
          </section>
          <section className={`mt-4 rounded-xl border border-border bg-surface p-5 transition-opacity ${loading ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">{kind === "hotspot" ? "Guest usage" : "Client usage"} · highest first</h2>
              <p className="text-xs text-muted-foreground">{report.view.label}</p>
            </div>
            {report.clients.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                {kind === "hotspot"
                  ? "No hotspot usage has been accounted yet — guest sessions appear here after their first login."
                  : `No ${label} clients are registered yet.`}
              </p>
            ) : (
              <ol className="mt-4 max-h-[30rem] divide-y divide-border overflow-y-auto pr-1">
                {report.clients.map((client, index) => {
                  const total = client.bytesIn + client.bytesOut;
                  return (
                    <li key={client.id} className="flex items-center gap-3 py-3">
                      <span
                        className={`w-7 shrink-0 text-center text-sm font-semibold tabular ${
                          index < 3 ? "text-primary" : "text-muted-foreground"
                        }`}
                        aria-label={`Rank ${index + 1}`}
                      >
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <p className="truncate text-sm font-medium">
                            {client.firstName} {client.lastName}
                            <span className="ml-2 text-xs font-normal text-muted-foreground">{client.username}</span>
                          </p>
                          <p className="text-sm font-semibold tabular">{bytes(total)}</p>
                        </div>
                        <div
                          className="mt-1.5 h-2 rounded-full bg-surface-muted"
                          role="img"
                          aria-label={`${bytes(total)} of ${bytes(peak)}`}
                        >
                          <div
                            className="h-full rounded-full bg-gradient-brand"
                            style={{ width: `${Math.max(total > 0 ? 2 : 0, (total / peak) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          ↓ {bytes(client.bytesIn)} · ↑ {bytes(client.bytesOut)}
                          {kind === "hotspot" ? ` · ${client.sessions ?? 0} sessions` : ""}
                          {client.routerName ? ` · ${client.routerName}` : ""}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
