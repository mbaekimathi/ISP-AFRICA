import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Download, Upload } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";

type Subscriber = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  username: string;
  routerId: string;
  routerName: string;
  packageName: string;
  connection: "online" | "offline" | "unknown";
  routerStatus:
    | "surfing"
    | "connected"
    | "not_surfing"
    | "expired"
    | "expired_online"
    | "suspended"
    | "suspended_online"
    | "disconnecting"
    | "disconnected"
    | "pending_activation";
};

type RouterOption = {
  id: string;
  name: string;
  site: string;
  tunnelStatus: string;
};

type ListPage = {
  subscribers: Subscriber[];
  total: number;
  routers: RouterOption[];
  packages: { id: string; name: string }[];
};

type TransferResult = {
  router: string;
  moved: { id: string; name: string }[];
  failed: { id: string; name: string; error: string }[];
};

type ImportResult = {
  created: { row: number; name: string; username: string; password: string; warnings: string[] }[];
  failed: { row: number; name: string; error: string }[];
  truncated: number;
};

type Group = {
  routerId: string;
  name: string;
  clients: Subscriber[];
};

const routerStatusLabel = {
  surfing: "Surfing",
  connected: "Connected",
  not_surfing: "Not surfing",
  expired: "Expired",
  expired_online: "Expired",
  suspended: "Suspended",
  suspended_online: "Suspended",
  disconnecting: "Disconnecting",
  disconnected: "Disconnected",
  pending_activation: "Pending activation",
} as const;

const routerStatusTone = {
  surfing: "active",
  connected: "due",
  not_surfing: "paused",
  expired: "critical",
  expired_online: "due",
  suspended: "due",
  suspended_online: "due",
  disconnecting: "due",
  disconnected: "paused",
  pending_activation: "neutral",
} as const;

function connectionDot(connection: Subscriber["connection"]) {
  return connection === "online" ? "bg-success" : connection === "offline" ? "bg-destructive" : "bg-warning";
}

function initials(client: Subscriber) {
  return `${client.firstName.trim().charAt(0)}${client.lastName.trim().charAt(0)}`.toUpperCase() || "?";
}

const FORM_HEADERS = "firstName,lastName,phone,username,password,router,package,startDate,price,serial,email";

const HEADER_KEYS: Record<string, string> = {
  firstname: "firstName",
  lastname: "lastName",
  phone: "phone",
  phonenumber: "phone",
  msisdn: "phone",
  email: "email",
  building: "buildingName",
  buildingname: "buildingName",
  house: "houseNumber",
  housenumber: "houseNumber",
  username: "username",
  pppoeusername: "username",
  password: "password",
  pppoepassword: "password",
  router: "router",
  mikrotik: "router",
  mikrotikrouter: "router",
  routername: "router",
  package: "package",
  packagename: "package",
  plan: "package",
  startdate: "startDate",
  price: "price",
  serial: "serial",
  serialnumber: "serial",
  routerserial: "serial",
  onuserial: "serial",
  billingcycle: "billingCycle",
  cycledays: "cycleDays",
  initialpayment: "initialPayment",
  staticip: "staticIp",
  accessinterface: "accessInterface",
  sessionlimit: "sessionLimit",
  autorenew: "autoRenew",
};

function parseCsv(text: string, delimiter = ",") {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((item) => item.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => item.trim() !== "")) rows.push(row);
  return rows;
}

