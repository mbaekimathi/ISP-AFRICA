import assert from "node:assert/strict";
import { backupName } from "./winboxScript.ts";
import { assignPortRoles, buildDetectedPortsScript, buildHotspotScript, buildMikrotikSetupScript, buildPortScript, buildPppoeScript, buildRecoveryScripts, isPhysicalPort, loadPortUses, networkCidr, portSetupDefaults, routerPortUses } from "./routerScripts.ts";

assert.equal(networkCidr("10.5.50.1/24"), "10.5.50.0/24");

const port = buildPortScript({ iface: "ether1", role: "wan", address: "" });
assert.equal(port.applicable, true);
assert.ok(port.script.includes("dhcp-client"));
assert.equal(buildPortScript({ iface: "ether 1; /user", role: "wan", address: "" }).applicable, false);

assert.deepEqual(routerPortUses("edge"), ["wan", "lan"]);
assert.deepEqual(routerPortUses("pppoe,hotspot"), ["hotspot", "pppoe"]);
assert.equal(isPhysicalPort({ name: "ether2", type: "ether" }), true);
assert.equal(isPhysicalPort({ name: "sfp-sfpplus1", type: "" }), true);
assert.equal(isPhysicalPort({ name: "bridge", type: "bridge" }), false);
assert.equal(isPhysicalPort({ name: "isp-centric", type: "wg" }), false);

const picked = assignPortRoles(
  ["ether1", "ether2", "ether3", "ether4", "ether5"].map((name) => ({
    name,
    comment: "",
    running: name === "ether1",
    disabled: false,
  })),
  "hotspot,pppoe,static,dhcp",
);
assert.deepEqual(picked.ether1, ["wan"]);
assert.deepEqual(picked.ether2, ["hotspot"]);
assert.deepEqual(picked.ether3, ["pppoe"]);
assert.deepEqual(picked.ether4, ["static"]);
assert.deepEqual(picked.ether5, ["dhcp"]);
assert.deepEqual(
  assignPortRoles([{ name: "ether1", comment: "PPPoE", running: true, disabled: false }], "hotspot").ether1,
  ["pppoe"],
);
const restored = loadPortUses(
  [
    { name: "ether1", comment: "", running: true },
    { name: "ether2", comment: "Hotspot, PPPoE", running: false },
  ],
  { ether1: ["wan"] },
  "hotspot,pppoe,static,dhcp",
);
assert.deepEqual(restored.uses.ether1, ["wan"]);
assert.deepEqual(restored.uses.ether2, ["hotspot", "pppoe"]);
assert.equal(restored.saved.ether1, true);
assert.equal(restored.saved.ether2, true);

const detected = buildDetectedPortsScript([
  { iface: "ether1", use: "wan", ...portSetupDefaults("ether1", "wan") },
  { iface: "ether2", use: "pppoe", ...portSetupDefaults("ether2", "pppoe") },
  { iface: "ether3", use: "hotspot", ...portSetupDefaults("ether3", "hotspot") },
]);
assert.ok(detected.script.includes("dhcp-client"));
assert.equal(detected.applicable, true);
assert.ok(detected.script.includes('comment="PPPoE"'));
assert.ok(detected.script.includes('comment="Hotspot"'));
assert.equal(buildDetectedPortsScript([]).applicable, false);

const shared = buildDetectedPortsScript([
  { iface: "ether2", use: "pppoe", ...portSetupDefaults("ether2", "pppoe") },
  { iface: "ether2", use: "hotspot", ...portSetupDefaults("ether2", "hotspot") },
]);
assert.equal(shared.applicable, true);
assert.ok(shared.script.includes('comment="Hotspot, PPPoE"'));
assert.equal(shared.script.split('comment="Hotspot, PPPoE"').length, 2);
assert.ok(shared.script.includes("pppoe-server"));
assert.ok(shared.script.includes("/ip hotspot add"));
assert.ok(shared.script.includes("bridge port find"));
assert.ok(shared.script.includes("interface=$target"));
assert.ok(shared.script.includes("/32"));
assert.equal(shared.script.includes("192.168.88."), false);
const overlap = buildDetectedPortsScript([
  { iface: "ether2", use: "hotspot", ...portSetupDefaults("ether2", "hotspot"), range: "10.2.3.2-10.2.3.100" },
  { iface: "ether2", use: "pppoe", ...portSetupDefaults("ether2", "pppoe"), localAddress: "10.2.3.20", range: "10.2.3.20-10.2.3.80" },
]);
assert.equal(overlap.applicable, false);

