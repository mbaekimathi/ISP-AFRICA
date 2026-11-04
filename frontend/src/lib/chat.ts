/* Conversational ticket assistant. Pure command engine: the page renders the
   messages it returns, and every quick-reply button just feeds a command back
   through `handle()` — typed text and taps share one pipeline. */

import { apiRequest } from "@/lib/api";

export type ChatRole = "owner" | "isp-technician" | "isp-customercare" | "isp-manager";

export type ChatTicket = {
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
  pppoePassword: string;
  status: string;
  assignedTo: string | null;
  kind: string;
  faultClient: string;
  faultDetails: string;
  returnReason: string;
  createdAt: string;
};

export type ChatOption = {
  label: string;
  command: string;
  tone?: "plain" | "primary" | "success" | "danger";
};

export type TicketCard = {
  ticketId: string;
  ref: string;
  title: string;
  lines: { label: string; value: string }[];
  status: string;
  kind: string;
};

export type ChatMessage = {
  id: string;
  from: "bot" | "user";
  kind: "text" | "card" | "notice" | "error";
  text: string;
  card?: TicketCard;
  options?: ChatOption[];
  time: number;
};

type Subscriber = { id: string; label: string; phone: string };
type RouterOption = { id: string; name: string };
type PackageOption = { id: string; name: string; price: string };
type TechnicianOption = { id: string; name: string };

type OnboardDraft = {
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

type ServiceDraft = {
  routerId: string;
  routerName: string;
  packageId: string;
  packageName: string;
  serial: string;
  pppoeUsername: string;
  pppoePassword: string;
};

type Flow =
  | { step: "idle" }
  | { step: "create-kind" }
  | { step: "ob-field"; index: number; draft: Partial<OnboardDraft> }
  | { step: "ob-confirm"; draft: OnboardDraft }
  | { step: "fault-query" }
  | { step: "fault-pick"; matches: Subscriber[] }
  | { step: "fault-details"; clientId: string; clientName: string }
  | { step: "fault-confirm"; clientId: string; clientName: string; details: string }
  | { step: "pick-ticket"; tickets: ChatTicket[] }
  | { step: "return-reason"; ticketId: string }
  | { step: "reassign-pick"; ticketId: string; techs: TechnicianOption[] }
  | { step: "svc-router"; ticketId: string; routers: RouterOption[]; draft: Partial<ServiceDraft> }
  | { step: "svc-package"; ticketId: string; packages: PackageOption[]; draft: Partial<ServiceDraft> }
  | { step: "svc-serial"; ticketId: string; draft: Partial<ServiceDraft> }
  | { step: "svc-user"; ticketId: string; draft: Partial<ServiceDraft> }
  | { step: "svc-pass"; ticketId: string; draft: Partial<ServiceDraft> }
  | { step: "svc-confirm"; ticketId: string; draft: ServiceDraft };

const IDLE: Flow = { step: "idle" };

const ONBOARD_FIELDS: {
  key: keyof OnboardDraft;
  ask: string;
  optional?: boolean;
  autoHint?: string;
  validate: (value: string) => string | null;
}[] = [
  { key: "firstName", ask: "Client's *first name*?", validate: (v) => (v.trim().length >= 2 ? null : "At least 2 characters.") },
  { key: "lastName", ask: "And the *last name*?", validate: (v) => (v.trim().length >= 2 ? null : "At least 2 characters.") },
  {
    key: "phone",
    ask: "Their *phone number*?",
    validate: (v) => {
      const digits = v.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15 ? null : "10–15 digits please.";
    },
  },
  {
    key: "email",
    ask: "Their *email address*?",
    validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : "That doesn't look like an email."),
  },
  { key: "buildingName", ask: "*Building name*? (or *skip*)", optional: true, validate: () => null },
  { key: "houseNumber", ask: "*House / unit number*? (or *skip*)", optional: true, validate: () => null },
  { key: "packageName", ask: "*Package name*? e.g. 10 Mbps Home (or *skip*)", optional: true, validate: () => null },
  {
    key: "pppoeUsername",
    ask: "*PPPoE username*? (or *auto* to use the phone digits)",
    autoHint: "auto",
    validate: (v) => (v.trim().length >= 3 ? null : "At least 3 characters."),
  },
  {
    key: "pppoePassword",
    ask: "*PPPoE password*? (or *auto* for a strong one)",
    autoHint: "auto",
    validate: (v) => (v.trim().length >= 4 ? null : "At least 4 characters."),
  },
];

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789";

export function generatePassword() {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => PASSWORD_ALPHABET[value % PASSWORD_ALPHABET.length]).join("");
}

