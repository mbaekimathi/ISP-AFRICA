const IFACE = /^[A-Za-z0-9_.:-]{1,32}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,32}$/;
const SSID = /^[A-Za-z0-9 _.-]{1,32}$/;
const WINBOX_PASSWORD = /^[A-Za-z0-9@._-]{12,64}$/;

function quotedSecret(value: string, min: number, max: number) {
  if (value.length < min || value.length > max) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126 || character === '"' || character === "\\" || character === "$") return false;
  }
  return true;
}
const HOST = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const CIDR = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\/(?:[1-9]|[12]\d|3[0-2])$/;
const DNS_NAME = /^[A-Za-z0-9.-]{1,64}$/;

export function networkCidr(cidr: string) {
  if (!CIDR.test(cidr)) return "";
  const [address, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const parts = address.split(".").map(Number);
  const value = (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (value & mask) >>> 0;
  const octets = [24, 16, 8, 0].map((shift) => (network >>> shift) & 255);
  return `${octets.join(".")}/${bits}`;
}

function hostValue(host: string) {
  const parts = host.split(".").map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

export function validRange(range: string) {
  const [start, end] = range.split("-");
  if (!start || !end || !HOST.test(start) || !HOST.test(end)) return false;
  return hostValue(start) <= hostValue(end);
}

function script(lines: string[], applicable: boolean, reason = "") {
  return { script: ["{", ...lines, "}"].join("\n"), applicable, reason };
}

export const portUseLabels = {
  wan: "WAN",
  lan: "LAN",
  hotspot: "Hotspot",
  pppoe: "PPPoE",
  static: "Static IP",
  dhcp: "DHCP",
} as const;

export type PortUse = keyof typeof portUseLabels;

const PORT_USES: PortUse[] = ["wan", "lan", "hotspot", "pppoe", "static", "dhcp"];

export const portActivities = PORT_USES;

const ROLE_PORT_USES: Record<string, PortUse[]> = {
  edge: ["wan", "lan"],
  core: ["wan", "lan"],
  site: ["wan", "lan"],
  concentrator: ["pppoe", "hotspot", "static", "dhcp"],
  hotspot: ["hotspot"],
  pppoe: ["pppoe"],
  static: ["static"],
  dhcp: ["dhcp"],
};

export function routerPortUses(role: string): PortUse[] {
  const chosen = new Set<PortUse>();
  for (const item of role.split(",").map((part) => part.trim())) {
    for (const use of ROLE_PORT_USES[item] ?? []) chosen.add(use);
  }
  return PORT_USES.filter((use) => chosen.has(use));
}

export function inferPortUses(comment: string): PortUse[] {
  const parts = comment
    .split(/,|\/|\+|\band\b/i)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return PORT_USES.filter((use) => parts.some((part) => part === use || part === portUseLabels[use].toLowerCase()));
}

export function assignPortRoles(
  ports: { name: string; comment: string; running?: boolean; disabled?: boolean; slave?: boolean }[],
  role: string,
): Record<string, PortUse[]> {
  const sorted = [...ports].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  const assigned: Record<string, PortUse[]> = {};
  for (const port of sorted) {
    const labeled = inferPortUses(port.comment);
    if (labeled.length > 0) assigned[port.name] = labeled;
  }
  const open = sorted.filter((port) => !assigned[port.name] && !port.slave && !port.disabled);
  const requested = routerPortUses(role);
  const customerUses = requested.filter((use) => use === "hotspot" || use === "pppoe" || use === "static");
  const wanName = (open.find((port) => port.running) ?? open[0])?.name;
  if (wanName && (requested.includes("wan") || customerUses.length > 0 || requested.includes("dhcp"))) assigned[wanName] = ["wan"];
  const rest = open.filter((port) => port.name !== wanName);
  const localName = requested.includes("dhcp") ? rest[rest.length - 1]?.name : "";
  const customerPorts = rest.filter((port) => port.name !== localName);
  if (customerUses.length === 1) {
    for (const port of customerPorts) assigned[port.name] = [customerUses[0]];
  } else {
    customerPorts.forEach((port, index) => {
      if (index < customerUses.length) assigned[port.name] = [customerUses[index]];
    });
    if (customerPorts.length > 0 && customerUses.length > customerPorts.length) {
      assigned[customerPorts[customerPorts.length - 1].name] = customerUses.slice(customerPorts.length - 1);
    }
  }
  if (localName) assigned[localName] = ["dhcp"];
  if (requested.includes("lan")) {
    for (const port of sorted) {
      if (!assigned[port.name] && port.slave) assigned[port.name] = ["lan"];
    }
  }
  for (const port of sorted) {
    if (!assigned[port.name]) assigned[port.name] = [];
  }
  return assigned;
}

export function loadPortUses(
  ports: { name: string; comment: string; running?: boolean; disabled?: boolean; slave?: boolean }[],
  plan: Record<string, PortUse[]>,
  role: string,
) {
  const saved: Record<string, boolean> = {};
  const uses: Record<string, PortUse[]> = {};
  let remembered = false;
  for (const port of ports) {
    const labeled = inferPortUses(port.comment);
    const stored = (plan[port.name] ?? []).filter((use) => PORT_USES.includes(use));
    if (labeled.length > 0) {
      uses[port.name] = labeled;
      saved[port.name] = true;
      remembered = true;
    } else if (stored.length > 0) {
      uses[port.name] = stored;
      saved[port.name] = true;
      remembered = true;
    }
  }
  if (!remembered) {
    const suggested = assignPortRoles(ports, role);
    for (const port of ports) saved[port.name] = false;
    return { uses: suggested, saved };
  }
  for (const port of ports) {
    if (!uses[port.name]) uses[port.name] = [];
    if (!saved[port.name]) saved[port.name] = false;
  }
  return { uses, saved };
}

export function isPhysicalPort(item: { name: string; type: string }) {
  if (item.name === "isp-centric") return false;
  if (item.type === "ether") return true;
  return /^(ether|sfp|combo|qsfp)/i.test(item.name);
}

export type DetectedPortSetup = {
  iface: string;
  use: PortUse;
  address: string;
  pool: string;
  localAddress: string;
  range: string;
  service: string;
  dnsName: string;
};

export function portSetupDefaults(iface: string, use: PortUse): Omit<DetectedPortSetup, "iface" | "use"> {
  const index = Math.min(254, Math.max(1, Number(iface.match(/\d+/)?.[0] ?? "1")));
  const useOffset = Math.max(PORT_USES.indexOf(use), 0) + 1;
  const gateway = `10.${index}.${useOffset}.1`;
  const slug = `${use}-${iface}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || use;
  const base = {
    address: `${gateway}/24`,
    pool: `${slug}-pool`.slice(0, 32),
    localAddress: gateway,
    range: `10.${index}.${useOffset}.2-10.${index}.${useOffset}.254`,
    service: slug,
    dnsName: `${slug}.local`.slice(0, 64),
  };
  if (use === "wan") return { ...base, address: "", pool: "", localAddress: "", range: "", service: "", dnsName: "" };
  if (use === "static" || use === "lan") return { ...base, pool: "", localAddress: "", range: "", service: "", dnsName: "" };
  return base;
}

function rangeBounds(range: string) {
  if (!validRange(range)) return null;
  const [start, end] = range.split("-");
  return [hostValue(start), hostValue(end)] as const;
}

function rangesOverlap(left: string, right: string) {
  const first = rangeBounds(left);
  const second = rangeBounds(right);
  if (!first || !second) return false;
  return first[0] <= second[1] && second[0] <= first[1];
}

function hostInRange(host: string, range: string) {
  const bounds = rangeBounds(range);
  if (!HOST.test(host) || !bounds) return false;
  const value = hostValue(host);
  return value >= bounds[0] && value <= bounds[1];
}

export function buildDetectedPortsScript(assignments: DetectedPortSetup[]) {
  if (assignments.length === 0) {
    return script([':error "Choose what at least one port will do. No changes were made.";'], false, "Choose what at least one port will do.");
  }
  const lines = [
    "# ISP CENTRIC port setup. Paste once into WinBox Terminal.",
    ":local ros [/system resource get version];",
    ':if ([:pick $ros 0 1] != "7") do={ :error "RouterOS 7 is required. No changes were made." };',
  ];
  const grouped = new Map<string, DetectedPortSetup[]>();
  for (const item of assignments) {
    const iface = IFACE.test(item.iface) ? item.iface : "";
    if (!iface || !PORT_USES.includes(item.use)) {
      return script([':error "Choose an interface that exists on this router. No changes were made.";'], false, "Choose an interface.");
    }
    const current = grouped.get(iface) ?? [];
    if (!current.some((entry) => entry.use === item.use)) current.push({ ...item, iface });
    grouped.set(iface, current);
  }
    lines.push(':local target "";');
  for (const [iface, items] of grouped) {
    const labels = PORT_USES.filter((use) => items.some((item) => item.use === use)).map((use) => portUseLabels[use]);
    const hotspot = items.find((item) => item.use === "hotspot");
    const pppoe = items.find((item) => item.use === "pppoe");
    const dhcp = items.find((item) => item.use === "dhcp");
    if (hotspot && pppoe && (rangesOverlap(hotspot.range, pppoe.range) || hostInRange(pppoe.localAddress, hotspot.range))) {
      return script(
        [':error "PPPoE addresses overlap the hotspot range. No changes were made.";'],
        false,
        "PPPoE addresses overlap the hotspot range.",
      );
    }
    if (hotspot && dhcp && (rangesOverlap(hotspot.range, dhcp.range) || networkCidr(hotspot.address) === networkCidr(dhcp.address))) {
      return script(
        [':error "The local DHCP network overlaps the hotspot. No changes were made.";'],
        false,
        "The local DHCP network overlaps the hotspot.",
      );
    }
    lines.push(`:if ([:len [/interface find where name="${iface}"]] = 0) do={ :error "That interface was not found. No changes were made." };`);
    lines.push(`:set target "${iface}";`);
    lines.push(`:do { :if ([:len [/interface bridge port find where interface="${iface}"]] > 0) do={ :set target [/interface bridge port get [find where interface="${iface}"] bridge] } } on-error={};`);
    lines.push(`/interface set [find where name="${iface}"] comment="${labels.join(", ")}";`);
    for (const item of items) {
      if (item.use === "wan") {
        lines.push(`:if ([:len [/ip dhcp-client find where interface=$target]] = 0) do={ /ip dhcp-client add interface=$target add-default-route=yes use-peer-dns=yes disabled=no comment=isp-centric-wan };`);
        continue;
      }
      if (item.use === "static" || item.use === "lan") {
        const address = CIDR.test(item.address) ? item.address : "";
        const label = item.use === "lan" ? "LAN address" : "static gateway";
        if (!address) return script([`:error "Enter a ${label} for ${iface}. No changes were made.";`], false, `Enter a ${label} for ${iface}.`);
        if (hotspot && networkCidr(address) === networkCidr(hotspot.address) && address !== hotspot.address) {
          return script(
            [':error "The static gateway must match the hotspot gateway or use another subnet. No changes were made.";'],
            false,
            "The static gateway must match the hotspot gateway or use another subnet.",
          );
        }
        if (hotspot && address === hotspot.address) continue;
        const comment = item.use === "lan" ? "isp-centric-lan" : "isp-centric-static";
        lines.push(`:if ([:len [/ip address find where address="${address}"]] = 0) do={ /ip address add address=${address} interface=$target comment=${comment} };`);
        continue;
      }
      if (item.use === "dhcp") {
        const address = CIDR.test(item.address) ? item.address : "";
        const gateway = address.split("/")[0] ?? "";
        const network = address ? networkCidr(address) : "";
        const pool = TOKEN.test(item.pool) ? item.pool : "";
        const range = validRange(item.range) ? item.range : "";
        if (!address || !pool || !range) {
          return script([`:error "Enter the DHCP gateway, pool, and range for ${iface}. No changes were made.";`], false, `Enter the DHCP gateway, pool, and range for ${iface}.`);
        }
        lines.push(`:if ([:len [/ip pool find where name="${pool}"]] = 0) do={ /ip pool add name=${pool} ranges=${range} };`);
        lines.push(`:if ([:len [/ip address find where address="${address}"]] = 0) do={ /ip address add address=${address} interface=$target comment=isp-centric-dhcp };`);
        lines.push(`:if ([:len [/ip dhcp-server find where interface=$target]] = 0) do={ /ip dhcp-server add name=${pool} interface=$target address-pool=${pool} disabled=no };`);
        lines.push(`:if ([:len [/ip dhcp-server network find where address="${network}"]] = 0) do={ /ip dhcp-server network add address=${network} gateway=${gateway} dns-server=${gateway} };`);
        continue;
      }
      if (item.use === "pppoe") {
        const service = TOKEN.test(item.service) ? item.service : "";
        const pool = TOKEN.test(item.pool) ? item.pool : "";
        const localAddress = HOST.test(item.localAddress) ? item.localAddress : "";
        const range = validRange(item.range) ? item.range : "";
        if (!service || !pool || !localAddress || !range) {
          return script([`:error "Enter the PPPoE service, pool, local address, and range for ${iface}. No changes were made.";`], false, `Enter the PPPoE service, pool, local address, and range for ${iface}.`);
        }
        const hotspotGateway = hotspot?.address.split("/")[0] ?? "";
        lines.push(`:if ([:len [/ip pool find where name="${pool}"]] = 0) do={ /ip pool add name=${pool} ranges=${range} };`);
        if (localAddress !== hotspotGateway) {
          lines.push(`:if ([:len [/ip address find where address="${localAddress}/32" or address="${localAddress}/24"]] = 0) do={ /ip address add address=${localAddress}/32 interface=$target comment=isp-centric-pppoe };`);
        }
        lines.push(`:if ([:len [/ppp profile find where name="${pool}-profile"]] = 0) do={ /ppp profile add name=${pool}-profile local-address=${localAddress} remote-address=${pool} only-one=yes };`);
        lines.push(`:if ([:len [/interface pppoe-server server find where service-name="${service}"]] = 0) do={ /interface pppoe-server server add service-name=${service} interface=$target default-profile=${pool}-profile disabled=no };`);
        continue;
      }
      const hotspotName = TOKEN.test(item.service) ? item.service : "";
      const address = CIDR.test(item.address) ? item.address : "";
      const gateway = address.split("/")[0] ?? "";
      const network = address ? networkCidr(address) : "";
      const pool = TOKEN.test(item.pool) ? item.pool : "";
      const range = validRange(item.range) ? item.range : "";
      const dnsName = DNS_NAME.test(item.dnsName) ? item.dnsName : "";
      if (!hotspotName || !address || !pool || !range || !dnsName) {
        return script([`:error "Enter the hotspot name, gateway, pool, range, and DNS name for ${iface}. No changes were made.";`], false, `Enter the hotspot name, gateway, pool, range, and DNS name for ${iface}.`);
      }
      lines.push(`:if ([:len [/ip pool find where name="${pool}"]] = 0) do={ /ip pool add name=${pool} ranges=${range} };`);
      lines.push(`:if ([:len [/ip address find where address="${address}"]] = 0) do={ /ip address add address=${address} interface=$target comment=isp-centric-hotspot };`);
      lines.push(`:if ([:len [/ip hotspot profile find where name="${hotspotName}-profile"]] = 0) do={ /ip hotspot profile add name=${hotspotName}-profile hotspot-address=${gateway} dns-name=${dnsName} };`);
      lines.push(`:if ([:len [/ip hotspot find where interface=$target]] = 0) do={ /ip hotspot add name=${hotspotName} interface=$target address-pool=${pool} profile=${hotspotName}-profile disabled=no };`);
      lines.push(`:if ([:len [/ip dhcp-server find where interface=$target]] = 0) do={ /ip dhcp-server add name=${hotspotName}-dhcp interface=$target address-pool=${pool} disabled=no };`);
      lines.push(`:if ([:len [/ip dhcp-server network find where address="${network}"]] = 0) do={ /ip dhcp-server network add address=${network} gateway=${gateway} dns-server=${gateway} };`);
    }
  }
  return script(lines, true);
}

export function buildPortScript(input: { iface: string; role: "wan" | "lan"; address: string }) {
  const iface = IFACE.test(input.iface) ? input.iface : "";
  const address = input.role === "lan" && CIDR.test(input.address) ? input.address : "";
  if (!iface) return script([':error "Choose an interface that exists on this router. No changes were made.";'], false, "Choose an interface.");
  if (input.role === "lan" && !address) return script([':error "Enter a LAN address such as 192.168.88.1/24. No changes were made.";'], false, "Enter a LAN address.");
  const lines = [
    "# ISP CENTRIC port setup. Paste once into WinBox Terminal.",
    `:if ([:len [/interface find where name="${iface}"]] = 0) do={ :error "That interface was not found. No changes were made." };`,
  ];
  if (input.role === "wan") {
    lines.push(
      `:if ([:len [/ip dhcp-client find where interface="${iface}"]] = 0) do={ /ip dhcp-client add interface=${iface} add-default-route=yes use-peer-dns=yes disabled=no comment=isp-centric-wan };`,
    );
  } else {
    lines.push(
      `:if ([:len [/ip address find where interface="${iface}" and address="${address}"]] = 0) do={ /ip address add address=${address} interface=${iface} comment=isp-centric-lan };`,
    );
  }
  return script(lines, true);
}

export function buildPppoeScript(input: { iface: string; service: string; pool: string; localAddress: string; range: string; enforced: boolean }) {
  const iface = IFACE.test(input.iface) ? input.iface : "";
  const service = TOKEN.test(input.service) ? input.service : "";
  const pool = TOKEN.test(input.pool) ? input.pool : "";
  const localAddress = HOST.test(input.localAddress) ? input.localAddress : "";
  const range = validRange(input.range) ? input.range : "";
  const address = localAddress ? `${localAddress}/24` : "";
  const gatewayOk = CIDR.test(address);
  const network = gatewayOk ? networkCidr(address) : "";
  const problems = [
    iface ? "" : "Choose the PPPoE interface.",
    service ? "" : "Enter a PPPoE service name.",
    pool ? "" : "Enter a pool name.",
    localAddress ? "" : "Enter the PPPoE local address.",
    range ? "" : "Enter a client address range.",
    gatewayOk ? "" : "Enter a PPPoE local address such as 10.10.0.1.",
  ].filter(Boolean);
  if (problems.length) return script([`:error "${problems[0]} No changes were made.";`], false, problems[0]);
  const lines = [
    "# ISP CENTRIC PPPoE setup. Paste once into WinBox Terminal.",
    ":local ros [/system resource get version];",
    ':if ([:pick $ros 0 1] != "7") do={ :error "RouterOS 7 is required. No changes were made." };',
    `:if ([:len [/interface find where name="${iface}"]] = 0) do={ :error "That interface was not found. No changes were made." };`,
    `:if ([:len [/ip pool find where name="${pool}"]] = 0) do={ /ip pool add name=${pool} ranges=${range} };`,
  ];
  if (input.enforced) {
    lines.push(
      `:if ([:len [/ppp profile find where name="${pool}-profile"]] = 0) do={ /ppp profile add name=${pool}-profile local-address=${localAddress} remote-address=${pool} only-one=yes };`,
      `:if ([:len [/interface pppoe-server server find where service-name="${service}"]] = 0) do={ /interface pppoe-server server add service-name=${service} interface=${iface} default-profile=${pool}-profile disabled=no } else={ /interface pppoe-server server set [find where service-name="${service}"] disabled=no };`,
      `/ip firewall filter remove [find where comment="isp-centric-pppoe-allow"];`,
      `/ip firewall filter remove [find where comment="isp-centric-pppoe-suspended"];`,
      `/ip firewall filter remove [find where comment="isp-centric-pppoe-drop-ppp"];`,
      `/ip firewall filter remove [find where comment="isp-centric-pppoe-drop"];`,
      ':local fwdAnchor ""; :do { :set fwdAnchor [:pick [/ip firewall filter find where chain=forward] 0] } on-error={};',
      `:do { /ip firewall filter add chain=forward action=drop in-interface=${iface} comment=isp-centric-pppoe-drop place-before=$fwdAnchor } on-error={ /ip firewall filter add chain=forward action=drop in-interface=${iface} comment=isp-centric-pppoe-drop };`,
      `:do { /ip firewall filter add chain=forward action=drop in-interface=all-ppp comment=isp-centric-pppoe-drop-ppp place-before=$fwdAnchor } on-error={ /ip firewall filter add chain=forward action=drop in-interface=all-ppp comment=isp-centric-pppoe-drop-ppp };`,
      `:do { /ip firewall filter add chain=forward action=drop src-address-list=pppoe-suspended comment=isp-centric-pppoe-suspended place-before=$fwdAnchor } on-error={ /ip firewall filter add chain=forward action=drop src-address-list=pppoe-suspended comment=isp-centric-pppoe-suspended };`,
      `:do { /ip firewall filter add chain=forward action=accept src-address-list=pppoe-subscribed comment=isp-centric-pppoe-allow place-before=$fwdAnchor } on-error={ /ip firewall filter add chain=forward action=accept src-address-list=pppoe-subscribed comment=isp-centric-pppoe-allow };`,
      `:if ([:len [/ip dhcp-server find where interface="${iface}"]] > 0) do={ /ip dhcp-server set [find where interface="${iface}"] disabled=yes };`,
    );
  } else {
    lines.push(
      `:if ([:len [/interface pppoe-server server find where service-name="${service}"]] > 0) do={ /interface pppoe-server server set [find where service-name="${service}"] disabled=yes };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-pppoe-allow"]] > 0) do={ /ip firewall filter remove [find where comment="isp-centric-pppoe-allow"] };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-pppoe-suspended"]] > 0) do={ /ip firewall filter remove [find where comment="isp-centric-pppoe-suspended"] };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-pppoe-drop-ppp"]] > 0) do={ /ip firewall filter remove [find where comment="isp-centric-pppoe-drop-ppp"] };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-pppoe-drop"]] > 0) do={ /ip firewall filter remove [find where comment="isp-centric-pppoe-drop"] };`,
      `:if ([:len [/ip address find where interface="${iface}" and address="${address}"]] = 0) do={ /ip address add address=${address} interface=${iface} comment=isp-centric-dhcp };`,
      `:if ([:len [/ip dhcp-server find where name="${pool}"]] = 0) do={ /ip dhcp-server add name=${pool} interface=${iface} address-pool=${pool} disabled=no } else={ /ip dhcp-server set [find where name="${pool}"] disabled=no };`,
      `:if ([:len [/ip dhcp-server network find where address="${network}"]] = 0) do={ /ip dhcp-server network add address=${network} gateway=${localAddress} dns-server=${localAddress} };`,
    );
  }
  return script(lines, true);
}

export function buildHotspotScript(input: { iface: string; hotspot: string; address: string; pool: string; range: string; dnsName: string; enabled: boolean }) {
  const iface = IFACE.test(input.iface) ? input.iface : "";
  const hotspot = TOKEN.test(input.hotspot) ? input.hotspot : "";
  const address = CIDR.test(input.address) ? input.address : "";
  const gateway = address.split("/")[0] ?? "";
  const network = address ? networkCidr(address) : "";
  const pool = TOKEN.test(input.pool) ? input.pool : "";
  const range = validRange(input.range) ? input.range : "";
  const dnsName = DNS_NAME.test(input.dnsName) ? input.dnsName : "";
  const problems = [
    iface ? "" : "Choose the hotspot interface.",
    hotspot ? "" : "Enter a hotspot name.",
    address ? "" : "Enter the hotspot gateway address.",
    pool ? "" : "Enter a pool name.",
    range ? "" : "Enter a client address range.",
    dnsName ? "" : "Enter a hotspot DNS name.",
  ].filter(Boolean);
  if (problems.length) return script([`:error "${problems[0]} No changes were made.";`], false, problems[0]);
  const lines = [
    "# ISP CENTRIC hotspot setup. Paste once into WinBox Terminal.",
    ":local ros [/system resource get version];",
    ':if ([:pick $ros 0 1] != "7") do={ :error "RouterOS 7 is required. No changes were made." };',
    `:if ([:len [/interface find where name="${iface}"]] = 0) do={ :error "That interface was not found. No changes were made." };`,
  ];
  if (input.enabled) {
    lines.push(
      `:if ([:len [/ip pool find where name="${pool}"]] = 0) do={ /ip pool add name=${pool} ranges=${range} };`,
      `:if ([:len [/ip address find where interface="${iface}" and address="${address}"]] = 0) do={ /ip address add address=${address} interface=${iface} comment=isp-centric-hotspot };`,
      `:if ([:len [/ip hotspot profile find where name="${hotspot}-profile"]] = 0) do={ /ip hotspot profile add name=${hotspot}-profile hotspot-address=${gateway} dns-name=${dnsName} };`,
      `:if ([:len [/ip hotspot find where name="${hotspot}"]] = 0) do={ /ip hotspot add name=${hotspot} interface=${iface} address-pool=${pool} profile=${hotspot}-profile disabled=no } else={ /ip hotspot set [find where name="${hotspot}"] disabled=no };`,
      `:if ([:len [/ip dhcp-server find where name="${hotspot}-dhcp"]] = 0) do={ /ip dhcp-server add name=${hotspot}-dhcp interface=${iface} address-pool=${pool} disabled=no } else={ /ip dhcp-server set [find where name="${hotspot}-dhcp"] disabled=no };`,
      `:if ([:len [/ip dhcp-server network find where address="${network}"]] = 0) do={ /ip dhcp-server network add address=${network} gateway=${gateway} dns-server=${gateway} };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-hotspot-block"]] > 0) do={ /ip firewall filter remove [find where comment="isp-centric-hotspot-block"] };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-hotspot-block-input"]] > 0) do={ /ip firewall filter remove [find where comment="isp-centric-hotspot-block-input"] };`,
    );
  } else {
    lines.push(
      `:if ([:len [/ip hotspot find where name="${hotspot}"]] > 0) do={ /ip hotspot set [find where name="${hotspot}"] disabled=yes };`,
      `:if ([:len [/ip dhcp-server find where name="${hotspot}-dhcp"]] > 0) do={ /ip dhcp-server set [find where name="${hotspot}-dhcp"] disabled=yes };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-hotspot-block"]] = 0) do={ /ip firewall filter add chain=forward action=drop in-interface=${iface} comment=isp-centric-hotspot-block };`,
      `:if ([:len [/ip firewall filter find where comment="isp-centric-hotspot-block-input"]] = 0) do={ /ip firewall filter add chain=input action=drop in-interface=${iface} comment=isp-centric-hotspot-block-input };`,
    );
  }
  return script(lines, true);
}