function recordsFromCsv(text: string) {
  let grid = parseCsv(text);
  // Excel in some locales saves CSVs separated by semicolons — the header then
  // reads as one cell, so re-parse on that delimiter.
  if (grid.length && grid[0].length === 1 && grid[0][0].includes(";")) {
    grid = parseCsv(text, ";");
  }
  if (!grid.length) return { rows: [] as Record<string, string>[], error: "The form is empty." };
  const keys = grid[0].map((head) => HEADER_KEYS[head.toLowerCase().replace(/[^a-z0-9]/g, "")] || "");
  if (!keys.some(Boolean)) {
    return { rows: [] as Record<string, string>[], error: "No known columns were found — download the form to see the right headings." };
  }
  const rows = grid
    .slice(1)
    .map((cells) => {
      const record: Record<string, string> = {};
      cells.forEach((cell, index) => {
        const key = keys[index];
        if (key && cell.trim() !== "") record[key] = cell.trim();
      });
      return record;
    })
    .filter((record) => Object.keys(record).length > 0);
  if (!rows.length) return { rows: [] as Record<string, string>[], error: "The form has a header row but no client rows." };
  return { rows, error: "" };
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function downloadCsv(name: string, lines: string[]) {
  const url = URL.createObjectURL(new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function GroupCheckbox({
  group,
  selected,
  onToggle,
}: {
  group: Group;
  selected: Set<string>;
  onToggle: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = group.clients.filter((client) => selected.has(client.id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < group.clients.length;
  }, [count, group.clients.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={count > 0 && count === group.clients.length}
      onChange={(event) => onToggle(event.target.checked)}
      aria-label={`Select all clients on ${group.name}`}
    />
  );
}

export function ImportClientsPage() {
  usePageMeta("Import Clients — ISP CENTRIC", "Move PPPoE clients between MikroTik routers.");
  const [page, setPage] = useState<ListPage | null>(null);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ from: string; outcome: TransferResult } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<Record<string, string>[] | null>(null);
  const [importFile, setImportFile] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  function load() {
    apiRequest<ListPage>("/api/pppoe/subscribers?limit=1000")
      .then((body) => {
        setPage(body);
        setMessage("");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Clients could not be loaded.");
      });
  }

  useEffect(() => {
    load();
  }, []);

  const groups = useMemo<Group[]>(() => {
    if (!page) return [];
    const byRouter = new Map<string, Group>();
    for (const client of page.subscribers) {
      const key = client.routerId || "none";
      let group = byRouter.get(key);
      if (!group) {
        group = {
          routerId: key,
          name: client.routerName || page.routers.find((router) => router.id === key)?.name || "Unknown router",
          clients: [],
        };
        byRouter.set(key, group);
      }
      group.clients.push(client);
    }
    return [...byRouter.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [page]);

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleGroup(group: Group, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const client of group.clients) {
        if (on) next.add(client.id);
        else next.delete(client.id);
      }
      return next;
    });
  }

  async function transfer(group: Group) {
    const ids = group.clients.filter((client) => selected.has(client.id)).map((client) => client.id);
    const routerId = targets[group.routerId] || "";
    if (!ids.length || !routerId || busy) return;
    setBusy(group.routerId);
    setMessage("");
    try {
      const body = await apiRequest<{ result: TransferResult }>("/api/pppoe/transfer", {
        method: "POST",
        body: JSON.stringify({ routerId, subscriberIds: ids }),
      });
      const moved = new Set(body.result.moved.map((item) => item.id));
      setSelected((current) => new Set([...current].filter((id) => !moved.has(id))));
      setResult({ from: group.name, outcome: body.result });
      load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The clients could not be moved.");
    } finally {
      setBusy(null);
    }
  }

  function downloadForm() {
    downloadCsv("pppoe-clients-form.csv", [FORM_HEADERS]);
  }

  async function pickForm(file: File | undefined) {
    setImportError("");
    setImportResult(null);
    if (!file) return;
    const parsed = recordsFromCsv(await file.text());
    if (parsed.error) {
      setImportError(parsed.error);
      setImportRows(null);
      setImportFile("");
      return;
    }
    setImportRows(parsed.rows);
    setImportFile(file.name);
  }

  async function runImport() {
    if (!importRows?.length || importing) return;
    setImporting(true);
    setImportError("");
    try {
      const body = await apiRequest<{ result: ImportResult }>("/api/pppoe/import", {
        method: "POST",
        body: JSON.stringify({ rows: importRows }),
      });
      setImportResult(body.result);
      setImportRows(null);
      setImportFile("");
      if (fileRef.current) fileRef.current.value = "";
      load();
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "The clients could not be imported.");
    } finally {
      setImporting(false);
    }
  }

  function downloadCredentials() {
    if (!importResult) return;
    downloadCsv("pppoe-client-logins.csv", [
      "name,username,password",
      ...importResult.created.map((item) => [item.name, item.username, item.password].map(csvCell).join(",")),
    ]);
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Import Clients" />
      <section className="card p-5 sm:p-6">
        <h2 className="text-xl font-semibold tracking-tight">Import clients</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Register many PPPoE clients at once from a form, or move existing clients between MikroTik routers below.
        </p>
      </section>

      <section className="card mt-4 p-5 sm:p-6">
        <h3 className="font-semibold">Register clients from a form</h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Download the form, fill in one row per client, then upload it — every row is registered automatically.
          Required columns are <code>firstName</code>, <code>phone</code>, <code>router</code>, and{" "}
          <code>package</code> — type the router and package names exactly as saved. Leave <code>username</code> or{" "}
          <code>password</code> empty to auto-fill them; leave <code>startDate</code> empty to keep the account
          pending.
        </p>
        {page ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Routers: {page.routers.map((router) => router.name).join(", ") || "—"}
            <br />
            Packages: {page.packages.map((item) => item.name).join(", ") || "—"}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SecondaryButton className="min-h-9" onClick={downloadForm}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download form
          </SecondaryButton>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="field min-h-9 w-auto max-w-full py-1 text-sm"
            aria-label="Upload filled client form"
            onChange={(event) => void pickForm(event.target.files?.[0])}
          />
          <PrimaryButton className="min-h-9" disabled={!importRows?.length || importing} aria-busy={importing} onClick={() => void runImport()}>
            <Upload className="h-4 w-4" aria-hidden="true" />
            {importing ? "Registering…" : importRows ? `Register ${importRows.length} client${importRows.length === 1 ? "" : "s"}` : "Register clients"}
          </PrimaryButton>
          {importFile && importRows ? (
            <span className="text-sm text-muted-foreground">
              {importFile} · {importRows.length} row{importRows.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {importError ? (
          <p className="notice mt-3" role="alert">
            {importError}
          </p>
        ) : null}
        {importResult ? (
          <div className={`notice mt-3 ${importResult.failed.length ? "" : "notice-info"}`} role="status">
            <p>
              {importResult.created.length} client{importResult.created.length === 1 ? "" : "s"} registered
              {importResult.failed.length ? `, ${importResult.failed.length} row${importResult.failed.length === 1 ? "" : "s"} failed` : ""}.
              {importResult.truncated ? ` ${importResult.truncated} extra row${importResult.truncated === 1 ? " was" : "s were"} skipped — upload at most 500 rows at a time.` : ""}
            </p>
            {importResult.created.length ? (
              <SecondaryButton className="mt-2 min-h-9" onClick={downloadCredentials}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Download logins (CSV)
              </SecondaryButton>
            ) : null}
            {importResult.failed.length ? (
              <ul className="mt-1.5 grid gap-0.5 text-xs">
                {importResult.failed.map((item) => (
                  <li key={item.row}>
                    Row {item.row}
                    {item.name ? ` · ${item.name}` : ""}: {item.error}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <h3 className="mt-6 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Move clients between MikroTiks</h3>

      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}

      {result ? (
        <div className={`notice mt-4 ${result.outcome.failed.length ? "" : "notice-info"}`} role="status">
          <p>
            {result.outcome.moved.length} client{result.outcome.moved.length === 1 ? "" : "s"} moved from{" "}
            {result.from} to {result.outcome.router}
            {result.outcome.failed.length ? `, ${result.outcome.failed.length} could not be moved` : ""}.
          </p>
          {result.outcome.failed.length ? (
            <ul className="mt-1.5 grid gap-0.5 text-xs">
              {result.outcome.failed.map((item) => (
                <li key={item.id}>
                  {item.name || item.id}: {item.error}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!page && !message ? (
        <div className="card mt-4 grid gap-3 p-5" aria-hidden="true">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-4 w-3/5" />
          <div className="skeleton h-4 w-2/5" />
          <span className="sr-only">Loading clients…</span>
        </div>
      ) : null}

      {page && groups.length === 0 ? (
        <p className="card mt-4 px-4 py-10 text-center text-sm text-muted-foreground">No PPPoE clients are registered yet.</p>
      ) : null}

      {groups.map((group) => {
        const picked = group.clients.filter((client) => selected.has(client.id)).length;
        const target = targets[group.routerId] || "";
        const isBusy = busy === group.routerId;
        const destinations = page?.routers.filter((router) => router.id !== group.routerId) ?? [];
        return (
          <section key={group.routerId} className="card mt-4 overflow-hidden">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
              <GroupCheckbox group={group} selected={selected} onToggle={(on) => toggleGroup(group, on)} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-semibold">{group.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {group.clients.length} client{group.clients.length === 1 ? "" : "s"}
                  {picked ? ` · ${picked} selected` : ""}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm font-medium">
                Move to
                <select
                  className="field min-h-9 w-auto py-1"
                  value={target}
                  disabled={isBusy || destinations.length === 0}
                  onChange={(event) => setTargets((current) => ({ ...current, [group.routerId]: event.target.value }))}
                >
                  <option value="">{destinations.length ? "Choose router…" : "No other router"}</option>
                  {destinations.map((router) => (
                    <option key={router.id} value={router.id}>
                      {router.name}
                      {router.site ? ` · ${router.site}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <PrimaryButton
                className="min-h-9"
                disabled={!target || picked === 0 || busy !== null}
                aria-busy={isBusy}
                onClick={() => void transfer(group)}
              >
                Transfer{picked ? ` ${picked}` : ""}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </PrimaryButton>
            </div>
            <ul className="divide-y divide-border">
              {group.clients.map((client) => (
                <li key={client.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-fast ease-out hover:bg-surface-muted/50">
                    <input
                      type="checkbox"
                      checked={selected.has(client.id)}
                      onChange={(event) => toggle(client.id, event.target.checked)}
                    />
                    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60 text-[11px] font-bold text-primary-foreground">
                      {initials(client)}
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${connectionDot(client.connection)}`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {client.firstName} {client.lastName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {client.phone} · {client.username}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-sm text-muted-foreground sm:block">{client.packageName || "—"}</span>
                    <StatusBadge tone={routerStatusTone[client.routerStatus]}>{routerStatusLabel[client.routerStatus]}</StatusBadge>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