export function ticketRef(id: string) {
  return `#${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export function ticketTitle(ticket: ChatTicket) {
  if (ticket.kind === "fault") return ticket.faultClient || "Fault ticket";
  return `${ticket.firstName} ${ticket.lastName}`.trim() || "New client";
}

export function statusLabel(status: string) {
  return status === "new"
    ? "New"
    : status === "onboarding"
      ? "Onboarding"
      : status === "pending_activation"
        ? "Pending activation"
        : "Completed";
}

function msgId() {
  return `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function bot(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: msgId(), from: "bot", kind: "text", text, time: Date.now(), ...extra };
}

function card(ticket: ChatTicket, options: ChatOption[] = []): ChatMessage {
  const lines: TicketCard["lines"] = [];
  if (ticket.kind === "fault") {
    lines.push({ label: "Client", value: ticket.faultClient });
    if (ticket.faultDetails) lines.push({ label: "Fault", value: ticket.faultDetails });
  } else {
    lines.push({ label: "Phone", value: ticket.phone });
    if (ticket.email) lines.push({ label: "Email", value: ticket.email });
    const where = [ticket.buildingName, ticket.houseNumber].filter(Boolean).join(", ");
    if (where) lines.push({ label: "Address", value: where });
    if (ticket.packageName) lines.push({ label: "Package", value: ticket.packageName });
    if (ticket.pppoeUsername) lines.push({ label: "PPPoE", value: ticket.pppoeUsername });
  }
  if (ticket.returnReason) lines.push({ label: "Returned", value: ticket.returnReason });
  lines.push({ label: "Status", value: statusLabel(ticket.status) });
  return bot("", {
    kind: "card",
    text: `${ticketRef(ticket.id)} · ${ticketTitle(ticket)}`,
    card: {
      ticketId: ticket.id,
      ref: ticketRef(ticket.id),
      title: `${ticketRef(ticket.id)} · ${ticketTitle(ticket)}`,
      lines,
      status: ticket.status,
      kind: ticket.kind,
    },
    options,
  });
}

function errorMsg(text: string): ChatMessage {
  return bot(text, { kind: "error", options: [{ label: "Menu", command: "cmd:menu", tone: "plain" }] });
}

async function listTickets(): Promise<ChatTicket[]> {
  const body = await apiRequest<{ onboardings: ChatTicket[] }>("/api/client/onboardings");
  return body.onboardings;
}

async function listTechnicians(): Promise<TechnicianOption[]> {
  const body = await apiRequest<{ technicians: TechnicianOption[] }>("/api/client/technicians");
  return body.technicians;
}

async function listRouters(): Promise<RouterOption[]> {
  const body = await apiRequest<{ routers: RouterOption[] }>("/api/routers");
  return body.routers;
}

async function listPackages(routerId: string): Promise<PackageOption[]> {
  const body = await apiRequest<{ packages: PackageOption[] }>(`/api/routers/${routerId}/packages`);
  return body.packages;
}

async function listSubscribers(): Promise<Subscriber[]> {
  const body = await apiRequest<{ items?: Record<string, unknown>[]; subscribers?: Record<string, unknown>[] }>(
    "/api/pppoe/subscribers",
  );
  const items = body.items ?? body.subscribers ?? [];
  return items
    .map((item) => ({
      id: String(item.id ?? ""),
      label:
        String(item.name ?? "") ||
        [item.firstName, item.lastName].filter(Boolean).join(" ") ||
        String(item.username ?? item.pppoeUsername ?? item.phone ?? ""),
      phone: String(item.phone ?? item.phoneNumber ?? ""),
    }))
    .filter((item) => item.id);
}

