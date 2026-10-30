export type ScriptDevice = {
  name: string;
  tunnelIp: string;
  privateKey?: string;
  publicKey?: string;
  serverTunnelIp: string;
  endpoint: string;
  endpointPort: number;
  serverPublicKey: string;
};

const KEY = /^[A-Za-z0-9+/]{43}=$/;
const ENDPOINT = /^[A-Za-z0-9.:-]{1,253}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function ipOctets(ip: string) {
  if (!IPV4.test(ip)) return null;
  const octets = ip.split(".").map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

export function backupName(name: string) {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "router";
  return `isp-${safe}`;
}

export function buildWinboxScript(device: ScriptDevice, apiPassword: string) {
  const backup = backupName(device.name);
  const privateKey = device.privateKey && KEY.test(device.privateKey) ? device.privateKey : "";
  const serverKey = KEY.test(device.serverPublicKey) ? device.serverPublicKey : "";
  const endpoint = ENDPOINT.test(device.endpoint) ? device.endpoint : "";
  const password = /^[A-Za-z0-9]{12,64}$/.test(apiPassword) ? apiPassword : "";
  const serverOctets = ipOctets(device.serverTunnelIp);
  const tunnelPrefix = serverOctets ? serverOctets.slice(0, 3).join(".") : "";
  const tunnelNetwork = tunnelPrefix ? `${tunnelPrefix}.0/24` : "";
  const tunnelOctets = ipOctets(device.tunnelIp);
  const tunnelIp =
    tunnelOctets &&
    tunnelOctets.slice(0, 3).join(".") === tunnelPrefix &&
    tunnelOctets[3] >= 2 &&
    tunnelOctets[3] <= 254
      ? device.tunnelIp
      : "";
  const port = Number.isInteger(device.endpointPort) && device.endpointPort > 0 && device.endpointPort < 65536 ? device.endpointPort : 0;
  const serverTunnel = serverOctets && serverOctets[3] === 1 ? device.serverTunnelIp : "";
  const vpsRequested = Boolean(device.serverPublicKey.trim() || device.endpoint.trim());
  const problems = [
    privateKey ? "" : "This router key is missing.",
    password ? "" : "The API password could not be prepared.",
    tunnelIp ? "" : "The tunnel address is not valid.",
    ...(vpsRequested
      ? [
          serverKey ? "" : "The VPS public key is not set.",
          endpoint ? "" : "The VPS endpoint is not set.",
          serverTunnel ? "" : "The VPS tunnel address is not valid.",
          port ? "" : "The tunnel port is not valid.",
        ]
      : []),
  ].filter(Boolean);
  const applicable = problems.length === 0;
  const local = applicable && !vpsRequested;
  const routerKey = device.publicKey && KEY.test(device.publicKey) ? device.publicKey : "";
  const endpointIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(endpoint) ? endpoint : "";
  const commentName = device.name.replace(/[^A-Za-z0-9 _.-]/g, "").slice(0, 80) || "router";
  const lines = [
    `# ISP CENTRIC tunnel for ${commentName}. Paste into WinBox Terminal. Safe to re-run.`,
    "# Re-running replaces only the isp-centric tunnel. Subscriber ports, bridges, and hotspot clients stay.",
    local
      ? "# The VPS peer is omitted until the VPS public key and endpoint are set."
      : "# The router connects out. API is limited to the tunnel and private LAN, not the public internet.",
    `# Restore with: /system backup load name=${backup}`,
    "{",
    ':put "[ISP CENTRIC] Starting tunnel install";',
    ":local ros [/system resource get version];",
    ":local board [/system resource get board-name];",
    ":local arch [/system resource get architecture-name];",
    ':put ("[ISP CENTRIC] Detected " . $board . ", " . $arch . ", RouterOS " . $ros);',
    ':if ([:pick $ros 0 1] != "7") do={ :error "RouterOS 7 is required for WireGuard. No changes were made." };',
    ':foreach pkg in=[/system package find where name="wireguard"] do={ :if ([/system package get $pkg disabled] = true) do={ :error "WireGuard is disabled on this router. Enable it, reboot, then paste this script again. No tunnel was added." } };',
    ':local tunnelKind "";',
    ':do { :set tunnelKind [:typeof [/interface wireguard find]] } on-error={ :set tunnelKind "missing" };',
    ':if ($tunnelKind = "missing") do={ :error "WireGuard is not available on this router. No changes were made." };',
  ];
  if (!applicable) {
    lines.push(`:error "${problems[0]} No changes were made.";`);
  } else {
    lines.push(
      `/system backup save name=${backup};`,
      ':put "[ISP CENTRIC OK] Backup saved before changes";',
      ':put "[ISP CENTRIC] Step 1/8 cleanup";',
      ':do { /system script remove [find where name="isp-centric-watch"] } on-error={};',
      ':do { /system scheduler remove [find where name="isp-centric-watch"] } on-error={};',
      '/ip firewall filter remove [find where comment="isp-centric-management"];',
      '/ip firewall filter remove [find where comment="isp-centric-api"];',
      '/ip firewall filter remove [find where comment="isp-centric-api-lan"];',
      '/ip firewall filter remove [find where comment="isp-centric-api-net"];',
      '/ip firewall filter remove [find where comment="isp-centric-icmp"];',
      '/ip firewall filter remove [find where comment="isp-centric-coa"];',
      '/ip firewall filter remove [find where comment="isp-centric-api-before-drop"];',
      '/ip firewall filter remove [find where comment="isp-centric-wg-udp"];',
      '/ip firewall nat remove [find where comment="isp-centric-no-nat"];',
      ':do { /ip hotspot ip-binding remove [find where comment="isp-centric-hotspot-bypass"] } on-error={};',
      "/interface wireguard peers remove [find where interface=isp-centric];",
      "/ip address remove [find where interface=isp-centric];",
      "/interface wireguard remove [find where name=isp-centric];",
      ':put "[ISP CENTRIC OK] Previous isp-centric tunnel removed";',
      ':local inAnchor ""; :do { :set inAnchor [:pick [/ip firewall filter find where chain=input action=drop] 0] } on-error={};',
      ':local outAnchor ""; :do { :set outAnchor [:pick [/ip firewall filter find where chain=output action=drop] 0] } on-error={};',
      ':local natAnchor ""; :do { :set natAnchor [:pick [/ip firewall nat find where chain=srcnat] 0] } on-error={};',
      ':put "[ISP CENTRIC] Step 2/8 management";',
      ':if ([:len [/user group find where name="isp-centric-api"]] = 0) do={ /user group add name=isp-centric-api policy=read,write,api,test,ftp,reboot } else={ /user group set [find where name="isp-centric-api"] policy=read,write,api,test,ftp,reboot };',
      `:if ([:len [/user find where name="isp-centric"]] = 0) do={ /user add name=isp-centric group=isp-centric-api password="${password}" } else={ /user set [find where name="isp-centric"] group=isp-centric-api password="${password}" };`,
      ':do { /ip service set [find where name="api"] disabled=no port=8728 address=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16 } on-error={:put "[ISP CENTRIC FAIL] Could not enable the API service"};',
      ':if ([:len [/ip service find where name="api" and disabled=no and port=8728]] > 0) do={:put "[ISP CENTRIC OK] API enabled on port 8728 for private addresses"} else={:put "[ISP CENTRIC FAIL] API is still disabled"};',
      ':do { /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=10.0.0.0/8 comment=isp-centric-api-lan place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=10.0.0.0/8 comment=isp-centric-api-lan };',
      ':do { /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=172.16.0.0/12 comment=isp-centric-api-lan place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=172.16.0.0/12 comment=isp-centric-api-lan };',
      ':do { /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=192.168.0.0/16 comment=isp-centric-api-lan place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=192.168.0.0/16 comment=isp-centric-api-lan };',
      ':put "[ISP CENTRIC] Step 3/8 wireguard";',
      `:do { /interface wireguard add name=isp-centric private-key="${privateKey}" comment="isp-centric management" ; :put "[ISP CENTRIC OK] Interface created" } on-error={:put "[ISP CENTRIC FAIL] Could not create isp-centric"};`,
      `:do { /ip address add address=${tunnelIp}/24 interface=isp-centric comment="isp-centric management" ; :put "[ISP CENTRIC OK] Tunnel address ${tunnelIp}/24 assigned" } on-error={:put "[ISP CENTRIC FAIL] Could not assign the tunnel address"};`,
      ...(local
        ? [':put "[ISP CENTRIC] The VPS peer is omitted until the VPS public key and endpoint are set";']
        : [
            `:do { /interface wireguard peers add interface=isp-centric public-key="${serverKey}" endpoint-address="${endpoint}" endpoint-port=${port} allowed-address=${serverTunnel}/32 persistent-keepalive=25s comment="isp-centric server" ; :put "[ISP CENTRIC OK] Server peer set toward ${endpoint}:${port}" } on-error={:put "[ISP CENTRIC FAIL] Could not add the server peer"};`,
            ':if ([:len [/interface wireguard peers find where interface=isp-centric]] > 0) do={:put "[ISP CENTRIC OK] Server peer exists"} else={:put "[ISP CENTRIC FAIL] Server peer is missing"};',
          ]),
      ...(routerKey
        ? [
            `:do { :local gotR [/interface wireguard get [find where name="isp-centric"] public-key] ; :if ($gotR = "${routerKey}") do={:put "[ISP CENTRIC OK] Router key matches"} else={:put "[ISP CENTRIC FAIL] Router key does not match this script"} } on-error={:put "[ISP CENTRIC WARN] Router key was not read"};`,
          ]
        : []),
      ':put "[ISP CENTRIC] Step 4/8 tunnel firewall";',
      ':do { /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 in-interface=isp-centric comment=isp-centric-api place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 in-interface=isp-centric comment=isp-centric-api };',
      `:do { /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=${tunnelNetwork} comment=isp-centric-api-net place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=tcp dst-port=8728 src-address=${tunnelNetwork} comment=isp-centric-api-net };`,
      ':do { /ip firewall filter add chain=input action=accept protocol=icmp in-interface=isp-centric comment=isp-centric-icmp place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=icmp in-interface=isp-centric comment=isp-centric-icmp };',
      ':do { /ip firewall filter add chain=input action=accept protocol=udp dst-port=3799 in-interface=isp-centric comment=isp-centric-coa place-before=$inAnchor } on-error={ /ip firewall filter add chain=input action=accept protocol=udp dst-port=3799 in-interface=isp-centric comment=isp-centric-coa };',
      ':if ([:len [/ip firewall filter find where comment="isp-centric-api"]] > 0) do={:put "[ISP CENTRIC OK] API and ICMP allowed from the tunnel"} else={:put "[ISP CENTRIC FAIL] Tunnel API rule is missing"};',
      ...(local || !endpointIp
        ? []
        : [
            `:do { /ip firewall filter add chain=output action=accept protocol=udp dst-address=${endpointIp} dst-port=${port} comment=isp-centric-wg-udp place-before=$outAnchor } on-error={ /ip firewall filter add chain=output action=accept protocol=udp dst-address=${endpointIp} dst-port=${port} comment=isp-centric-wg-udp };`,
            ':if ([:len [/ip firewall filter find where comment="isp-centric-wg-udp"]] > 0) do={:put "[ISP CENTRIC OK] Output allows WireGuard to the server"} else={:put "[ISP CENTRIC FAIL] WireGuard output rule is missing"};',
          ]),
      ':put "[ISP CENTRIC] Step 5/8 hotspot";',
      `:do { /ip hotspot ip-binding add type=bypassed address=${tunnelNetwork} comment=isp-centric-hotspot-bypass ; :put "[ISP CENTRIC OK] Hotspot bypasses the management subnet" } on-error={:put "[ISP CENTRIC WARN] Hotspot bypass skipped"};`,
      ':put "[ISP CENTRIC] Step 6/8 nat";',
      `:do { /ip firewall nat add chain=srcnat action=accept dst-address=${tunnelNetwork} comment=isp-centric-no-nat place-before=$natAnchor } on-error={ /ip firewall nat add chain=srcnat action=accept dst-address=${tunnelNetwork} comment=isp-centric-no-nat };`,
      ':if ([:len [/ip firewall nat find where comment="isp-centric-no-nat"]] > 0) do={:put "[ISP CENTRIC OK] Tunnel traffic is not masqueraded"} else={:put "[ISP CENTRIC FAIL] No-nat rule is missing"};',
      ':put "[ISP CENTRIC] Step 7/8 handshake";',
      ...(local
        ? [':put "[ISP CENTRIC] Handshake waits until the VPS peer is added";']
        : [
            ':put "[ISP CENTRIC] The server peer handshakes in the background — no wait needed";',
            `:do { :local hs [/interface wireguard peers get [find where interface="isp-centric"] last-handshake] ; :put ("[ISP CENTRIC OK] Server last-handshake: " . $hs) } on-error={ :put "[ISP CENTRIC] Server last-handshake: none yet — the watchdog re-checks every 3 minutes" };`,
          ]),
      ':put "[ISP CENTRIC] Step 8/8 summary";',
      ...(local
        ? []
        : [
            `:do { /system script add name=isp-centric-watch policy=read,write,test source=":do { /interface enable [find where name=isp-centric] } on-error={} ; /ping ${serverTunnel} count=1" } on-error={};`,
            ':do { /system scheduler add name=isp-centric-watch interval=3m on-event=isp-centric-watch } on-error={};',
            ':put "[ISP CENTRIC OK] Watchdog checks the tunnel every 3 minutes";',
          ]),
      ':if ([:len [/interface wireguard find where name="isp-centric"]] > 0) do={:put "[ISP CENTRIC OK] Summary: interface"} else={:put "[ISP CENTRIC FAIL] Summary: interface"};',
      local
        ? ':put "[ISP CENTRIC] Summary: server peer omitted";'
        : ':if ([:len [/interface wireguard peers find where interface="isp-centric"]] > 0) do={:put "[ISP CENTRIC OK] Summary: server peer"} else={:put "[ISP CENTRIC FAIL] Summary: server peer"};',
      ':if ([:len [/ip service find where name="api" and disabled=no and port=8728]] > 0) do={:put "[ISP CENTRIC OK] Summary: API port 8728"} else={:put "[ISP CENTRIC FAIL] Summary: API port 8728"};',
      ':put "[ISP CENTRIC] Install finished";',
    );
  }
  lines.push("}");
  return { script: lines.join("\n"), applicable, local, reason: problems[0] ?? "" };
}