export type SetupWifi = {
  name: string;
  ssid: string;
  password: string;
  kind: "wifi" | "wireless";
  security: string;
  enabled: boolean;
};

export type SetupWinboxUser = {
  currentName: string;
  name: string;
  password: string;
};

export function buildMikrotikSetupScript(input: { identity: string; dns?: string; wifi?: SetupWifi[]; winboxUser?: SetupWinboxUser }) {
  const identity = input.identity.replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 64).trim();
  const servers = (input.dns ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => HOST.test(item));
  if (input.identity.trim() && !identity) return script([':error "Enter a router name. No changes were made.";'], false, "Enter a router name.");
  if ((input.dns ?? "").trim() && servers.length === 0) return script([':error "Enter at least one DNS server. No changes were made.";'], false, "Enter at least one DNS server.");
  const lines = ["# ISP CENTRIC router setup. Paste once into WinBox Terminal."];
  if (identity) lines.push(`/system identity set name="${identity}";`);
  if (servers.length > 0) {
    lines.push(`/ip dns set servers=${servers.join(",")} allow-remote-requests=no;`);
    lines.push("/system ntp client set enabled=yes;");
    lines.push(':if ([:len [/system ntp client servers find where address="time.cloudflare.com"]] = 0) do={ /system ntp client servers add address=time.cloudflare.com };');
  }
  for (const radio of input.wifi ?? []) {
    if (!radio.enabled) continue;
    if (!IFACE.test(radio.name)) return script([':error "A WiFi interface name from this router is required. No changes were made.";'], false, "A WiFi interface name from this router is required.");
    const ssid = radio.ssid.trim();
    if (!ssid) continue;
    if (!SSID.test(ssid)) return script([':error "Enter a WiFi name using letters, numbers, spaces, dots, or dashes. No changes were made.";'], false, "Enter a WiFi name using letters, numbers, spaces, dots, or dashes.");
    if (radio.password && !quotedSecret(radio.password, 8, 63)) {
      return script([':error "Enter a WiFi password of 8 to 63 characters without quotes. No changes were made.";'], false, "Enter a WiFi password of 8 to 63 characters without quotes.");
    }
    if (radio.password && !TOKEN.test(radio.security)) {
      return script([':error "This WiFi has no security profile, so the password cannot be changed. No changes were made.";'], false, "This WiFi has no security profile, so the password cannot be changed.");
    }
    if (radio.kind === "wireless") {
      lines.push(`/interface wireless set [find where name="${radio.name}"] ssid="${ssid}" disabled=no;`);
      if (radio.password) lines.push(`/interface wireless security-profiles set [find where name="${radio.security}"] wpa2-pre-shared-key="${radio.password}";`);
    } else {
      lines.push(`/interface wifi set [find where name="${radio.name}"] configuration.ssid="${ssid}" disabled=no;`);
      if (radio.password) lines.push(`/interface wifi security set [find where name="${radio.security}"] passphrase="${radio.password}";`);
    }
  }
  const winbox = input.winboxUser;
  if (winbox && (winbox.name !== winbox.currentName || winbox.password)) {
    if (winbox.currentName !== "isp-centric" || winbox.name !== "isp-centric") {
      return script([':error "Only the registered isp-centric password can be changed. No changes were made.";'], false, "Only the registered isp-centric password can be changed.");
    }
    if (!WINBOX_PASSWORD.test(winbox.password)) {
      return script([':error "Enter a Winbox password of 12 to 64 letters, numbers, or @ . _ -. No changes were made.";'], false, "Enter a Winbox password of 12 to 64 letters, numbers, or @ . _ -.");
    }
    lines.push(`/user set [find where name="isp-centric"] password="${winbox.password}";`);
  }
  if (lines.length === 1) return script([':error "No registered details were changed. No changes were made.";'], false, "No registered details were changed.");
  return script(lines, true);
}