async function runTicketAction(ticketId: string, action: string, payload: Record<string, unknown> = {}) {
  const body = await apiRequest<{ onboarding: ChatTicket }>(`/api/client/onboardings/${ticketId}/${action}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return body.onboarding;
}

async function createTicket(payload: Record<string, unknown>) {
  const body = await apiRequest<{ onboarding: ChatTicket }>("/api/client/onboardings/new", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return body.onboarding;
}

export class Assistant {
  role: ChatRole;
  name: string;
  private flows = new Map<string, Flow>();

  constructor(role: ChatRole, name: string) {
    this.role = role;
    this.name = name;
  }

  private flow(threadId: string) {
    return this.flows.get(threadId) ?? IDLE;
  }

  private setFlow(threadId: string, flow: Flow) {
    if (flow.step === "idle") this.flows.delete(threadId);
    else this.flows.set(threadId, flow);
  }

  private get canDispatch() {
    return this.role !== "isp-technician";
  }

  private get isStaff() {
    return this.role !== "owner";
  }

  /* Actions shown under a ticket card, honouring status + role gates. */
  private actionsFor(ticket: ChatTicket): ChatOption[] {
    const options: ChatOption[] = [];
    const id = ticket.id;
    if (ticket.status === "new") {
      if (this.isStaff) options.push({ label: "Claim", command: `cmd:claim ${id}`, tone: "primary" });
      if (this.canDispatch) options.push({ label: "Assign to…", command: `cmd:reassign ${id}` });
    } else if (ticket.status === "onboarding") {
      if (this.isStaff)
        options.push({
          label: ticket.kind === "fault" ? "Resolve" : "Fill service details",
          command: `cmd:onboard ${id}`,
          tone: "primary",
        });
      if (this.canDispatch) options.push({ label: "Reassign…", command: `cmd:reassign ${id}` });
    } else if (ticket.status === "pending_activation") {
      if (this.canDispatch) {
        options.push({ label: "Activate", command: `cmd:activate ${id}`, tone: "success" });
        options.push({ label: "Return…", command: `cmd:return ${id}`, tone: "danger" });
      }
    }
    options.push({ label: "Open chat", command: `cmd:open ${id}` });
    return options;
  }

  /* First bot message(s) when a thread opens. */
  async open(threadId: string): Promise<ChatMessage[]> {
    if (threadId.startsWith("ticket:")) {
      const ticketId = threadId.slice("ticket:".length);
      return this.showTicket(ticketId);
    }
    return [
      bot(
        `Hi${this.name ? ` ${this.name}` : ""}! I'm the ISP assistant. ` +
          `I can create tickets, move them along, and keep you posted — just like chatting on WhatsApp.`,
      ),
      this.menuMessage(),
    ];
  }

  private menuMessage(): ChatMessage {
    const options: ChatOption[] = [
      { label: "New ticket", command: "cmd:new", tone: "primary" },
      { label: "My tickets", command: "cmd:tickets" },
      { label: "Update a ticket", command: "cmd:update" },
    ];
    if (this.canDispatch) options.push({ label: "Assign work", command: "cmd:assign" });
    return bot("What would you like to do?", { options });
  }

  private async showTicket(ticketId: string): Promise<ChatMessage[]> {
    try {
      const tickets = await listTickets();
      const ticket = tickets.find((item) => item.id === ticketId);
      if (!ticket) return [errorMsg("That ticket is gone — it may have been removed or completed already.")];
      return [card(ticket, this.actionsFor(ticket))];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't load that ticket.")];
    }
  }

  async handle(threadId: string, input: string): Promise<ChatMessage[]> {
    const text = input.trim();
    if (!text) return [];
    if (text === "cmd:noop") return [];

    const flow = this.flow(threadId);

    if (/^(cancel|stop|never mind|nevermind)$/i.test(text)) {
      this.setFlow(threadId, IDLE);
      return [bot("Done — cancelled.", this.menuOptionsExtra())];
    }

    if (text.startsWith("cmd:")) return this.command(threadId, text.slice(4), flow);

    if (flow.step !== "idle") return this.flowInput(threadId, text, flow);

    return this.natural(threadId, text);
  }

  /* Quick-reply buttons sometimes just speak for the user. */
  private async say(threadId: string, text: string, flow: Flow): Promise<ChatMessage[]> {
    if (flow.step !== "idle") return this.flowInput(threadId, text, flow);
    return this.natural(threadId, text);
  }

  private menuOptionsExtra(): Partial<ChatMessage> {
    return { options: [{ label: "Menu", command: "cmd:menu" }] };
  }

  private command(threadId: string, command: string, flow: Flow): Promise<ChatMessage[]> | ChatMessage[] {
    const [verb, ...rest] = command.split(" ");
    const arg = rest.join(" ").trim();
    switch (verb) {
      case "menu":
        this.setFlow(threadId, IDLE);
        return [this.menuMessage()];
      case "new":
        this.setFlow(threadId, { step: "create-kind" });
        return [
          bot("What kind of ticket?", {
            options: [
              { label: "Onboard a client", command: "cmd:kind onboarding", tone: "primary" },
              { label: "Fault ticket", command: "cmd:kind fault" },
              { label: "Cancel", command: "cmd:menu" },
            ],
          }),
        ];
      case "kind":
        if (arg === "fault") {
          this.setFlow(threadId, { step: "fault-query" });
          return [bot("Who's the client facing the fault? Type a *name* or *phone number* to search.")];
        }
        this.setFlow(threadId, { step: "ob-field", index: 0, draft: {} });
        return [bot("Let's onboard a client. " + ONBOARD_FIELDS[0].ask, { options: this.skipOption(0) })];
      case "tickets":
        return this.listCommand();
      case "update":
      case "assign":
        return this.pickCommand(threadId);
      case "pickticket":
        return this.pickTicket(threadId, arg);
      case "open":
        return [this.openMarker(arg)];
      case "say":
        return this.say(threadId, arg, flow);
      case "claim":
      case "activate":
        return this.simpleAction(threadId, arg, verb);
      case "onboard":
        return this.onboardCommand(threadId, arg);
      case "return":
        return this.returnCommand(threadId, arg);
      case "reassign":
        return this.reassignCommand(threadId, arg);
      case "tech": {
        const [ticketId, techId] = arg.split(/\s+/);
        return this.finishReassign(threadId, ticketId, techId);
      }
      case "faultclient":
        if (flow.step === "fault-pick") {
          const match = flow.matches.find((item) => item.id === arg);
          if (!match) return [errorMsg("Pick a client from the list.")];
          this.setFlow(threadId, { step: "fault-details", clientId: match.id, clientName: match.label });
          return [bot(`Got it — *${match.label}*. What's the fault? Describe it briefly.`)];
        }
        return this.faultClientById(threadId, arg);
      case "router":
        if (flow.step === "svc-router") {
          const router = flow.routers.find((item) => item.id === arg);
          if (!router) return [errorMsg("Pick a router from the list.")];
          return this.pickPackages(threadId, flow.ticketId, router, flow.draft);
        }
        return [errorMsg("That router pick came too late — start the service flow again.")];
      case "pkg":
        if (flow.step === "svc-package") {
          const pkg = flow.packages.find((item) => item.id === arg);
          if (!pkg) return [errorMsg("Pick a package from the list.")];
          const draft = { ...flow.draft, packageId: pkg.id, packageName: pkg.name };
          this.setFlow(threadId, { step: "svc-serial", ticketId: flow.ticketId, draft });
          return [bot(`Package *${pkg.name}* it is. Router *serial number*? (or *skip*)`)];
        }
        return [errorMsg("That package pick came too late — start again.")];
      case "confirmcreate":
        if (flow.step === "ob-confirm") return this.finishCreateOnboarding(threadId, flow.draft);
        if (flow.step === "fault-confirm") return this.finishCreateFault(threadId, flow);
        return [errorMsg("Nothing to confirm right now.")];
      case "confirmsvc":
        if (flow.step === "svc-confirm") return this.finishService(threadId, flow);
        return [errorMsg("Nothing to confirm right now.")];
      case "refresh":
        return this.showTicket(arg);
      default:
        return [bot("Hmm, I didn't catch that.", this.menuOptionsExtra())];
    }
  }

  private openMarker(ticketId: string): ChatMessage {
    // The page watches for kind=notice text "open:<id>" to switch threads.
    return bot(`open:${ticketId}`, { kind: "notice" });
  }

  private skipOption(index: number): ChatOption[] | undefined {
    const field = ONBOARD_FIELDS[index];
    const options: ChatOption[] = [];
    if (field.optional) options.push({ label: "Skip", command: "cmd:say skip" });
    if (field.autoHint) options.push({ label: "Auto", command: "cmd:say auto" });
    return options.length ? options : undefined;
  }

  private async natural(threadId: string, text: string): Promise<ChatMessage[]> {
    const lower = text.toLowerCase();
    // Inside a ticket thread, bare verbs act on that ticket.
    if (threadId.startsWith("ticket:")) {
      const ticketId = threadId.slice("ticket:".length);
      if (/claim|pick up/.test(lower)) return this.simpleAction(threadId, ticketId, "claim");
      if (/activate/.test(lower)) return this.simpleAction(threadId, ticketId, "activate");
      if (/onboard|service|resolve|done|complete|fill/.test(lower)) return this.onboardCommand(threadId, ticketId);
      if (/return/.test(lower)) return this.returnCommand(threadId, ticketId);
      if (/assign|reassign/.test(lower)) return this.reassignCommand(threadId, ticketId);
      if (/refresh|reload|status|update/.test(lower)) return this.showTicket(ticketId);
    }
    if (/^(hi|hello|hey|good\s(morning|afternoon|evening)|start|menu|help|hola)\b/.test(lower)) {
      return [bot("Here's what I can do:"), this.menuMessage()];
    }
    if (/(new|create|add|open|log|raise)\s*(a\s*)?ticket|^new$|onboard a client|report a fault/.test(lower)) {
      return this.command(threadId, "new", IDLE) as ChatMessage[];
    }
    if (/fault|broken|down|not working|no internet/.test(lower) && /(report|log|new|create|add)/.test(lower)) {
      this.setFlow(threadId, { step: "fault-query" });
      return [bot("Who's the client facing the fault? Type a *name* or *phone number* to search.")];
    }
    if (/update|manage|work on|assign|reassign|dispatch/.test(lower)) return this.pickCommand(threadId);
    if (/ticket|status|list|board|summary/.test(lower)) return this.listCommand();
    const refMatch = text.match(/#?([0-9a-fA-F]{6})\b/);
    if (refMatch && /(claim|pick|activate|onboard|resolve|open|show|view|return|assign)/.test(lower)) {
      const tickets = await listTickets().catch(() => []);
      const ticket = tickets.find((item) => ticketRef(item.id) === `#${refMatch[1].toUpperCase()}`);
      if (ticket) {
        if (/claim|pick/.test(lower)) return this.simpleAction(threadId, ticket.id, "claim");
        if (/activate/.test(lower)) return this.simpleAction(threadId, ticket.id, "activate");
        if (/onboard|resolve/.test(lower)) return this.onboardCommand(threadId, ticket.id);
        if (/return/.test(lower)) return this.returnCommand(threadId, ticket.id);
        if (/assign/.test(lower)) return this.reassignCommand(threadId, ticket.id);
        return this.showTicket(ticket.id);
      }
      return [errorMsg(`Couldn't find a ticket with ref *${refMatch[1].toUpperCase()}*.`)];
    }
    return [
      bot(
        "I can help with tickets. Try *new ticket*, *my tickets*, or *update a ticket* — or tap below.",
        { options: this.menuMessage().options },
      ),
    ];
  }

  private async listCommand(): Promise<ChatMessage[]> {
    try {
      const tickets = await listTickets();
      if (tickets.length === 0) {
        return [
          bot("No tickets yet — the board is clean.", {
            options: [{ label: "New ticket", command: "cmd:new", tone: "primary" }],
          }),
        ];
      }
      const counts: Record<string, number> = {};
      for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
      const summary = [
        `*${tickets.length}* ticket${tickets.length === 1 ? "" : "s"} on the board:`,
        `• New: ${counts.new ?? 0}`,
        `• Onboarding: ${counts.onboarding ?? 0}`,
        `• Pending activation: ${counts.pending_activation ?? 0}`,
        `• Completed: ${counts.completed ?? 0}`,
      ].join("\n");
      const open = tickets.filter((item) => item.status !== "completed").slice(0, 5);
      const replies: ChatMessage[] = [bot(summary)];
      for (const ticket of open) replies.push(card(ticket, this.actionsFor(ticket)));
      if (open.length === 0) replies.push(bot("Everything's completed. Nice work."));
      return replies;
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't load tickets.")];
    }
  }

  private async pickCommand(threadId: string): Promise<ChatMessage[]> {
    try {
      const tickets = (await listTickets()).filter((item) => item.status !== "completed");
      if (tickets.length === 0) {
        return [bot("Nothing waiting — all tickets are completed.", this.menuOptionsExtra())];
      }
      this.setFlow(threadId, { step: "pick-ticket", tickets });
      const options = tickets.slice(0, 8).map((ticket) => ({
        label: `${ticketRef(ticket.id)} ${ticketTitle(ticket)} — ${statusLabel(ticket.status)}`,
        command: `cmd:pickticket ${ticket.id}`,
      }));
      options.push({ label: "Cancel", command: "cmd:menu" });
      return [bot("Which ticket?", { options })];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't load tickets.")];
    }
  }

  private async pickTicket(threadId: string, ticketId: string): Promise<ChatMessage[]> {
    this.setFlow(threadId, IDLE);
    return this.showTicket(ticketId);
  }

  private async simpleAction(threadId: string, ticketId: string, action: "claim" | "activate"): Promise<ChatMessage[]> {
    const id = await this.resolveTicketId(threadId, ticketId);
    if (!id) return [errorMsg("Which ticket? Open it first, then try again.")];
    try {
      const updated = await runTicketAction(id, action);
      const done =
        action === "claim"
          ? `Claimed *${ticketRef(updated.id)}* — it's assigned to you now.`
          : `*${ticketRef(updated.id)}* activated — the client is live.`;
      return [bot(done), card(updated, this.actionsFor(updated))];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "That action failed.")];
    }
  }

  private async onboardCommand(threadId: string, ticketId: string): Promise<ChatMessage[]> {
    const id = await this.resolveTicketId(threadId, ticketId);
    if (!id) return [errorMsg("Which ticket? Open it first, then try again.")];
    let ticket: ChatTicket | undefined;
    try {
      ticket = (await listTickets()).find((item) => item.id === id);
    } catch {
      /* fall through to generic error */
    }
    if (!ticket) return [errorMsg("Couldn't load that ticket.")];
    if (ticket.kind === "fault") {
      try {
        const updated = await runTicketAction(id, "onboard");
        return [bot(`*${ticketRef(id)}* resolved — fault closed.`), card(updated, this.actionsFor(updated))];
      } catch (cause) {
        return [errorMsg(cause instanceof Error ? cause.message : "Couldn't resolve that ticket.")];
      }
    }
    try {
      const routers = await listRouters();
      if (routers.length === 0) return [errorMsg("No routers on this account yet — onboard a MikroTik first.")];
      this.setFlow(threadId, {
        step: "svc-router",
        ticketId: id,
        routers,
        draft: { pppoeUsername: ticket.pppoeUsername || ticket.phone.replace(/\D/g, ""), pppoePassword: ticket.pppoePassword },
      });
      return [
        bot(`Service details for *${ticketRef(id)}* — which *router* is the client on?`, {
          options: routers.slice(0, 8).map((router) => ({ label: router.name, command: `cmd:router ${router.id}` })),
        }),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't load routers.")];
    }
  }

  private async pickPackages(
    threadId: string,
    ticketId: string,
    router: RouterOption,
    draft: Partial<ServiceDraft>,
  ): Promise<ChatMessage[]> {
    try {
      const packages = await listPackages(router.id);
      if (packages.length === 0) return [errorMsg(`No packages on *${router.name}*.`)];
      const next = { ...draft, routerId: router.id, routerName: router.name };
      this.setFlow(threadId, { step: "svc-package", ticketId, packages, draft: next });
      return [
        bot(`Router *${router.name}*. Which *package*?`, {
          options: packages.slice(0, 8).map((pkg) => ({
            label: pkg.price ? `${pkg.name} — ${pkg.price}` : pkg.name,
            command: `cmd:pkg ${pkg.id}`,
          })),
        }),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't load packages.")];
    }
  }

  private async returnCommand(threadId: string, ticketId: string): Promise<ChatMessage[]> {
    const id = await this.resolveTicketId(threadId, ticketId);
    if (!id) return [errorMsg("Which ticket? Open it first, then try again.")];
    this.setFlow(threadId, { step: "return-reason", ticketId: id });
    return [bot(`Why are you returning *${ticketRef(id)}*? Give a short reason for the technician.`)];
  }

  private async reassignCommand(threadId: string, ticketId: string): Promise<ChatMessage[]> {
    const id = await this.resolveTicketId(threadId, ticketId);
    if (!id) return [errorMsg("Which ticket? Open it first, then try again.")];
    try {
      const techs = await listTechnicians();
      if (techs.length === 0) return [errorMsg("No active staff to assign to.")];
      this.setFlow(threadId, { step: "reassign-pick", ticketId: id, techs });
      return [
        bot(`Who should take *${ticketRef(id)}*?`, {
          options: techs.slice(0, 8).map((tech) => ({ label: tech.name, command: `cmd:tech ${id} ${tech.id}` })),
        }),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't load the team.")];
    }
  }

  private async finishReassign(threadId: string, ticketId: string, techId: string): Promise<ChatMessage[]> {
    this.setFlow(threadId, IDLE);
    try {
      const updated = await runTicketAction(ticketId, "reassign", { assignedTo: techId });
      return [bot(`*${ticketRef(ticketId)}* reassigned.`), card(updated, this.actionsFor(updated))];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't reassign that ticket.")];
    }
  }

  private async faultClientById(threadId: string, clientId: string): Promise<ChatMessage[]> {
    try {
      const subscribers = await listSubscribers();
      const match = subscribers.find((item) => item.id === clientId);
      if (!match) return [errorMsg("That client is gone — search again.")];
      this.setFlow(threadId, { step: "fault-details", clientId: match.id, clientName: match.label });
      return [bot(`Got it — *${match.label}*. What's the fault? Describe it briefly.`)];
    } catch {
      return [errorMsg("Couldn't load clients.")];
    }
  }

  /* Resolve a ticket id: explicit arg, else the thread's ticket. */
  private async resolveTicketId(threadId: string, arg: string): Promise<string | null> {
    if (arg) return arg;
    if (threadId.startsWith("ticket:")) return threadId.slice("ticket:".length);
    return null;
  }

  /* ---------- wizard text input ---------- */

  private async flowInput(threadId: string, text: string, flow: Flow): Promise<ChatMessage[]> {
    switch (flow.step) {
      case "create-kind":
        return [bot("Tap *Onboard a client* or *Fault ticket* above — or *cancel*.")];
      case "ob-field":
        return this.onboardFieldInput(threadId, text, flow);
      case "fault-query":
        return this.faultQueryInput(threadId, text);
      case "fault-pick": {
        const index = Number.parseInt(text, 10) - 1;
        const match = flow.matches[index];
        if (!match) return [bot("Pick from the list above (tap a name, or type its number).")];
        this.setFlow(threadId, { step: "fault-details", clientId: match.id, clientName: match.label });
        return [bot(`Got it — *${match.label}*. What's the fault? Describe it briefly.`)];
      }
      case "fault-details": {
        if (text.trim().length < 3) return [bot("A bit more detail please (3+ characters).")];
        this.setFlow(threadId, { step: "fault-confirm", clientId: flow.clientId, clientName: flow.clientName, details: text.trim() });
        return [
          bot(
            `*Fault ticket*\nClient: ${flow.clientName}\nFault: ${text.trim()}\n\nCreate it?`,
            {
              options: [
                { label: "Create", command: "cmd:confirmcreate", tone: "primary" },
                { label: "Cancel", command: "cmd:menu" },
              ],
            },
          ),
        ];
      }
      case "pick-ticket": {
        const index = Number.parseInt(text, 10) - 1;
        const ticket = flow.tickets[index];
        if (!ticket) return [bot("Tap a ticket above, or type its number.")];
        return this.pickTicket(threadId, ticket.id);
      }
      case "return-reason": {
        if (text.trim().length < 3) return [bot("Give a slightly longer reason (3+ characters).")];
        this.setFlow(threadId, IDLE);
        try {
          const updated = await runTicketAction(flow.ticketId, "return", { reason: text.trim() });
          return [bot(`*${ticketRef(flow.ticketId)}* returned to the technician.`), card(updated, this.actionsFor(updated))];
        } catch (cause) {
          return [errorMsg(cause instanceof Error ? cause.message : "Couldn't return that ticket.")];
        }
      }
      case "reassign-pick": {
        const index = Number.parseInt(text, 10) - 1;
        const tech = flow.techs[index];
        if (!tech) return [bot("Pick a teammate from the list above.")];
        return this.finishReassign(threadId, flow.ticketId, tech.id);
      }
      case "svc-serial": {
        const serial = /^skip$/i.test(text) ? "" : text.trim().slice(0, 64);
        const draft = { ...flow.draft, serial };
        this.setFlow(threadId, { step: "svc-user", ticketId: flow.ticketId, draft });
        const hint = draft.pppoeUsername ? ` (or *keep* for ${draft.pppoeUsername})` : "";
        return [bot(`*PPPoE username*?${hint}`)];
      }
      case "svc-user": {
        const value = /^keep$/i.test(text) ? (flow.draft.pppoeUsername ?? "") : text.trim();
        if (value.length < 3) return [bot("At least 3 characters for the PPPoE username.")];
        const draft = { ...flow.draft, pppoeUsername: value };
        this.setFlow(threadId, { step: "svc-pass", ticketId: flow.ticketId, draft });
        const hint = draft.pppoePassword ? " (or *keep* for the saved one, *auto* for a fresh one)" : " (or *auto* for a fresh one)";
        return [bot(`*PPPoE password*?${hint}`)];
      }
      case "svc-pass": {
        let value = text.trim();
        if (/^keep$/i.test(text)) value = flow.draft.pppoePassword ?? "";
        if (/^auto$/i.test(text)) value = generatePassword();
        if (value.length < 4) return [bot("At least 4 characters for the PPPoE password.")];
        const draft = { ...flow.draft, pppoePassword: value } as ServiceDraft;
        this.setFlow(threadId, { step: "svc-confirm", ticketId: flow.ticketId, draft });
        return [
          bot(
            `*Submit service details*\nRouter: ${draft.routerName}\nPackage: ${draft.packageName}\nSerial: ${draft.serial || "—"}\nPPPoE: ${draft.pppoeUsername}\n\nSubmit?`,
            {
              options: [
                { label: "Submit", command: "cmd:confirmsvc", tone: "primary" },
                { label: "Cancel", command: "cmd:menu" },
              ],
            },
          ),
        ];
      }
      default:
        this.setFlow(threadId, IDLE);
        return this.natural(threadId, text);
    }
  }

  private async onboardFieldInput(
    threadId: string,
    text: string,
    flow: Extract<Flow, { step: "ob-field" }>,
  ): Promise<ChatMessage[]> {
    const field = ONBOARD_FIELDS[flow.index];
    let value = text.trim();
    if (field.optional && /^skip$/i.test(value)) value = "";
    if (field.autoHint && /^auto$/i.test(value)) {
      value =
        field.key === "pppoeUsername"
          ? (flow.draft.phone ?? "").replace(/\D/g, "")
          : generatePassword();
    }
    if (value) {
      const problem = field.validate(value);
      if (problem) return [bot(`${problem} Try again.`)];
    }
    const draft = { ...flow.draft, [field.key]: value };
    const nextIndex = flow.index + 1;
    if (nextIndex < ONBOARD_FIELDS.length) {
      this.setFlow(threadId, { step: "ob-field", index: nextIndex, draft });
      return [bot(ONBOARD_FIELDS[nextIndex].ask, { options: this.skipOption(nextIndex) })];
    }
    const full = draft as OnboardDraft;
    this.setFlow(threadId, { step: "ob-confirm", draft: full });
    return [
      bot(
        `*New onboarding ticket*\n${full.firstName} ${full.lastName}\n${full.phone} · ${full.email}` +
          `${full.buildingName || full.houseNumber ? `\n${[full.buildingName, full.houseNumber].filter(Boolean).join(", ")}` : ""}` +
          `${full.packageName ? `\nPackage: ${full.packageName}` : ""}\nPPPoE: ${full.pppoeUsername}\n\nCreate it?`,
        {
          options: [
            { label: "Create", command: "cmd:confirmcreate", tone: "primary" },
            { label: "Cancel", command: "cmd:menu" },
          ],
        },
      ),
    ];
  }

  private async faultQueryInput(threadId: string, text: string): Promise<ChatMessage[]> {
    try {
      const subscribers = await listSubscribers();
      const term = text.toLowerCase();
      const matches = subscribers.filter(
        (item) => item.label.toLowerCase().includes(term) || item.phone.toLowerCase().includes(term),
      );
      if (matches.length === 0) {
        return [bot(`No client matching *${text}*. Try another name or phone, or *cancel*.`)];
      }
      const top = matches.slice(0, 6);
      this.setFlow(threadId, { step: "fault-pick", matches: top });
      return [
        bot(
          `${matches.length} match${matches.length === 1 ? "" : "es"} — which one?`,
          {
            options: top.map((item, index) => ({
              label: `${index + 1}. ${item.label}${item.phone ? ` · ${item.phone}` : ""}`,
              command: `cmd:faultclient ${item.id}`,
            })),
          },
        ),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't search clients.")];
    }
  }

  /* ---------- wizard finishers ---------- */

  private async finishCreateOnboarding(threadId: string, draft: OnboardDraft): Promise<ChatMessage[]> {
    this.setFlow(threadId, IDLE);
    try {
      const ticket = await createTicket({ kind: "onboarding", ...draft });
      return [
        bot(`Ticket *${ticketRef(ticket.id)}* created for *${ticketTitle(ticket)}*. A technician can pick it up now.`),
        card(ticket, this.actionsFor(ticket)),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't create the ticket.")];
    }
  }

  private async finishCreateFault(
    threadId: string,
    flow: Extract<Flow, { step: "fault-confirm" }>,
  ): Promise<ChatMessage[]> {
    this.setFlow(threadId, IDLE);
    try {
      const ticket = await createTicket({
        kind: "fault",
        faultClientId: flow.clientId,
        faultClient: flow.clientName,
        faultDetails: flow.details,
      });
      return [
        bot(`Fault ticket *${ticketRef(ticket.id)}* logged for *${flow.clientName}*.`),
        card(ticket, this.actionsFor(ticket)),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't create the ticket.")];
    }
  }

  private async finishService(
    threadId: string,
    flow: Extract<Flow, { step: "svc-confirm" }>,
  ): Promise<ChatMessage[]> {
    this.setFlow(threadId, IDLE);
    try {
      const updated = await runTicketAction(flow.ticketId, "onboard", {
        routerId: flow.draft.routerId,
        packageId: flow.draft.packageId,
        packageName: flow.draft.packageName,
        serial: flow.draft.serial,
        pppoeUsername: flow.draft.pppoeUsername,
        pppoePassword: flow.draft.pppoePassword,
      });
      return [
        bot(`*${ticketRef(flow.ticketId)}* submitted — waiting for activation.`),
        card(updated, this.actionsFor(updated)),
      ];
    } catch (cause) {
      return [errorMsg(cause instanceof Error ? cause.message : "Couldn't submit service details.")];
    }
  }
}

export function newUserMessage(text: string): ChatMessage {
  return { id: msgId(), from: "user", kind: "text", text, time: Date.now() };
}
