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

type HealthDrop = {
  subject: string;
  reason: string;
  severity: "warning" | "critical";
  startedAt: string;
  endedAt: string | null;
  duration: string;
  open: boolean;
};

type SessionPerson = {
  kind: "client" | "employee" | "client-staff";
  label: string;
  name: string;
  code: string;
  loginCode: string;
  role: string;
  accountName: string;
  since: string | null;
};

type SystemHealth = {
  at: string;
  cpu: { cores: number; load1: number | null; load5: number | null; load15: number | null; percent: number | null };
  memory: { total: number; used: number; percent: number } | null;
  disk: { total: number; used: number; free: number; percent: number };
  database: { status: string; latencyMs: number; threads: number; uptimeSeconds: number };
  sessions: {
    clients: number;
    employees: number;
    subscribers: number | null;
    total: number;
    people?: SessionPerson[];
  };
  api: { avgMs: number | null; maxMs: number | null; requestsPerMinute: number; tracked: number };
  host: { uptimeSeconds: number };
  uplink: { status: string; latencyMs: number | null };
  drops?: HealthDrop[];
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

const toneClasses: Record<MetricTone, { chart: string; value: string; ring: string }> = {
  primary: { chart: "text-primary", value: "text-foreground", ring: "" },
  warning: { chart: "text-warning", value: "text-warning", ring: "ring-1 ring-warning/40" },
  critical: { chart: "text-destructive", value: "text-destructive", ring: "ring-1 ring-destructive/40" },
};

function percentTone(percent: number | null): MetricTone {
  if (percent == null) return "primary";
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warning";
  return "primary";
}

function latencyTone(ms: number | null, warnAt: number, criticalAt: number): MetricTone {
  if (ms == null) return "primary";
  if (ms >= criticalAt) return "critical";
  if (ms >= warnAt) return "warning";
  return "primary";
}

function openDropFor(drops: HealthDrop[], subject: string) {
  return drops.find((drop) => drop.subject === subject && drop.open) ?? null;
}

function MetricCard({
  title,
  icon,
  value,
  detail,
  points,
  tone = "primary",
  issue,
  selected,
  onSelect,
}: {
  title: string;
  icon: ReactNode;
  value: ReactNode;
  detail: string;
  points?: (number | null)[];
  tone?: MetricTone;
  issue?: HealthDrop | null;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const interactive = Boolean(onSelect);
  const className = `card p-5 text-left transition ${toneClasses[tone].ring} ${
    interactive ? "cursor-pointer hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" : ""
  } ${selected ? "border-foreground/30 bg-muted/30" : ""}`;
  const body = (
    <>
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <span className={toneClasses[tone].chart}>{icon}</span>
      </header>
      <p className={`mt-2 text-2xl font-semibold tabular ${toneClasses[tone].value}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      {issue ? (
        <p className={`mt-2 text-xs font-medium ${toneClasses[tone].value}`}>
          {issue.open ? `Poor for ${issue.duration}` : `Last drop ${issue.duration}`}
          {interactive ? " · view details" : ""}
        </p>
      ) : tone !== "primary" && interactive ? (
        <p className="mt-2 text-xs text-muted-foreground">Health needs attention · view details</p>
      ) : null}
      {points ? (
        <div className="mt-3">
          <Sparkline points={points} tone={tone} />
        </div>
      ) : null}
    </>
  );
  if (interactive) {
    return (
      <button type="button" onClick={onSelect} className={className} aria-pressed={selected}>
        {body}
      </button>
    );
  }
  return <article className={className}>{body}</article>;
}

export function SystemPerformancePage() {
  usePageMeta("System performance — ISP CENTRIC", "Live analytics for this system's host, database, and sessions.");
  const { employee, ready } = useEmployeeAuth();
  const [history, setHistory] = useState<SystemHealth[]>([]);
  const [drops, setDrops] = useState<HealthDrop[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
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
          setDrops(Array.isArray(body.system.drops) ? body.system.drops : []);
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
  const openDrops = drops.filter((drop) => drop.open);
  const visibleDrops = selectedSubject ? drops.filter((drop) => drop.subject === selectedSubject) : drops;
  const people = latest?.sessions.people ?? [];
  const showPeople = selectedSubject === "Users in session";
  const toggleSubject = (subject: string) => {
    setSelectedSubject((current) => (current === subject ? null : subject));
  };

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="System performance"
        description="Live analytics for this system's host, database, API, and sessions. Open a poor metric to see how long it dropped and what caused it."
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
          {openDrops.length > 0 ? (
            <div className="notice notice-destructive mt-4" role="status">
              {openDrops.length === 1
                ? `${openDrops[0].subject} is ${openDrops[0].severity} — ${openDrops[0].reason} Ongoing for ${openDrops[0].duration}.`
                : `${openDrops.length} checks need attention. Select a metric card for cause and duration.`}
            </div>
          ) : null}
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
              issue={openDropFor(drops, "CPU")}
              selected={selectedSubject === "CPU"}
              onSelect={() => toggleSubject("CPU")}
            />
            <MetricCard
              title="Memory"
              icon={<MemoryStick className="h-4 w-4" aria-hidden="true" />}
              value={latest.memory ? `${latest.memory.percent}%` : "n/a"}
              detail={latest.memory ? `${formatBytes(latest.memory.used)} of ${formatBytes(latest.memory.total)}` : "Not reported on this host"}
              points={trend((sample) => sample.memory?.percent ?? null)}
              tone={percentTone(latest.memory?.percent ?? null)}
              issue={openDropFor(drops, "Memory")}
              selected={selectedSubject === "Memory"}
              onSelect={() => toggleSubject("Memory")}
            />
            <MetricCard
              title="Disk space"
              icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
              value={`${latest.disk.percent}%`}
              detail={`${formatBytes(latest.disk.free)} free of ${formatBytes(latest.disk.total)}`}
              points={trend((sample) => sample.disk.percent)}
              tone={percentTone(latest.disk.percent)}
              issue={openDropFor(drops, "Disk space")}
              selected={selectedSubject === "Disk space"}
              onSelect={() => toggleSubject("Disk space")}
            />
            <MetricCard
              title="Database"
              icon={<Database className="h-4 w-4" aria-hidden="true" />}
              value={`${latest.database.latencyMs} ms`}
              detail={`${latest.database.threads} connections · up ${formatDuration(latest.database.uptimeSeconds)}`}
              points={trend((sample) => sample.database.latencyMs)}
              tone={latencyTone(latest.database.latencyMs, 500, 2000)}
              issue={openDropFor(drops, "Database")}
              selected={selectedSubject === "Database"}
              onSelect={() => toggleSubject("Database")}
            />
            <MetricCard
              title="System performance"
              icon={<Gauge className="h-4 w-4" aria-hidden="true" />}
              value={latest.api.avgMs == null ? "n/a" : `${latest.api.avgMs} ms`}
              detail={`avg API response · ${latest.api.requestsPerMinute} req/min`}
              points={trend((sample) => sample.api.avgMs)}
              tone={latencyTone(latest.api.avgMs, 400, 1000)}
              issue={openDropFor(drops, "System performance")}
              selected={selectedSubject === "System performance"}
              onSelect={() => toggleSubject("System performance")}
            />
            <MetricCard
              title="Users in session"
              icon={<Users className="h-4 w-4" aria-hidden="true" />}
              value={latest.sessions.total}
              detail={
                `${latest.sessions.clients} client${latest.sessions.clients === 1 ? "" : "s"} · ` +
                `${latest.sessions.employees} staff` +
                (latest.sessions.subscribers == null ? "" : ` · ${latest.sessions.subscribers} subscribers live`) +
                (people.length
                  ? ` · ${people
                      .slice(0, 2)
                      .map((person) => person.name)
                      .join(", ")}${people.length > 2 ? ` +${people.length - 2}` : ""}`
                  : "")
              }
              points={trend((sample) => sample.sessions.total)}
              selected={showPeople}
              onSelect={() => toggleSubject("Users in session")}
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
              issue={openDropFor(drops, "VPS connection")}
              selected={selectedSubject === "VPS connection"}
              onSelect={() => toggleSubject("VPS connection")}
            />
            <MetricCard
              title="Host uptime"
              icon={<Clock className="h-4 w-4" aria-hidden="true" />}
              value={formatDuration(latest.host.uptimeSeconds)}
              detail={`Last checked ${latest.at.replace("T", " ")}`}
            />
          </div>

          {showPeople || people.length > 0 ? (
            <section className="card mt-6 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Signed in now</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Accounts currently logged into the system, with their display names and codes.
                    {latest.sessions.subscribers != null
                      ? ` ${latest.sessions.subscribers} subscriber${latest.sessions.subscribers === 1 ? "" : "s"} are also live on RADIUS.`
                      : ""}
                  </p>
                </div>
                <p className="text-caption tabular text-muted-foreground">
                  {people.length} session{people.length === 1 ? "" : "s"}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="data-table min-w-[40rem]">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Name</th>
                      <th className="px-5 py-2.5 font-medium">Code</th>
                      <th className="px-5 py-2.5 font-medium">Login</th>
                      <th className="px-5 py-2.5 font-medium">Type</th>
                      <th className="px-5 py-2.5 font-medium">Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.length === 0 ? (
                      <tr>
                        <td className="px-5 py-4 text-muted-foreground" colSpan={5}>
                          No client or staff accounts are signed in right now.
                        </td>
                      </tr>
                    ) : (
                      people.map((person, index) => (
                        <tr key={`${person.kind}-${person.loginCode}-${person.since}-${index}`} className="border-t border-border">
                          <td className="px-5 py-3">
                            <p className="font-medium">{person.name}</p>
                            {person.accountName ? (
                              <p className="text-xs text-muted-foreground">Signed into {person.accountName}</p>
                            ) : null}
                          </td>
                          <td className="px-5 py-3 font-medium tabular-nums">{person.code || "—"}</td>
                          <td className="px-5 py-3 tabular-nums">{person.loginCode || "—"}</td>
                          <td className="px-5 py-3">
                            <StatusBadge
                              tone={person.kind === "employee" ? "pending" : person.kind === "client-staff" ? "due" : "online"}
                            >
                              {person.label}
                            </StatusBadge>
                          </td>
                          <td className="px-5 py-3 tabular-nums whitespace-nowrap">{person.since || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section className="card mt-6 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold tracking-tight">Connection & performance drops</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedSubject && selectedSubject !== "Users in session"
                    ? `Showing recorded drops for ${selectedSubject}. Select the card again to clear the filter.`
                    : "When health is poor, each drop records the cause, when it started, and how long it lasted."}
                </p>
              </div>
              <p className="text-caption tabular text-muted-foreground">
                {(selectedSubject && selectedSubject !== "Users in session" ? visibleDrops : drops).length} drop
                {(selectedSubject && selectedSubject !== "Users in session" ? visibleDrops : drops).length === 1 ? "" : "s"}
                {selectedSubject && selectedSubject !== "Users in session" ? ` · ${selectedSubject}` : ""}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="data-table min-w-[44rem]">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Where</th>
                    <th className="px-5 py-2.5 font-medium">Cause</th>
                    <th className="px-5 py-2.5 font-medium">Started</th>
                    <th className="px-5 py-2.5 font-medium">Duration</th>
                    <th className="px-5 py-2.5 font-medium">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedSubject && selectedSubject !== "Users in session" ? visibleDrops : drops).length === 0 ? (
                    <tr>
                      <td className="px-5 py-4 text-muted-foreground" colSpan={5}>
                        {selectedSubject && selectedSubject !== "Users in session"
                          ? `No drops are recorded for ${selectedSubject} yet.`
                          : "No connection or performance drops are recorded yet."}
                      </td>
                    </tr>
                  ) : (
                    (selectedSubject && selectedSubject !== "Users in session" ? visibleDrops : drops).map((drop) => (
                      <tr key={`${drop.subject}-${drop.startedAt}`} className="border-t border-border">
                        <td className="px-5 py-3 font-medium">{drop.subject}</td>
                        <td className="px-5 py-3 max-w-md">{drop.reason}</td>
                        <td className="px-5 py-3 tabular-nums whitespace-nowrap">{drop.startedAt}</td>
                        <td className="px-5 py-3 tabular-nums whitespace-nowrap">
                          {drop.open ? `${drop.duration} and ongoing` : drop.duration}
                        </td>
                        <td className="px-5 py-3">
                          <StatusBadge tone={drop.severity === "critical" ? "critical" : "due"}>
                            {drop.open ? (drop.severity === "critical" ? "Critical" : "Warning") : "Recovered"}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
            Refreshing every {POLL_MS / 1000} seconds — trends cover the last {Math.round((HISTORY_LIMIT * POLL_MS) / 60000)} minutes of this view.
          </p>
        </>
      )}
    </div>
  );
}