export function buildRecoveryScripts(input: { backup: string; password: string }) {
  const backup = TOKEN.test(input.backup) || /^isp-[A-Za-z0-9_-]{1,12}$/.test(input.backup) ? input.backup : "";
  const password = /^[A-Za-z0-9@._-]{12,64}$/.test(input.password) ? input.password : "";
  const restore = backup
    ? script(
        [
          "# Restores the backup saved during onboarding and reboots this router.",
          `/system backup load name=${backup};`,
        ],
        true,
      )
    : script([':error "The backup name is not valid. No changes were made.";'], false, "The backup name is not valid.");
  const access = password
    ? script(
        [
          "# Recreates the API user that can change PPPoE enforcement, and allows WinBox only from the management tunnel.",
          ':if ([:len [/user group find where name="isp-centric-api"]] = 0) do={ /user group add name=isp-centric-api policy=read,write,api,winbox,test } else={ /user group set [find where name="isp-centric-api"] policy=read,write,api,winbox,test };',
          `:if ([:len [/user find where name="isp-centric"]] = 0) do={ /user add name=isp-centric group=isp-centric-api password="${password}" } else={ /user set [find where name="isp-centric"] group=isp-centric-api password="${password}" };`,
          "/ip service set winbox disabled=no;",
          ':local inAnchor ""; :do { :set inAnchor [:pick [/ip firewall filter find where chain=input action=drop] 0] } on-error={};',
          ':if ([:len [/ip firewall filter find where comment="isp-centric-winbox"]] = 0) do={ :do { /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8291 in-interface=isp-centric comment=isp-centric-winbox place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8291 in-interface=isp-centric comment=isp-centric-winbox } };',
        ],
        true,
      )
    : script([':error "Enter the API password from onboarding. No changes were made.";'], false, "Enter the API password from onboarding.");
  return { restore, access };
}
