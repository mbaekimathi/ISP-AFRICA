import { Activity, Clock, Cpu, Database, Gauge, HardDrive, MemoryStick, Users, Wifi } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { employeeHomePath } from "@/lib/employees";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

type SystemHealth = {
  at: string;
  cpu: { cores: number; load1: number | null; load5: number | null; load15: number | null; percent: number | null };
  memory: { total: number; used: number; percent: number } | null;
  disk: { total: number; used: number; free: number; percent: number };
  database: { status: string; latencyMs: number; threads: number; uptimeSeconds: number };
  sessions: { clients: number; employees: number; subscribers: number | null; total: number };
  api: { avgMs: number | null; maxMs: number | null; requestsPerMinute: number; tracked: number };
  host: { uptimeSeconds: number };
  uplink: { status: string; latencyMs: number | null };
};

const HISTORY_LIMIT = 60;
const POLL_MS = 8000;

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Sparkline({ points, tone = "primary" }: { points: (number | null)[]; tone?: MetricTone }) {
  const values = points.filter((point): point is number => point != null);
  if (values.length < 2) {
    return <div className="flex h-12 items-center text-xs text-muted-foreground">Collecting trend…</div>;
  }
  const width = 260;
  const height = 48;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const coords = values.map(
    (value, index) => `${(index * step).toFixed(1)},${(height - 4 - ((value - min) / span) * (height - 8)).toFixed(1)}`,
  );
  const line = coords.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`h-12 w-full ${toneClasses[tone].chart}`}
      aria-hidden="true"
    >
      <polygon points={area} fill="currentColor" opacity="0.12" />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

type MetricTone = "primary" | "warning" | "critical";

const toneClasses: Record<MetricTone, { chart: string; value: string }> = {
  primary: { chart: "text-primary", value: "text-foreground" },
  warning: { chart: "text-warning", value: "text-warning" },
  critical: { chart: "text-destructive", value: "text-destructive" },
};

function percentTone(percent: number | null): MetricTone {
  if (percent == null) return "primary";
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warning";
  return "primary";
}