const pppoe = buildPppoeScript({
  iface: "ether2",
  service: "pppoe",
  pool: "pppoe-pool",
  localAddress: "10.10.0.1",
  range: "10.10.0.2-10.10.0.254",
  enforced: true,
});
assert.equal(pppoe.applicable, true);
assert.ok(pppoe.script.includes("/interface pppoe-server server add"));
assert.ok(pppoe.script.includes("in-interface=all-ppp"));
assert.ok(pppoe.script.includes("action=drop"));
assert.ok(pppoe.script.includes("accept src-address-list=pppoe-subscribed in-interface=all-ppp"));
assert.ok(pppoe.script.includes("accept dst-address-list=pppoe-subscribed out-interface=all-ppp"));
assert.ok(
  pppoe.script.indexOf("comment=isp-centric-pppoe-allow place-before") <
    pppoe.script.indexOf("comment=isp-centric-pppoe-drop-ppp place-before"),
);
assert.ok(pppoe.script.includes("/ip firewall connection remove"));
assert.ok(pppoe.script.includes("/ipv6 firewall filter add"));

const openPppoe = buildPppoeScript({
  iface: "ether2",
  service: "pppoe",
  pool: "pppoe-pool",
  localAddress: "10.10.0.1",
  range: "10.10.0.2-10.10.0.254",
  enforced: false,
});
assert.equal(openPppoe.applicable, true);
assert.ok(openPppoe.script.includes("/ip dhcp-server add"));
assert.ok(openPppoe.script.includes("disabled=yes"));
assert.ok(openPppoe.script.includes("filter remove"));
assert.ok(openPppoe.script.includes("isp-centric-pppoe-allow-back"));
assert.ok(openPppoe.script.includes("/ipv6 firewall filter remove"));
assert.equal(openPppoe.script.includes("action=drop"), false);

const hotspot = buildHotspotScript({
  iface: "ether3",
  hotspot: "hotspot",
  address: "10.5.50.1/24",
  pool: "hotspot-pool",
  range: "10.5.50.2-10.5.50.254",
  dnsName: "hotspot.local",
  enabled: true,
});
assert.equal(hotspot.applicable, true);
assert.ok(hotspot.script.includes("address=10.5.50.0/24"));
assert.ok(hotspot.script.includes("disabled=no"));

const closedHotspot = buildHotspotScript({
  iface: "ether3",
  hotspot: "hotspot",
  address: "10.5.50.1/24",
  pool: "hotspot-pool",
  range: "10.5.50.2-10.5.50.254",
  dnsName: "hotspot.local",
  enabled: false,
});
assert.equal(closedHotspot.applicable, true);
assert.ok(closedHotspot.script.includes("disabled=yes"));
assert.ok(closedHotspot.script.includes("chain=forward action=drop"));
assert.ok(closedHotspot.script.includes("chain=input action=drop"));
assert.equal(closedHotspot.script.includes("/ip hotspot add"), false);

const setup = buildMikrotikSetupScript({ identity: 'Tower "West"', dns: "1.1.1.1, 8.8.8.8" });
assert.equal(setup.applicable, true);
assert.equal(setup.script.includes('"'), true);
assert.equal(setup.script.includes('Tower "West"'), false);

const withWifi = buildMikrotikSetupScript({
  identity: "Tower",
  dns: "1.1.1.1",
  wifi: [
    { name: "wifi1", ssid: "Office", password: "Office1234", kind: "wifi", security: "default", enabled: true },
    { name: "wifi2", ssid: "Guest", password: "Guest12345", kind: "wifi", security: "guest", enabled: false },
  ],
  winboxUser: { currentName: "isp-centric", name: "isp-centric", password: "Abcdefghij1234567890" },
});
assert.equal(withWifi.applicable, true);
assert.ok(withWifi.script.includes('configuration.ssid="Office"'));
assert.ok(withWifi.script.includes('passphrase="Office1234"'));
assert.equal(withWifi.script.includes("Guest"), false);
assert.ok(withWifi.script.includes('/user set [find where name="isp-centric"] password="Abcdefghij1234567890";'));
assert.equal(withWifi.script.includes("name=office"), false);
assert.equal(buildMikrotikSetupScript({
  identity: "Tower",
  dns: "1.1.1.1",
  winboxUser: { currentName: "admin", name: "office", password: "Abcdefghij1234567890" },
}).applicable, false);
const registeredOnly = buildMikrotikSetupScript({ identity: "", wifi: [], winboxUser: undefined });
assert.equal(registeredOnly.applicable, false);

const recovery = buildRecoveryScripts({ backup: backupName("Tower"), password: "Abcdefghij1234567890" });
assert.equal(recovery.restore.applicable, true);
assert.ok(recovery.restore.script.includes("/system backup load name=isp-Tower"));
assert.ok(recovery.access.script.includes("in-interface=isp-centric"));
assert.equal(recovery.access.script.includes("0.0.0.0"), false);
assert.equal(buildRecoveryScripts({ backup: "isp-Tower", password: "short" }).access.applicable, false);

console.log("router script checks passed");
