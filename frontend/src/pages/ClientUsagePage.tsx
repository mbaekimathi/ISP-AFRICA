import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

type UsageClient = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  routerName: string;
  bytesIn: number;
  bytesOut: number;
};

type UsageReport = {
  clients: UsageClient[];
  total: number;
  monthBytesIn: number;
  monthBytesOut: number;
  days: { day: string; bytesIn: number; bytesOut: number }[];
};

function bytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

export function ClientUsagePage({ kind }: { kind: "pppoe" | "hotspot" }) {
  const label = kind === "pppoe" ? "PPPoE" : "Hotspot";
  usePageMeta(kind === "pppoe" ? "PPPoE-usage — ISP CENTRIC" : "Hotspot-usage — ISP CENTRIC", `Usage for ${label} clients.`);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const path = kind === "pppoe" ? "/api/pppoe/usage" : "/api/hotspot/usage";
    apiRequest<UsageReport>(path)
      .then((body) => {
        setReport(body);
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : `${label} usage could not be loaded.`);
      });
  }, [kind, label]);

  const maxBytes = Math.max(1, ...(report?.days.map((day) => day.bytesIn + day.bytesOut) ?? [1]));

  return (
    <div className="page-shell py-8">
      <PageHeader
        title={kind === "pppoe" ? "PPPoE-usage" : "Hotspot-usage"}
        description={`Download and upload for every ${label} client over the last 30 days.`}
      />
      {message ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {message}
        </p>
      ) : null}
      {!report && !message ? <p className="mt-6 text-sm text-muted-foreground">Loading usage…</p> : null}
      {report ? (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Clients</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{report.total}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Download, 30 days</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(report.monthBytesIn)}</p>
            </article>
            <article className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted-foreground">Upload, 30 days</p>
              <p className="mt-1 text-xl font-semibold sm:text-2xl">{bytes(report.monthBytesOut)}</p>
            </article>
          </div>
          <section className="mt-4 rounded-xl border border-border bg-surface p-5">
            <h2 className="font-semibold">Last 14 days</h2>
            <div className="mt-4 flex h-24 items-end gap-1" aria-label={`${label} usage for the last 14 days`}>
              {report.days.length === 0 ? <p className="text-sm text-muted-foreground">No usage has been accounted yet.</p> : null}
              {report.days.map((day) => (
                <div
                  key={day.day}
                  className="flex-1 rounded-sm bg-primary"
                  style={{ height: `${Math.max(8, ((day.bytesIn + day.bytesOut) / maxBytes) * 100)}%` }}
                  title={`${day.day}: ${bytes(day.bytesIn + day.bytesOut)}`}
                />
              ))}
            </div>
          </section>
          <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="min-w-[40rem] w-full text-left text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 font-medium">Client</th>
                  <th className="px-3 py-3 font-medium">Username</th>
                  <th className="px-3 py-3 font-medium">Router</th>
                  <th className="px-3 py-3 font-medium">Download</th>
                  <th className="px-3 py-3 font-medium">Upload</th>
                  <th className="px-3 py-3 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.clients.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-muted-foreground">No {label} clients are registered yet.</td>
                  </tr>
                ) : null}
                {report.clients.map((client) => (
                  <tr key={client.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-3 font-medium">{client.firstName} {client.lastName}</td>
                    <td className="px-3 py-3">{client.username}</td>
                    <td className="px-3 py-3">{client.routerName}</td>
                    <td className="px-3 py-3">{bytes(client.bytesIn)}</td>
                    <td className="px-3 py-3">{bytes(client.bytesOut)}</td>
                    <td className="px-3 py-3">{bytes(client.bytesIn + client.bytesOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
