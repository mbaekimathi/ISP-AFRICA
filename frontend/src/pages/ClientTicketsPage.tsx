import * as Dialog from "@radix-ui/react-dialog";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TechnicianMobileNav } from "@/components/staff/TechnicianNav";
import { usePageMeta } from "@/hooks/usePageMeta";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/providers/AuthProvider";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";

function generatePassword() {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

type RouterOption = { id: string; name: string; tunnelStatus: string };
type PackageOption = { id: string; name: string; price: string; downloadMbps: number; uploadMbps: number };

type Ticket = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  buildingName: string;
  houseNumber: string;
  packageName: string;
  routerId: string | null;
  packageId: string | null;
  serial: string;
  pppoeUsername: string;
  status: string;
  assignedTo: string | null;
  kind: string;
  faultClient: string;
  faultDetails: string;
  returnReason: string;
  createdAt: string;
};

type TicketDraft = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  buildingName: string;
  houseNumber: string;
  packageName: string;
  pppoeUsername: string;
  pppoePassword: string;
};

type ServiceDraft = { routerId: string; packageId: string; serial: string; pppoeUsername: string; pppoePassword: string };

const emptyTicket: TicketDraft = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  buildingName: "",
  houseNumber: "",
  packageName: "",
  pppoeUsername: "",
  pppoePassword: "",
};
const emptyService: ServiceDraft = { routerId: "", packageId: "", serial: "", pppoeUsername: "", pppoePassword: "" };

const tabs = [
  { id: "new", label: "New tickets", status: "new" },
  { id: "onboarding", label: "Onboarding", status: "onboarding" },
  { id: "pending", label: "Pending activation", status: "pending_activation" },
  { id: "completed", label: "Completed", status: "completed" },
] as const;

type Tab = (typeof tabs)[number]["id"];

function badgeTone(status: string): "active" | "pending" | "due" {
  return status === "completed" ? "active" : status === "onboarding" ? "pending" : "due";
}

function badgeLabel(status: string) {
  return status === "new" ? "New" : status === "onboarding" ? "Onboarding" : status === "pending_activation" ? "Pending activation" : "Completed";
}

