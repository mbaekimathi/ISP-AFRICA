import { ArrowRight, CalendarDays, ChevronRight, Clock, Flame, Hourglass, Inbox, LogIn, Sunrise, TicketCheck, Timer, UserCheck, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { PeriodCalendar, type PeriodMode } from "@/components/ui/PeriodCalendar";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientPage } from "@/lib/accounts";
import {
  clientStaffRoleLabel,
  listClientStaff,
  performanceSettings,
  savePerformanceSettings,
  staffPerformance,
  type ClientStaff,
  type PerformanceWorkday,
  type StaffPerformance,
  type StaffPerformanceDay,
  type StaffPerformanceTicket,
  type TicketStageTargets,
} from "@/lib/clientStaff";
import { cn } from "@/lib/cn";
import { useAuth } from "@/providers/AuthProvider";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseIso = (value: string) => new Date(`${value}T00:00:00`);

function formatDate(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return `${d} ${SHORT_MONTHS[(m || 1) - 1]} ${y}`;
}

function formatDay(value: string) {
  const parsed = parseIso(value);
  return `${WEEKDAYS[parsed.getDay()]} ${formatDate(value)}`;
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(minutes / 1440);
  const rest = Math.round((minutes % 1440) / 60);
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

function arrivalBadge(day: StaffPerformanceDay) {
  if (day.minutesLate > 0) return <StatusBadge tone="due">{`Late ${formatMinutes(day.minutesLate)}`}</StatusBadge>;
  if (day.minutesLate < 0) return <StatusBadge tone="active">{`Early ${formatMinutes(-day.minutesLate)}`}</StatusBadge>;
  return <StatusBadge tone="neutral">On time</StatusBadge>;
}

function formatStamp(value: string) {
  const [date, time] = value.split(" ");
  return `${formatDate(date)} · ${(time ?? "").slice(0, 5)}`;
}

function rangeForMode(mode: PeriodMode, anchorIso: string) {
  const anchor = parseIso(anchorIso);
  if (mode === "day") return { from: anchorIso, to: anchorIso };
  if (mode === "period") {
    const start = new Date(anchor);
    start.setDate(start.getDate() - 6);
    return { from: isoOf(start), to: isoOf(anchor) };
  }
  if (mode === "month") {
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    return {
      from: `${anchor.getFullYear()}-${pad2(anchor.getMonth() + 1)}-01`,
      to: `${anchor.getFullYear()}-${pad2(anchor.getMonth() + 1)}-${pad2(last)}`,
    };
  }
  return { from: `${anchor.getFullYear()}-01-01`, to: `${anchor.getFullYear()}-12-31` };
}

function rangeLabel(mode: PeriodMode, from: string, to: string) {
  if (mode === "day") return formatDay(from);
  if (mode === "period") return `${formatDate(from)} – ${formatDate(to)}`;
  if (mode === "month") {
    const anchor = parseIso(from);
    return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  }
  return from.slice(0, 4);
}

const MODE_LABELS: { value: PeriodMode; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "period", label: "Period" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

const TICKET_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  new: { label: "New", tone: "pending" },
  onboarding: { label: "Onboarding", tone: "due" },
  pending_activation: { label: "Pending activation", tone: "due" },
  completed: { label: "Completed", tone: "active" },
  cancelled: { label: "Cancelled", tone: "offline" },
};

function ticketStatus(status: string) {
  return TICKET_STATUS[status] ?? { label: status, tone: "neutral" as StatusTone };
}

function statusBadge(member: ClientStaff) {
  if (member.status === "pending") return <StatusBadge tone="pending">Pending approval</StatusBadge>;
  if (member.status === "suspended") return <StatusBadge tone="suspended">Suspended</StatusBadge>;
  return null;
}

export function ClientStaffPerformancePage() {
  usePageMeta("Staff performance — ISP CENTRIC", "Open an employee to review their performance.");
  const { user } = useAuth();
  const [staff, setStaff] = useState<ClientStaff[] | null>(null);
  const [listError, setListError] = useState("");
  const isDelegate = Boolean(user?.delegate);

  useEffect(() => {
    if (isDelegate) return;
    let stopped = false;
    listClientStaff()
      .then((rows) => {
        if (!stopped) setStaff(rows);
      })
      .catch((cause: unknown) => {
        if (!stopped) setListError(cause instanceof Error ? cause.message : "The staff list could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate]);

  if (isDelegate) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="Staff performance" />
        <p className="notice">Only the account owner can review employee performance.</p>
      </div>
    );
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Staff performance" description="Choose an employee to open their performance page." />
      {listError ? (
        <p className="notice mt-4" role="alert">
          {listError}
        </p>
      ) : null}
      <ul className="panel mt-4 divide-y divide-border overflow-hidden">
        {!staff && !listError ? (
          <li className="px-4 py-6" aria-hidden="true">
            <div className="grid gap-3">
              <div className="skeleton h-4 w-1/3" />
              <div className="skeleton h-4 w-2/5" />
              <div className="skeleton h-4 w-1/4" />
            </div>
          </li>
        ) : null}
        {staff?.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">No employees are saved yet.</li>
        ) : null}
        {staff?.map((member) => (
          <li key={member.id}>
            <Link
              to={user ? clientPage(user, `/hr/performance/${member.id}`) : `/hr/performance/${member.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-fast ease-out hover:bg-surface-muted/50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <img
                  src={member.photoDataUrl}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-full border border-border object-cover"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">
                      {member.firstName} {member.lastName}
                    </p>
                    {statusBadge(member)}
                    {member.role ? <StatusBadge tone="neutral">{clientStaffRoleLabel(member.role)}</StatusBadge> : null}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {member.title ? `${member.title} · ` : ""}
                    {member.email} · {member.phone}
                  </p>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatCard({ title, icon, value, detail }: { title: string; icon: ReactNode; value: ReactNode; detail: string }) {
  return (
    <article className="card p-5">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        <span className="text-primary">{icon}</span>
      </header>
      <p className="mt-2 text-2xl font-semibold tabular">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </article>
  );
}

export function ClientStaffPerformanceDetailPage() {
  const { staffId } = useParams();
  const { user } = useAuth();
  const [member, setMember] = useState<ClientStaff | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const isDelegate = Boolean(user?.delegate);

  const [mode, setMode] = useState<PeriodMode>("month");
  const [range, setRange] = useState(() => rangeForMode("month", isoOf(new Date())));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [perf, setPerf] = useState<StaffPerformance | null>(null);
  const [perfError, setPerfError] = useState("");
  const [perfLoading, setPerfLoading] = useState(false);
  const [perfAt, setPerfAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const hasLive = Boolean(perf?.days.some((day) => day.live));

  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [hasLive]);

  usePageMeta(
    `${member ? `${member.firstName} ${member.lastName} — ` : ""}Staff performance — ISP CENTRIC`,
    "Employee performance.",
  );

  useEffect(() => {
    if (isDelegate) return;
    let stopped = false;
    listClientStaff()
      .then((rows) => {
        if (!stopped) setMember(rows.find((row) => row.id === staffId) ?? null);
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "The employee could not be loaded.");
      })
      .finally(() => {
        if (!stopped) setLoaded(true);
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate, staffId]);

  useEffect(() => {
    if (isDelegate || !staffId) return;
    let stopped = false;
    setPerfLoading(true);
    staffPerformance(staffId, range.from, range.to)
      .then((body) => {
        if (!stopped) {
          setPerf(body);
          setPerfAt(Date.now());
          setNow(Date.now());
          setPerfError("");
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) setPerfError(cause instanceof Error ? cause.message : "Performance data could not be loaded.");
      })
      .finally(() => {
        if (!stopped) setPerfLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate, staffId, range.from, range.to]);

  if (isDelegate) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="Staff performance" />
        <p className="notice">Only the account owner can review employee performance.</p>
      </div>
    );
  }

  const firstLogins = perf?.days.map((day) => day.firstLogin).filter((value): value is string => Boolean(value)) ?? [];
  const averageLogin = firstLogins.length
    ? (() => {
        const total = firstLogins.reduce((sum, value) => {
          const [h, m] = value.split(":").map(Number);
          return sum + h * 60 + m;
        }, 0);
        const mean = Math.round(total / firstLogins.length);
        return `${pad2(Math.floor(mean / 60))}:${pad2(mean % 60)}`;
      })()
    : "—";
  const signIns = perf?.days.reduce((sum, day) => sum + day.sessions, 0) ?? 0;
  const liveExtra = hasLive ? Math.max(0, Math.floor((now - perfAt) / 60_000)) : 0;
  const totalMinutes = (perf?.days.reduce((sum, day) => sum + day.minutesInSession, 0) ?? 0) + liveExtra;
  const averageLate = perf?.days.length
    ? Math.round(perf.days.reduce((sum, day) => sum + day.minutesLate, 0) / perf.days.length)
    : null;
  const loginDetail =
    averageLate === null
      ? "Average first sign-in time each day"
      : averageLate > 0
        ? `Late ${formatMinutes(averageLate)} on average`
        : averageLate < 0
          ? `Early ${formatMinutes(-averageLate)} on average`
          : "On time on average";
  const dayMinutes = (day: StaffPerformanceDay) => day.minutesInSession + (day.live ? liveExtra : 0);
  const breachedTickets = perf?.tickets.items.filter((ticket) => ticket.breached).length ?? 0;

  function chooseMode(next: PeriodMode) {
    setMode(next);
    setRange(rangeForMode(next, range.from));
    setCalendarOpen(true);
  }

  return (
    <div className="page-shell py-8">
      <PageHeader
        title={member ? `${member.firstName} ${member.lastName}` : "Staff performance"}
        description="Employee performance."
      />
      {error ? (
        <p className="notice mt-4" role="alert">
          {error}
        </p>
      ) : null}
      {!loaded && !error ? (
        <div className="panel mt-4 px-4 py-6" aria-hidden="true">
          <div className="grid gap-3">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-4 w-2/5" />
            <div className="skeleton h-4 w-1/4" />
          </div>
        </div>
      ) : null}
      {loaded && !member && !error ? <p className="notice mt-4">We could not find that employee.</p> : null}
      {member ? (
        <>
          <div className="panel mt-4 px-4 py-5">
            <div className="flex flex-wrap items-center gap-3 pb-4">
              <img
                src={member.photoDataUrl}
                alt=""
                className="h-12 w-12 shrink-0 rounded-full border border-border object-cover"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-lg font-semibold">
                    {member.firstName} {member.lastName}
                  </p>
                  {statusBadge(member)}
                  {member.role ? <StatusBadge tone="neutral">{clientStaffRoleLabel(member.role)}</StatusBadge> : null}
                </div>
                {member.title ? <p className="mt-0.5 text-sm text-muted-foreground">{member.title}</p> : null}
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-lg border border-border bg-surface p-1"
              role="group"
              aria-label="Performance range"
            >
              {MODE_LABELS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={mode === item.value}
                  className={cn(
                    "min-h-9 rounded-md px-3.5 text-sm font-semibold transition duration-fast ease-out",
                    mode === item.value
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => chooseMode(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <SecondaryButton type="button" onClick={() => setCalendarOpen((open) => !open)} aria-expanded={calendarOpen}>
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
                {rangeLabel(mode, range.from, range.to)}
              </SecondaryButton>
              {calendarOpen ? (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-30 cursor-default"
                    aria-label="Close calendar"
                    onClick={() => setCalendarOpen(false)}
                  />
                  <div className="absolute left-0 z-40 mt-2 rounded-xl border border-border bg-surface shadow-lg">
                    <PeriodCalendar
                      key={mode}
                      mode={mode}
                      from={range.from}
                      to={range.to}
                      onPick={(from, to) => {
                        setRange({ from, to });
                        setCalendarOpen(false);
                      }}
                    />
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {perfError ? (
            <p className="notice mt-4" role="alert">
              {perfError}
            </p>
          ) : null}

          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-busy={perfLoading}>
            <StatCard
              title="Average sign-in"
              icon={<Clock className="h-4 w-4" aria-hidden="true" />}
              value={averageLogin}
              detail={loginDetail}
            />
            <StatCard
              title="Days active"
              icon={<CalendarDays className="h-4 w-4" aria-hidden="true" />}
              value={perf?.days.length ?? "—"}
              detail={`Days with at least one sign-in`}
            />
            <StatCard
              title="Sign-ins"
              icon={<LogIn className="h-4 w-4" aria-hidden="true" />}
              value={perf ? signIns : "—"}
              detail="Total sessions started in range"
            />
            <StatCard
              title="Time in session"
              icon={<Timer className="h-4 w-4" aria-hidden="true" />}
              value={perf ? formatMinutes(totalMinutes) : "—"}
              detail={hasLive ? "In session now — within work hours" : `Within ${perf?.workday.start ?? "—"}–${perf?.workday.end ?? "—"}`}
            />
            <StatCard
              title="Tickets attended"
              icon={<TicketCheck className="h-4 w-4" aria-hidden="true" />}
              value={perf?.tickets.attended ?? "—"}
              detail={
                perf
                  ? breachedTickets
                    ? `${breachedTickets} over stage target`
                    : "All within stage targets"
                  : "Tickets created, claimed, or assigned"
              }
            />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <section className="panel overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <UserCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                  <h2 className="text-sm font-semibold">Sign-ins by day</h2>
                </div>
                {perf ? (
                  <span className="text-caption text-muted-foreground">
                    Workday {perf.workday.start}–{perf.workday.end}
                  </span>
                ) : null}
              </header>
              <ul className="divide-y divide-border">
                {perfLoading && !perf ? (
                  <li className="px-4 py-6" aria-hidden="true">
                    <div className="grid gap-3">
                      <div className="skeleton h-4 w-1/3" />
                      <div className="skeleton h-4 w-2/5" />
                    </div>
                  </li>
                ) : null}
                {!perfLoading && perf?.days.length === 0 ? (
                  <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No sign-ins in this {mode === "day" ? "day" : "range"}.
                  </li>
                ) : null}
                {perf?.days.map((day) => (
                  <li key={day.date} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{formatDay(day.date)}</p>
                        {arrivalBadge(day)}
                        {day.live ? <StatusBadge tone="active">In session now</StatusBadge> : null}
                      </div>
                      {day.logins.length > 1 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {day.logins.map((stamp) => (
                            <span
                              key={stamp}
                              className="rounded-md bg-muted px-1.5 py-0.5 text-caption tabular text-muted-foreground"
                            >
                              {stamp}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular">{day.firstLogin ?? "—"}</p>
                      <p className="text-caption text-muted-foreground">
                        {day.sessions} sign-in{day.sessions === 1 ? "" : "s"} · {formatMinutes(dayMinutes(day))} in
                        session
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel overflow-hidden">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <TicketCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                  <h2 className="text-sm font-semibold">Tickets attended</h2>
                </div>
                {perf && Object.keys(perf.tickets.byStatus).length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(perf.tickets.byStatus).map(([status, count]) => {
                      const meta = ticketStatus(status);
                      return (
                        <StatusBadge key={status} tone={meta.tone}>
                          {`${meta.label} ${count}`}
                        </StatusBadge>
                      );
                    })}
                  </div>
                ) : null}
              </header>
              <ul className="divide-y divide-border">
                {perfLoading && !perf ? (
                  <li className="px-4 py-6" aria-hidden="true">
                    <div className="grid gap-3">
                      <div className="skeleton h-4 w-1/3" />
                      <div className="skeleton h-4 w-2/5" />
                    </div>
                  </li>
                ) : null}
                {!perfLoading && perf?.tickets.items.length === 0 ? (
                  <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No tickets attended in this {mode === "day" ? "day" : "range"}.
                  </li>
                ) : null}
                {perf?.tickets.items.map((ticket) => {
                  const meta = ticketStatus(ticket.status);
                  const stages: { key: keyof StaffPerformanceTicket["stageMinutes"]; label: string }[] = [
                    { key: "new", label: "New" },
                    { key: "onboarding", label: "Onboarding" },
                    { key: "pendingActivation", label: "Activation" },
                    { key: "fault", label: "Fault" },
                  ];
                  return (
                    <li key={ticket.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{ticket.clientName || "Client"}</p>
                          {ticket.kind === "fault" ? <StatusBadge tone="error">Fault</StatusBadge> : null}
                          {ticket.breached ? <StatusBadge tone="overdue">Over target</StatusBadge> : null}
                        </div>
                        <p className="mt-0.5 text-caption text-muted-foreground">{formatStamp(ticket.createdAt)}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {stages.map(({ key, label }) => {
                            const minutes = ticket.stageMinutes[key];
                            if (minutes === null) return null;
                            const over = perf && minutes > perf.stages[key];
                            return (
                              <span
                                key={key}
                                className={cn(
                                  "rounded-md px-1.5 py-0.5 text-caption tabular",
                                  over ? "bg-destructive-soft/60 text-destructive" : "bg-muted text-muted-foreground",
                                )}
                                title={`${label} stage ${over ? `exceeded the ${formatMinutes(perf?.stages[key] ?? 0)} target` : "time"}`}
                              >
                                {`${label} ${formatMinutes(minutes)}`}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

type StageDraft = { value: number; unit: number };

const STAGE_UNITS = [
  { id: 1, label: "minutes", short: "min" },
  { id: 60, label: "hours", short: "hr" },
  { id: 1440, label: "days", short: "day" },
];

const STAGE_FIELDS: { key: keyof TicketStageTargets; label: string; hint: string; icon: typeof Inbox; chip: string }[] = [
  { key: "new", label: "New", hint: "Waiting to be picked up.", icon: Inbox, chip: "bg-sky-500/15 text-sky-500" },
  { key: "onboarding", label: "Onboarding", hint: "Being worked on before submission.", icon: Wrench, chip: "bg-emerald-500/15 text-emerald-500" },
  { key: "pendingActivation", label: "Pending activation", hint: "Submitted and waiting for activation.", icon: Hourglass, chip: "bg-violet-500/15 text-violet-500" },
  { key: "fault", label: "Fault", hint: "Total time to clear a fault ticket.", icon: Flame, chip: "bg-rose-500/15 text-rose-500" },
];

function splitMinutes(minutes: number): StageDraft {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 1440 };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 60 };
  return { value: minutes, unit: 1 };
}

function clockMinutes(value: string): number | null {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

export function ClientPerformanceSettingsPage() {
  usePageMeta("Performance settings — ISP CENTRIC", "Set the working day used to measure staff sign-ins.");
  const { user } = useAuth();
  const isDelegate = Boolean(user?.delegate);
  const [workday, setWorkday] = useState<PerformanceWorkday>({ start: "08:00", end: "17:00" });
  const [stages, setStages] = useState<Record<keyof TicketStageTargets, StageDraft>>({
    new: splitMinutes(60),
    onboarding: splitMinutes(240),
    pendingActivation: splitMinutes(1440),
    fault: splitMinutes(240),
  });
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (isDelegate) return;
    let stopped = false;
    performanceSettings()
      .then((body) => {
        if (!stopped) {
          setWorkday(body.workday);
          setStages({
            new: splitMinutes(body.stages.new),
            onboarding: splitMinutes(body.stages.onboarding),
            pendingActivation: splitMinutes(body.stages.pendingActivation),
            fault: splitMinutes(body.stages.fault),
          });
          setLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "The performance settings could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [isDelegate]);

  if (isDelegate) {
    return (
      <div className="page-shell py-8">
        <PageHeader title="Performance settings" />
        <p className="notice">Only the account owner can change performance settings.</p>
      </div>
    );
  }

  function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setPending(true);
    savePerformanceSettings({
      workday,
      stages: {
        new: stages.new.value * stages.new.unit,
        onboarding: stages.onboarding.value * stages.onboarding.unit,
        pendingActivation: stages.pendingActivation.value * stages.pendingActivation.unit,
        fault: stages.fault.value * stages.fault.unit,
      },
    })
      .then((body) => {
        setWorkday(body.workday);
        setStages({
          new: splitMinutes(body.stages.new),
          onboarding: splitMinutes(body.stages.onboarding),
          pendingActivation: splitMinutes(body.stages.pendingActivation),
          fault: splitMinutes(body.stages.fault),
        });
        setNotice("Performance settings saved.");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The performance settings could not be saved.");
      })
      .finally(() => setPending(false));
  }

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Performance settings"
        description="Set the working day used to measure staff performance. The day start marks late arrivals; time in session is counted between the start and end."
      />
      {error ? (
        <p className="notice mt-4" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}
      <form className="panel mt-6 max-w-3xl overflow-hidden" onSubmit={save}>
        <section className="border-b border-border/70 px-5 py-5">
          <div className="flex items-center gap-2.5">
            <Sunrise className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Working day</h2>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Sign-ins after the start count as late; time in session is only counted between these times.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <FormField id="day-start" label="Day starts">
              <input
                id="day-start"
                type="time"
                className="field"
                required
                value={workday.start}
                disabled={pending || !loaded}
                onChange={(event) => setWorkday((current) => ({ ...current, start: event.target.value }))}
              />
            </FormField>
            <ArrowRight className="mb-1 hidden h-4 w-4 justify-self-center text-muted-foreground sm:block" aria-hidden="true" />
            <FormField id="day-end" label="Day ends">
              <input
                id="day-end"
                type="time"
                className="field"
                required
                value={workday.end}
                disabled={pending || !loaded}
                onChange={(event) => setWorkday((current) => ({ ...current, end: event.target.value }))}
              />
            </FormField>
          </div>
          {(() => {
            const open = clockMinutes(workday.start);
            const close = clockMinutes(workday.end);
            if (open === null || close === null || close <= open) return null;
            return (
              <div className="mt-4" aria-hidden="true">
                <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="absolute inset-y-0 rounded-full bg-primary/80"
                    style={{ left: `${(open / 1440) * 100}%`, width: `${((close - open) / 1440) * 100}%` }}
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-caption tabular text-muted-foreground">
                  {["00:00", "06:00", "12:00", "18:00", "24:00"].map((tick) => (
                    <span key={tick}>{tick}</span>
                  ))}
                </div>
              </div>
            );
          })()}
        </section>
        <section className="px-5 py-5">
          <div className="flex items-center gap-2.5">
            <Hourglass className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Ticket stages</h2>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            How long a ticket should take to clear each stage. Tickets that take longer are flagged on the
            performance page.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {STAGE_FIELDS.map(({ key, label, hint, icon: StageIcon, chip }) => {
              const draft = stages[key];
              return (
                <div
                  key={key}
                  className="rounded-xl border border-border p-3.5 transition-colors duration-fast ease-out hover:border-input"
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", chip)} aria-hidden="true">
                      <StageIcon className="h-3.5 w-3.5" />
                    </span>
                    <p className="text-sm font-medium text-foreground">{label}</p>
                  </div>
                  <p className="mt-1.5 min-h-8 text-caption leading-4 text-muted-foreground">{hint}</p>
                  <div className="mt-3 flex items-stretch gap-2">
                    <input
                      type="number"
                      className="field min-w-0 flex-1"
                      min={1}
                      required
                      value={draft.value}
                      disabled={pending || !loaded}
                      aria-label={`${label} duration`}
                      onChange={(event) =>
                        setStages((current) => ({
                          ...current,
                          [key]: { ...current[key], value: Number(event.target.value) },
                        }))
                      }
                    />
                    <div
                      className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface-muted/60 p-0.5"
                      role="group"
                      aria-label={`${label} unit`}
                    >
                      {STAGE_UNITS.map((unit) => (
                        <button
                          key={unit.id}
                          type="button"
                          disabled={pending || !loaded}
                          aria-pressed={draft.unit === unit.id}
                          className={cn(
                            "rounded-md px-2.5 text-caption font-semibold transition duration-fast ease-out disabled:opacity-60",
                            draft.unit === unit.id
                              ? "bg-surface text-foreground shadow-xs"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() =>
                            setStages((current) => ({
                              ...current,
                              [key]: { ...current[key], unit: unit.id },
                            }))
                          }
                        >
                          {unit.short}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-surface-muted/40 px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Effective configuration">
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-caption font-semibold tabular text-muted-foreground">
              {`${workday.start || "--:--"}–${workday.end || "--:--"}`}
            </span>
            {STAGE_FIELDS.map(({ key, label }) => (
              <span
                key={key}
                className="rounded-md bg-muted px-1.5 py-0.5 text-caption tabular text-muted-foreground"
              >
                {`${label} ${formatMinutes(stages[key].value * stages[key].unit)}`}
              </span>
            ))}
          </div>
          <PrimaryButton type="submit" disabled={pending || !loaded}>
            Save performance settings
          </PrimaryButton>
        </footer>
      </form>
    </div>
  );
}