function MetricCard({
  title,
  icon,
  value,
  detail,
  points,
  tone = "primary",
}: {
  title: string;
  icon: ReactNode;
  value: ReactNode;
  detail: string;
  points?: (number | null)[];
  tone?: MetricTone;
}) {
  return (
    <article className="card p-5">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <span className={toneClasses[tone].chart}>{icon}</span>
      </header>
      <p className={`mt-2 text-2xl font-semibold tabular ${toneClasses[tone].value}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      {points ? (
        <div className="mt-3">
          <Sparkline points={points} tone={tone} />
        </div>
      ) : null}
    </article>
  );
}

export function SystemPerformancePage() {
  usePageMeta("System performance — ISP CENTRIC", "Live analytics for this system's host, database, and sessions.");
  const { employee, ready } = useEmployeeAuth();
  const [history, setHistory] = useState<SystemHealth[]>([]);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (employee?.role !== "director") return;
    let cancelled = false;
    const load = () => {
      apiRequest<{ system: SystemHealth }>("/api/director/system")
        .then((body) => {
          if (cancelled) return;
          setHistory((items) => [...items.slice(-(HISTORY_LIMIT - 1)), body.system]);
          setMessage("");
        })
        .catch((error: unknown) => {
          if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not load system performance.");
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [employee?.role]);

  if (!ready) {
    return <LiveLoad label="Loading system performance" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  if (employee.role !== "director") {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  const latest = history[history.length - 1];
  const trend = (pick: (sample: SystemHealth) => number | null) => history.map(pick);

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="System performance"
        description="Live analytics for this system's host, database, API, and sessions. Refreshes every few seconds."
      />
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}
      {!latest ? (
        loaded ? null : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="card p-5">
                <div className="skeleton h-4 w-1/3" />
                <div className="skeleton mt-3 h-8 w-1/2" />
                <div className="skeleton mt-4 h-12 w-full" />
              </div>
            ))}
            <span className="sr-only">Loading system performance…</span>
          </div>
        )
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <MetricCard
              title="CPU"
              icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
              value={latest.cpu.percent == null ? "n/a" : `${latest.cpu.percent}%`}
              detail={
                latest.cpu.load1 == null
                  ? `${latest.cpu.cores} cores`
                  : `${latest.cpu.cores} cores · load ${latest.cpu.load1} / ${latest.cpu.load5} / ${latest.cpu.load15}`
              }
              points={trend((sample) => sample.cpu.percent)}
              tone={percentTone(latest.cpu.percent)}
            />
            <MetricCard
              title="Memory"
              icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />}
              value={latest.memory ? `${latest.memory.percent}%` : "n/a"}
              detail={latest.memory ? `${formatBytes(latest.memory.used)} of ${formatBytes(latest.memory.total)}` : "Not reported on this host"}
              points={trend((sample) => sample.memory?.percent ?? null)}
              tone={percentTone(latest.memory?.percent ?? null)}
            />
            <MetricCard
              title="Disk space"
              icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
              value={`${latest.disk.percent}%`}
              detail={`${formatBytes(latest.disk.free)} free of ${formatBytes(latest.disk.total)}`}
              points={trend((sample) => sample.disk.percent)}
              tone={percentTone(latest.disk.percent)}
            />
            <MetricCard
              title="Database"
              icon={<Database className="h-4 w-4" aria-hidden="true" />}
              value={`${latest.database.latencyMs} ms`}
              detail={`${latest.database.threads} connections · up ${formatDuration(latest.database.uptimeSeconds)}`}
              points={trend((sample) => sample.database.latencyMs)}
              tone={latest.database.latencyMs >= 2000 ? "critical" : latest.database.latencyMs >= 500 ? "warning" : "primary"}
            />
            <MetricCard
              title="System performance"
              icon={<Gauge className="h-4 w-4" aria-hidden="true" />}
              value={latest.api.avgMs == null ? "n/a" : `${latest.api.avgMs} ms`}
              detail={`avg API response · ${latest.api.requestsPerMinute} req/min`}
              points={trend((sample) => sample.api.avgMs)}
            />
            <MetricCard
              title="Users in session"
              icon={<Users className="h-4 w-4" aria-hidden="true" />}
              value={latest.sessions.total}
              detail={
                `${latest.sessions.clients} client${latest.sessions.clients === 1 ? "" : "s"} · ` +
                `${latest.sessions.employees} staff` +
                (latest.sessions.subscribers == null ? "" : ` · ${latest.sessions.subscribers} subscribers live`)
              }
              points={trend((sample) => sample.sessions.total)}
            />
            <MetricCard
              title="VPS connection"
              icon={<Wifi className="h-4 w-4" aria-hidden="true" />}
              value={
                <span className="flex items-center gap-2">
                  <StatusBadge tone={latest.uplink.status === "ok" ? "online" : "offline"}>
                    {latest.uplink.status === "ok" ? "Online" : "Down"}
                  </StatusBadge>
                  {latest.uplink.latencyMs != null ? `${latest.uplink.latencyMs} ms` : ""}
                </span>
              }
              detail="Outbound internet reachability from this server"
              points={trend((sample) => sample.uplink.latencyMs)}
              tone={latest.uplink.status === "ok" ? "primary" : "critical"}
            />
            <MetricCard
              title="Host uptime"
              icon={<Clock className="h-4 w-4" aria-hidden="true" />}
              value={formatDuration(latest.host.uptimeSeconds)}
              detail={`Last checked ${latest.at.replace("T", " ")}`}
            />
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            Refreshing every {POLL_MS / 1000} seconds — trends cover the last {Math.round((HISTORY_LIMIT * POLL_MS) / 60000)} minutes of this view.
          </p>
        </>
      )}
    </div>
  );
}