export function ClientTicketsPage() {
  usePageMeta("Tickets — ISP CENTRIC", "Pick up and onboard client tickets.");
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (tabs.some((item) => item.id === searchParams.get("tab")) ? searchParams.get("tab") : "new") as Tab;
  const [rows, setRows] = useState<Ticket[] | null>(null);
  const [listError, setListError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const wantsAdd = searchParams.get("add") === "1";
  const ticketOpen = formOpen || wantsAdd;
  const closeTicketForm = () => {
    setFormOpen(false);
    if (wantsAdd) {
      const next = new URLSearchParams(searchParams);
      next.delete("add");
      setSearchParams(next, { replace: true });
    }
  };
  const [ticket, setTicket] = useState<TicketDraft>({ ...emptyTicket, pppoePassword: generatePassword() });
  const [ticketKind, setTicketKind] = useState<"onboarding" | "fault">("onboarding");
  const [faultClientId, setFaultClientId] = useState("");
  const [faultDetails, setFaultDetails] = useState("");
  const [subscribers, setSubscribers] = useState<{ id: string; label: string; phone: string }[]>([]);
  const [faultQuery, setFaultQuery] = useState("");
  const [faultFocus, setFaultFocus] = useState(false);
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showServicePassword, setShowServicePassword] = useState(false);

  useEffect(() => {
    const digits = ticket.phone.replace(/\D/g, "");
    if (!usernameEdited && digits.length >= 3) setTicket((c) => ({ ...c, pppoeUsername: digits }));
  }, [ticket.phone, usernameEdited]);

  useEffect(() => {
    apiRequest<{ items?: Record<string, unknown>[]; subscribers?: Record<string, unknown>[] }>("/api/pppoe/subscribers")
      .then((body) => {
        const items = body.items ?? body.subscribers ?? [];
        setSubscribers(
          items
            .map((item) => {
              const id = String(item.id ?? "");
              const name = String(
                item.name ?? [item.firstName, item.lastName].filter(Boolean).join(" ") ?? "",
              );
              return {
                id,
                label: name || String(item.username ?? item.pppoeUsername ?? item.phone ?? id),
                phone: String(item.phone ?? item.phoneNumber ?? ""),
              };
            })
            .filter((item) => item.id),
        );
      })
      .catch(() => setSubscribers([]));
  }, []);
  const [target, setTarget] = useState<Ticket | null>(null);
  const [service, setService] = useState<ServiceDraft>(emptyService);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [routers, setRouters] = useState<RouterOption[]>([]);
  const [packages, setPackages] = useState<PackageOption[]>([]);

  const selectedPackage = packages.find((item) => item.id === service.packageId);
  const { user } = useAuth();
  const overview = user?.delegate?.kind === "isp-employee" && user.delegate.role === "isp-customercare";
  const [technicians, setTechnicians] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!overview) return;
    apiRequest<{ technicians: { id: string; name: string }[] }>("/api/client/technicians")
      .then((body) => setTechnicians(body.technicians))
      .catch(() => setTechnicians([]));
  }, [overview]);

  const [returnTarget, setReturnTarget] = useState<Ticket | null>(null);
  const [returnReason, setReturnReason] = useState("");

  async function activate(row: Ticket) {
    setBusyId(row.id);
    setNotice("");
    try {
      applyUpdate(
        (await apiRequest<{ onboarding: Ticket }>(`/api/client/onboardings/${row.id}/activate`, { method: "POST", body: "{}" })).onboarding,
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The ticket could not be activated.");
    } finally {
      setBusyId(null);
    }
  }

  async function submitReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!returnTarget) return;
    setSaving(true);
    setFormError("");
    try {
      applyUpdate(
        (await apiRequest<{ onboarding: Ticket }>(`/api/client/onboardings/${returnTarget.id}/return`, {
          method: "POST",
          body: JSON.stringify({ reason: returnReason }),
        })).onboarding,
      );
      setReturnTarget(null);
      setReturnReason("");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The ticket could not be returned.");
    } finally {
      setSaving(false);
    }
  }

  async function reassign(row: Ticket, staffId: string) {
    if (!staffId) return;
    setBusyId(row.id);
    setNotice("");
    try {
      applyUpdate(
        (await apiRequest<{ onboarding: Ticket }>(`/api/client/onboardings/${row.id}/reassign`, {
          method: "POST",
          body: JSON.stringify({ assignedTo: staffId }),
        })).onboarding,
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The ticket could not be reallocated.");
    } finally {
      setBusyId(null);
    }
  }
  const visible =
    rows === null || overview ? rows : rows.filter((row) => row.status === tabs.find((item) => item.id === tab)?.status);
  const faultTerm = faultQuery.trim().toLowerCase();
  const faultMatches = (
    faultTerm
      ? subscribers.filter(
          (item) => item.label.toLowerCase().includes(faultTerm) || item.phone.toLowerCase().includes(faultTerm),
        )
      : subscribers
  ).slice(0, 8);

  useEffect(() => {
    let stopped = false;
    apiRequest<{ onboardings: Ticket[] }>("/api/client/onboardings")
      .then((body) => {
        if (!stopped) setRows(body.onboardings);
      })
      .catch((cause: unknown) => {
        if (!stopped) setListError(cause instanceof Error ? cause.message : "Tickets could not be loaded.");
      });
    apiRequest<{ routers: RouterOption[] }>("/api/routers")
      .then((body) => setRouters(body.routers))
      .catch(() => setRouters([]));
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!service.routerId) {
      setPackages([]);
      return;
    }
    apiRequest<{ packages: PackageOption[] }>(`/api/routers/${service.routerId}/packages`)
      .then((body) => setPackages(body.packages))
      .catch(() => setPackages([]));
  }, [service.routerId]);

  function applyUpdate(updated: Ticket) {
    setRows((current) => current?.map((row) => (row.id === updated.id ? updated : row)) ?? null);
  }

  async function claim(row: Ticket) {
    setBusyId(row.id);
    setNotice("");
    try {
      applyUpdate(await apiRequest<{ onboarding: Ticket }>(`/api/client/onboardings/${row.id}/claim`, { method: "POST", body: "{}" }).then((b) => b.onboarding));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The ticket could not be picked up.");
    } finally {
      setBusyId(null);
    }
  }

  function setTicketField(field: keyof TicketDraft, value: string) {
    const next =
      field === "email"
        ? value.toLowerCase()
        : field === "firstName" || field === "lastName" || field === "buildingName" || field === "houseNumber" || field === "packageName"
          ? value.toUpperCase()
          : value;
    setTicket((current) => ({ ...current, [field]: next }));
  }

  async function submitTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ticketKind === "fault") {
      if (!faultClientId) {
        setFormError("Choose the client facing the fault.");
        return;
      }
      if (faultDetails.trim().length < 3) {
        setFormError("Describe the fault briefly.");
        return;
      }
    }
    setSaving(true);
    setFormError("");
    try {
      const payload =
        ticketKind === "fault"
          ? {
              kind: "fault",
              faultClientId,
              faultClient: subscribers.find((item) => item.id === faultClientId)?.label ?? "",
              faultDetails: faultDetails.trim(),
            }
          : { kind: "onboarding", ...ticket, pppoeUsername: ticket.pppoeUsername.trim() };
      const body = await apiRequest<{ onboarding: Ticket }>("/api/client/onboardings/new", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setRows((current) => [body.onboarding, ...(current ?? [])]);
      setTicket({ ...emptyTicket, pppoePassword: generatePassword() });
      setFaultClientId("");
      setFaultDetails("");
      setFaultQuery("");
      setUsernameEdited(false);
      closeTicketForm();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The ticket could not be created.");
    } finally {
      setSaving(false);
    }
  }

  async function resolveFault(row: Ticket) {
    setBusyId(row.id);
    setNotice("");
    try {
      applyUpdate(
        (await apiRequest<{ onboarding: Ticket }>(`/api/client/onboardings/${row.id}/onboard`, { method: "POST", body: "{}" })).onboarding,
      );
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The ticket could not be resolved.");
    } finally {
      setBusyId(null);
    }
  }

  async function submitService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target) return;
    if (!service.routerId || !service.packageId) {
      setFormError("Choose the router and package.");
      return;
    }
    if (service.pppoeUsername.trim().length < 3 || service.pppoePassword.trim().length < 4) {
      setFormError("Enter the PPPoE username and password.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const body = await apiRequest<{ onboarding: Ticket }>(`/api/client/onboardings/${target.id}/onboard`, {
        method: "POST",
        body: JSON.stringify({ ...service, packageName: selectedPackage?.name ?? "" }),
      });
      applyUpdate(body.onboarding);
      setTarget(null);
      setService(emptyService);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The ticket could not be onboarded.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-shell py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Tickets" description="Pick up client tickets, onboard them, and track activation." />
        <Dialog.Root open={ticketOpen} onOpenChange={(next) => (next ? setFormOpen(true) : closeTicketForm())}>
          <Dialog.Trigger asChild>
            <PrimaryButton type="button" className="lg:hidden">
              New ticket
            </PrimaryButton>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content max-w-2xl">
              <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">New ticket</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                Every technician can see new tickets and pick the one they want to onboard.
              </Dialog.Description>
              <form className="grid gap-5" onSubmit={submitTicket} noValidate>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: "onboarding", label: "Onboarding client" },
                    { id: "fault", label: "Fault ticket" },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setTicketKind(option.id)}
                      className={`rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                        ticketKind === option.id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-surface text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {ticketKind === "fault" ? (
                  <div className="grid gap-4">
                    <FormField id="tk-fault-client" label="Client facing the fault">
                      <div className="relative">
                        {faultClientId ? (
                          <div className="field flex items-center justify-between gap-2">
                            <span className="truncate">
                              {subscribers.find((item) => item.id === faultClientId)?.label ?? "Client"}
                            </span>
                            <button
                              type="button"
                              className="shrink-0 text-sm font-semibold text-muted-foreground transition hover:text-foreground"
                              onClick={() => {
                                setFaultClientId("");
                                setFaultQuery("");
                              }}
                            >
                              Change
                            </button>
                          </div>
                        ) : (
                          <input
                            id="tk-fault-client"
                            className="field"
                            autoComplete="off"
                            placeholder="Search by name or phone number…"
                            value={faultQuery}
                            onFocus={() => setFaultFocus(true)}
                            onBlur={() => window.setTimeout(() => setFaultFocus(false), 150)}
                            onChange={(event) => setFaultQuery(event.target.value)}
                          />
                        )}
                        {faultFocus && !faultClientId ? (
                          <ul
                            className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-auto rounded-lg border border-border bg-surface-raised py-1 shadow-lift"
                            role="listbox"
                          >
                            {faultMatches.length === 0 ? (
                              <li className="px-3 py-2 text-sm text-muted-foreground">No matching clients.</li>
                            ) : null}
                            {faultMatches.map((item) => (
                              <li key={item.id} role="option" aria-selected={false}>
                                <button
                                  type="button"
                                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition hover:bg-surface-muted"
                                  onMouseDown={(event) => {
                                    event.preventDefault();
                                    setFaultClientId(item.id);
                                    setFaultQuery("");
                                    setFaultFocus(false);
                                  }}
                                >
                                  <span className="truncate">{item.label}</span>
                                  <span className="shrink-0 text-xs text-muted-foreground">{item.phone}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </FormField>
                    <FormField id="tk-fault-details" label="Fault details">
                      <textarea
                        id="tk-fault-details"
                        className="field min-h-24"
                        placeholder="Briefly explain the fault"
                        value={faultDetails}
                        onChange={(event) => setFaultDetails(event.target.value)}
                      />
                    </FormField>
                  </div>
                ) : (
                  <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField id="tk-first" label="First name">
                    <input id="tk-first" className="field" value={ticket.firstName} onChange={(e) => setTicketField("firstName", e.target.value)} />
                  </FormField>
                  <FormField id="tk-last" label="Last name">
                    <input id="tk-last" className="field" value={ticket.lastName} onChange={(e) => setTicketField("lastName", e.target.value)} />
                  </FormField>
                  <FormField id="tk-phone" label="Phone number">
                    <input id="tk-phone" className="field" value={ticket.phone} onChange={(e) => setTicketField("phone", e.target.value)} />
                  </FormField>
                  <FormField id="tk-email" label="Email">
                    <input id="tk-email" className="field" type="email" value={ticket.email} onChange={(e) => setTicketField("email", e.target.value)} />
                  </FormField>
                  <FormField id="tk-building" label="Building name" hint="Optional">
                    <input id="tk-building" className="field" value={ticket.buildingName} onChange={(e) => setTicketField("buildingName", e.target.value)} />
                  </FormField>
                  <FormField id="tk-house" label="House number" hint="Optional">
                    <input id="tk-house" className="field" value={ticket.houseNumber} onChange={(e) => setTicketField("houseNumber", e.target.value)} />
                  </FormField>
                  <FormField id="tk-package" label="Package" hint="Optional">
                    <input id="tk-package" className="field" value={ticket.packageName} onChange={(e) => setTicketField("packageName", e.target.value)} />
                  </FormField>
                </div>
                <div className="border-t border-border/80 pt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">PPPoE credentials</p>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <FormField id="tk-pppoe-user" label="PPPoE username" hint="Auto-filled from the phone number.">
                      <input
                        id="tk-pppoe-user"
                        className="field"
                        value={ticket.pppoeUsername}
                        onChange={(e) => {
                          setUsernameEdited(true);
                          setTicket((c) => ({ ...c, pppoeUsername: e.target.value }));
                        }}
                      />
                    </FormField>
                    <FormField id="tk-pppoe-pass" label="PPPoE password">
                      <div className="flex flex-wrap gap-2">
                        <input
                          id="tk-pppoe-pass"
                          className="field min-w-0 flex-1"
                          type={showPassword ? "text" : "password"}
                          value={ticket.pppoePassword}
                          onChange={(e) => setTicket((c) => ({ ...c, pppoePassword: e.target.value }))}
                        />
                        <SecondaryButton type="button" onClick={() => setShowPassword((c) => !c)}>
                          {showPassword ? "Hide" : "Show"}
                        </SecondaryButton>
                        <SecondaryButton type="button" onClick={() => setTicket((c) => ({ ...c, pppoePassword: generatePassword() }))}>
                          New
                        </SecondaryButton>
                      </div>
                    </FormField>
                  </div>
                </div>
                  </>
                )}
                {formError ? <p className="text-sm text-destructive" role="alert">{formError}</p> : null}
                <div className="flex justify-end gap-2">
                  <SecondaryButton type="button" onClick={closeTicketForm} disabled={saving}>Cancel</SecondaryButton>
                  <PrimaryButton type="submit" disabled={saving}>{saving ? "Saving…" : "Create ticket"}</PrimaryButton>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
      <TechnicianMobileNav />
      <div className={`mt-6 flex flex-wrap gap-2 lg:hidden${overview ? " hidden" : ""}`}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSearchParams({ tab: item.id }, { replace: true })}
            className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
              tab === item.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-surface text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
            {rows ? ` (${rows.filter((row) => row.status === item.status).length})` : ""}
          </button>
        ))}
      </div>
      {notice ? <p className="mt-4 notice" role="alert">{notice}</p> : null}
      {listError ? <p className="mt-4 notice" role="alert">{listError}</p> : null}
      {visible === null ? (
        <div className="mt-4 grid gap-3">
          <div className="panel h-20 animate-pulse" />
          <div className="panel h-20 animate-pulse" />
        </div>
      ) : visible.length === 0 ? (
        <div className="panel mt-4 p-6 text-sm text-muted-foreground">No {tabs.find((item) => item.id === tab)?.label.toLowerCase()} right now.</div>
      ) : (
        <div className="mt-4 grid gap-3">
          {visible.map((row) => (
            <article key={row.id} className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary" aria-hidden="true">
                {`${row.firstName[0] ?? ""}${row.lastName[0] ?? ""}`.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-base font-semibold">
                    {row.kind === "fault" ? row.faultClient : `${row.firstName} ${row.lastName}`}
                  </p>
                  <StatusBadge tone={row.kind === "fault" ? "error" : "neutral"}>
                    {row.kind === "fault" ? "Fault" : "Onboarding"}
                  </StatusBadge>
                  <StatusBadge tone={badgeTone(row.status)}>{badgeLabel(row.status)}</StatusBadge>
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {row.kind === "fault" ? row.faultDetails : `${row.phone} · ${row.email}`}
                </p>
                <p className="truncate text-caption text-muted-foreground">
                  {row.kind === "fault"
                    ? `Fault ticket · ${row.createdAt}`
                    : `${[row.buildingName, row.houseNumber].filter(Boolean).join(" · ") || "No address"}${row.packageName ? ` · ${row.packageName}` : ""} · ${row.createdAt}`}
                </p>
                {overview && row.assignedTo ? (
                  <p className="truncate text-caption font-semibold text-foreground">
                    Assigned to {technicians.find((tech) => tech.id === row.assignedTo)?.name ?? "a technician"}
                  </p>
                ) : null}
                {row.returnReason && row.status === "onboarding" ? (
                  <p className="truncate text-caption font-medium text-warning">Returned: {row.returnReason}</p>
                ) : null}
              </div>
              {overview && (row.status === "new" || row.status === "onboarding") ? (
                <select
                  className="field w-auto min-w-0"
                  value=""
                  disabled={busyId === row.id}
                  aria-label={row.status === "new" ? "Allocate ticket" : "Reallocate ticket"}
                  onChange={(event) => void reassign(row, event.target.value)}
                >
                  <option value="">{row.status === "new" ? "Allocate…" : "Reallocate…"}</option>
                  {technicians
                    .filter((tech) => tech.id !== row.assignedTo)
                    .map((tech) => (
                      <option key={tech.id} value={tech.id}>
                        {tech.name}
                      </option>
                    ))}
                </select>
              ) : null}
              {overview && row.status === "pending_activation" ? (
                <div className="flex flex-wrap gap-2">
                  <PrimaryButton type="button" disabled={busyId === row.id} onClick={() => void activate(row)}>
                    {busyId === row.id ? "Working…" : "Activate"}
                  </PrimaryButton>
                  <SecondaryButton
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => {
                      setReturnReason("");
                      setFormError("");
                      setReturnTarget(row);
                    }}
                  >
                    Return
                  </SecondaryButton>
                </div>
              ) : null}
              {!overview && row.status === "new" ? (
                <SecondaryButton type="button" disabled={busyId === row.id} onClick={() => void claim(row)}>
                  {busyId === row.id ? "Picking…" : "Select ticket"}
                </SecondaryButton>
              ) : null}
              {!overview && row.status === "onboarding" && row.kind === "fault" ? (
                <PrimaryButton type="button" disabled={busyId === row.id} onClick={() => void resolveFault(row)}>
                  {busyId === row.id ? "Resolving…" : "Mark resolved"}
                </PrimaryButton>
              ) : null}
              {!overview && row.status === "onboarding" && row.kind !== "fault" ? (
                <PrimaryButton
                  type="button"
                  onClick={() => {
                    setService({ ...emptyService, pppoePassword: generatePassword(), pppoeUsername: row.pppoeUsername || row.phone.replace(/\D/g, "") });
                    setFormError("");
                    setTarget(row);
                  }}
                >
                  Onboard
                </PrimaryButton>
              ) : null}
            </article>
          ))}
        </div>
      )}
      <Dialog.Root open={target !== null} onOpenChange={(next) => (next ? undefined : setTarget(null))}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content max-w-2xl">
            <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
              Onboard {target?.firstName} {target?.lastName}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
              Assign the service — the account goes pending activation once saved.
            </Dialog.Description>
            <form className="grid gap-5" onSubmit={submitService} noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="svc-router" label="MikroTik router">
                  <select
                    id="svc-router"
                    className="field"
                    value={service.routerId}
                    onChange={(e) => setService((c) => ({ ...c, routerId: e.target.value, packageId: "" }))}
                  >
                    <option value="">Choose a router</option>
                    {routers.map((item) => (
                      <option key={item.id} value={item.id}>{item.name} ({item.tunnelStatus})</option>
                    ))}
                  </select>
                </FormField>
                <FormField
                  id="svc-package"
                  label="Package"
                  hint={selectedPackage ? `${selectedPackage.downloadMbps}/${selectedPackage.uploadMbps} Mbps · KSh ${selectedPackage.price}` : "Choose a router first."}
                >
                  <select
                    id="svc-package"
                    className="field"
                    value={service.packageId}
                    disabled={!service.routerId}
                    onChange={(e) => setService((c) => ({ ...c, packageId: e.target.value }))}
                  >
                    <option value="">Choose a package</option>
                    {packages.map((item) => (
                      <option key={item.id} value={item.id}>{item.name} · {item.downloadMbps}/{item.uploadMbps} Mbps · KSh {item.price}</option>
                    ))}
                  </select>
                </FormField>
                <FormField id="svc-serial" label="Router / ONU serial" hint="Optional — scan or type the serial number.">
                  <input id="svc-serial" className="field" value={service.serial} onChange={(e) => setService((c) => ({ ...c, serial: e.target.value }))} />
                </FormField>
              </div>
              <div className="border-t border-border/80 pt-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">PPPoE credentials</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <FormField id="svc-user" label="PPPoE username">
                    <input id="svc-user" className="field" value={service.pppoeUsername} onChange={(e) => setService((c) => ({ ...c, pppoeUsername: e.target.value }))} />
                  </FormField>
                  <FormField id="svc-pass" label="PPPoE password">
                    <div className="flex flex-wrap gap-2">
                      <input id="svc-pass" className="field min-w-0 flex-1" type={showServicePassword ? "text" : "password"} value={service.pppoePassword} onChange={(e) => setService((c) => ({ ...c, pppoePassword: e.target.value }))} />
                      <SecondaryButton type="button" onClick={() => setShowServicePassword((c) => !c)}>{showServicePassword ? "Hide" : "Show"}</SecondaryButton>
                      <SecondaryButton type="button" onClick={() => setService((c) => ({ ...c, pppoePassword: generatePassword() }))}>New</SecondaryButton>
                    </div>
                  </FormField>
                </div>
              </div>
              {formError ? <p className="text-sm text-destructive" role="alert">{formError}</p> : null}
              <div className="flex justify-end gap-2 border-t border-border/80 pt-4">
                <SecondaryButton type="button" onClick={() => setTarget(null)} disabled={saving}>Cancel</SecondaryButton>
                <PrimaryButton type="submit" disabled={saving}>{saving ? "Saving…" : "Onboard client"}</PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={returnTarget !== null} onOpenChange={(next) => (next ? undefined : setReturnTarget(null))}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">Return ticket</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
              Sends it back to the technician as onboarding — tell them why.
            </Dialog.Description>
            <form className="grid gap-4" onSubmit={submitReturn} noValidate>
              <FormField id="return-reason" label="Reason">
                <textarea
                  id="return-reason"
                  className="field min-h-24"
                  placeholder="Why is this ticket being returned?"
                  value={returnReason}
                  onChange={(event) => setReturnReason(event.target.value)}
                />
              </FormField>
              {formError ? <p className="text-sm text-destructive" role="alert">{formError}</p> : null}
              <div className="flex justify-end gap-2">
                <SecondaryButton type="button" onClick={() => setReturnTarget(null)} disabled={saving}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton type="submit" disabled={saving}>
                  {saving ? "Returning…" : "Return ticket"}
                </PrimaryButton>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
