import { previewSubscribers } from "@/content/landing";
import { ChartPreview } from "@/components/previews/ChartPreview";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PreviewFrame, StatCard } from "@/components/previews/StatCard";

const toneFor = {
  Active: "active",
  Due: "due",
  Paused: "paused",
} as const;

export function HeroPreview() {
  return (
    <PreviewFrame label="Operations snapshot">
      <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
        <StatCard label="Active subscribers" value="1,284" detail="Sample accounts in service" />
        <StatCard label="Monthly recurring" value="$48,920" detail="Sample billed this cycle" />
        <StatCard label="Open invoices" value="126" detail="Sample balances to review" />
        <StatCard label="Services online" value="1,196" detail="Sample active connections" />
      </div>
      <div className="grid gap-3 border-t border-border p-4 sm:p-5">
        <div className="rounded-xl border border-border bg-surface-muted p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">Subscriber growth</p>
            <p className="text-xs text-muted-foreground">Sample</p>
          </div>
          <svg viewBox="0 0 240 56" className="mt-3 h-14 w-full text-primary" role="img" aria-label="Sample subscriber growth trending upward">
            <polyline points="0,44 40,40 80,36 120,28 160,22 200,14 240,8" fill="none" stroke="currentColor" strokeWidth="3" />
          </svg>
        </div>
        <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
          {[
            ["Fibre 50", "$42 paid"],
            ["Wireless 20", "$24 recorded"],
            ["Hotspot Plus", "$18 open"],
          ].map(([name, detail]) => (
            <li key={name} className="rounded-xl border border-border bg-surface px-3 py-3">
              <p className="font-medium text-foreground">{name}</p>
              <p>{detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </PreviewFrame>
  );
}

export function DashboardPreview() {
  return (
    <PreviewFrame label="Application preview">
      <div className="grid lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="hidden border-b border-sidebar-border bg-sidebar p-4 text-sidebar-foreground lg:block lg:border-b-0 lg:border-r">
          <p className="px-2 text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-muted">Workspace</p>
          <ul className="mt-4 space-y-1 text-sm">
            {["Overview", "Subscribers", "Billing", "Payments", "Packages"].map((item, index) => (
              <li
                key={item}
                className={
                  index === 0
                    ? "rounded-lg bg-sidebar-active px-3 py-2 font-medium"
                    : "rounded-lg px-3 py-2 text-sidebar-muted"
                }
              >
                {item}
              </li>
            ))}
          </ul>
        </aside>
        <div className="min-w-0 bg-surface-muted p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Overview</p>
              <p className="text-xs text-muted-foreground">Marketing illustration, not a live workspace</p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
              October cycle
            </span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <StatCard label="Collected" value="$36,410" detail="Sample payments" />
            <StatCard label="Outstanding" value="$12,510" detail="Sample open balance" />
            <StatCard label="New accounts" value="86" detail="Sample this month" />
          </div>
          <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <ChartPreview />
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="text-sm font-semibold text-foreground">Recent activity</p>
              <ul className="mt-3 space-y-3 text-sm">
                {[
                  "Invoice FC-2041 marked paid",
                  "Fibre 50 assigned to a new subscriber",
                  "Payment of $24 recorded",
                  "Package price reviewed by billing",
                ].map((item) => (
                  <li key={item} className="border-b border-border pb-3 text-muted-foreground last:border-0 last:pb-0">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-foreground">Subscribers</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <caption className="sr-only">Sample subscriber records in the product preview</caption>
                <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Subscriber</th>
                    <th className="px-4 py-3 font-medium">Package</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {previewSubscribers.map((row) => (
                    <tr key={row.name} className="border-t border-border">
                      <td className="px-4 py-3 font-medium text-foreground">{row.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{row.packageName}</td>
                      <td className="px-4 py-3">
                        <StatusBadge tone={toneFor[row.status]}>{row.status}</StatusBadge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </PreviewFrame>
  );
}
