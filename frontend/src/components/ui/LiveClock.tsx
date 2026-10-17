import { useEffect, useState } from "react";

function two(value: number) {
  return String(value).padStart(2, "0");
}

export function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const hours = two(now.getHours());
  const minutes = two(now.getMinutes());
  const seconds = two(now.getSeconds());

  return (
    <div
      className="hidden items-baseline gap-2 sm:flex"
      role="timer"
      aria-label={`${date}, ${hours}:${minutes}:${seconds}`}
    >
      <span className="text-xs text-muted-foreground">{date}</span>
      <span className="font-mono text-sm font-semibold tabular-nums tracking-tight text-foreground">
        {hours}:{minutes}:
        <span key={seconds} className="clock-tick inline-block">
          {seconds}
        </span>
      </span>
    </div>
  );
}
