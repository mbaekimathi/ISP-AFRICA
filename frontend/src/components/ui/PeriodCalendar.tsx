import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

export type PeriodMode = "day" | "period" | "month" | "year";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
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

const pad2 = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const startWeekday = (y: number, m: number) => (new Date(y, m, 1).getDay() + 6) % 7;

function parseIso(value: string) {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function PeriodCalendar({
  mode,
  from,
  to,
  onPick,
}: {
  mode: PeriodMode;
  from: string;
  to: string;
  onPick: (from: string, to: string) => void;
}) {
  const anchor = parseIso(from);
  const [view, setView] = useState({ y: anchor.getFullYear(), m: anchor.getMonth() });
  const [viewYear, setViewYear] = useState(anchor.getFullYear());
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const todayIso = toIso(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  function shiftMonth(delta: number) {
    setView((current) => {
      const next = new Date(current.y, current.m + delta, 1);
      return { y: next.getFullYear(), m: next.getMonth() };
    });
  }

  function pickDay(day: number) {
    const iso = toIso(view.y, view.m, day);
    if (mode === "day") {
      onPick(iso, iso);
      return;
    }
    if (!rangeStart) {
      setRangeStart(iso);
      return;
    }
    const [a, b] = iso < rangeStart ? [iso, rangeStart] : [rangeStart, iso];
    setRangeStart(null);
    onPick(a, b);
  }

  if (mode === "month") {
    const selected = anchor.getMonth();
    const selectedYear = anchor.getFullYear();
    return (
      <div className="w-72 p-3">
        <CalendarHeader
          label={`${viewYear}`}
          onPrev={() => setViewYear((y) => y - 1)}
          onNext={() => setViewYear((y) => y + 1)}
        />
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {MONTHS.map((name, index) => (
            <button
              key={name}
              type="button"
              className={cn(
                "rounded-lg px-2 py-2.5 text-sm font-medium transition duration-fast ease-out hover:bg-surface-muted",
                viewYear === selectedYear && index === selected && "bg-primary text-primary-foreground hover:bg-primary",
              )}
              onClick={() => onPick(toIso(viewYear, index, 1), toIso(viewYear, index, daysInMonth(viewYear, index)))}
            >
              {name.slice(0, 3)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (mode === "year") {
    const base = Math.floor(viewYear / 12) * 12;
    return (
      <div className="w-72 p-3">
        <CalendarHeader
          label={`${base} – ${base + 11}`}
          onPrev={() => setViewYear((y) => y - 12)}
          onNext={() => setViewYear((y) => y + 12)}
        />
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {Array.from({ length: 12 }, (_, i) => base + i).map((year) => (
            <button
              key={year}
              type="button"
              className={cn(
                "rounded-lg px-2 py-2.5 text-sm font-medium transition duration-fast ease-out hover:bg-surface-muted",
                year === anchor.getFullYear() && "bg-primary text-primary-foreground hover:bg-primary",
              )}
              onClick={() => onPick(`${year}-01-01`, `${year}-12-31`)}
            >
              {year}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const blanks = startWeekday(view.y, view.m);
  const count = daysInMonth(view.y, view.m);
  const cells: (number | null)[] = [...Array<null>(blanks).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];

  return (
    <div className="w-72 p-3">
      <CalendarHeader
        label={`${MONTHS[view.m]} ${view.y}`}
        onPrev={() => shiftMonth(-1)}
        onNext={() => shiftMonth(1)}
      />
      <div className="mt-2 grid grid-cols-7 gap-0.5 text-center">
        {WEEKDAYS.map((day) => (
          <span key={day} className="py-1 text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {day.slice(0, 2)}
          </span>
        ))}
        {cells.map((day, index) => {
          if (day === null) return <span key={`blank-${index}`} />;
          const iso = toIso(view.y, view.m, day);
          const isFrom = iso === from;
          const isTo = iso === to || iso === rangeStart;
          const inRange = mode === "period" && iso > from && iso < to;
          return (
            <button
              key={iso}
              type="button"
              aria-current={iso === todayIso ? "date" : undefined}
              className={cn(
                "flex h-9 items-center justify-center rounded-lg text-sm transition duration-fast ease-out hover:bg-surface-muted",
                isTodayRing(iso === todayIso, !isFrom && !isTo),
                inRange && "rounded-none bg-primary/10 text-foreground hover:bg-primary/15",
                (isFrom || isTo) && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
                mode === "period" && isFrom && to !== from && "rounded-r-none",
                mode === "period" && isTo && to !== from && "rounded-l-none",
              )}
              onClick={() => pickDay(day)}
            >
              {day}
            </button>
          );
        })}
      </div>
      {mode === "period" ? (
        <p className="mt-2 text-center text-caption text-muted-foreground">
          {rangeStart ? `From ${rangeStart} — pick the last day` : "Pick the first day, then the last"}
        </p>
      ) : null}
    </div>
  );
}

function isTodayRing(today: boolean, unselected: boolean) {
  return today && unselected ? "ring-1 ring-inset ring-primary/50" : "";
}

function CalendarHeader({ label, onPrev, onNext }: { label: string; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition duration-fast ease-out hover:bg-surface-muted hover:text-foreground"
        aria-label="Previous"
        onClick={onPrev}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </button>
      <p className="text-sm font-semibold">{label}</p>
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition duration-fast ease-out hover:bg-surface-muted hover:text-foreground"
        aria-label="Next"
        onClick={onNext}
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
