import assert from "node:assert/strict";
import { backupName, buildWinboxScript } from "./winboxScript.ts";

const key = `${"A".repeat(43)}=`;
const device = {
  name: 'Tower "West"',
  tunnelIp: "10.88.0.8",
  privateKey: key,
  serverTunnelIp: "10.88.0.1",
  endpoint: "vpn.example.net",
  endpointPort: 51820,
  serverPublicKey: key,
};

const ready = buildWinboxScript(device, "Abcdefghij1234567890");
assert.equal(ready.applicable, true);
assert.ok(ready.script.indexOf("No changes were made.") < ready.script.indexOf("/system backup save"));
assert.ok(ready.script.indexOf("/system backup save") < ready.script.indexOf("/interface wireguard add"));
assert.ok(ready.script.includes('[:typeof [/interface wireguard find]]'));
assert.equal(ready.script.includes("foreach item in=[/interface wireguard find] do={ :set tunnelReady"), false);
assert.ok(ready.script.includes('allowed-address=10.88.0.1/32'));
assert.ok(ready.script.includes('address=10.88.0.8/24 interface=isp-centric'));
assert.equal(ready.script.includes('address=10.88.0.8/32'), false);
assert.ok(ready.script.includes("Step 1/8 cleanup"));
assert.ok(ready.script.includes("address=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"));
assert.equal(ready.script.includes("0.0.0.0/0"), false);
assert.equal(ready.script.includes("dst-port=8291"), false);
assert.ok(ready.script.includes('persistent-keepalive=25s'));
assert.ok(ready.script.includes('endpoint-address="vpn.example.net"'));
assert.equal(ready.script.includes('Tower "West"'), false);
assert.equal(backupName('Tower "West"'), "isp-TowerWest");

const blocked = buildWinboxScript({ ...device, endpoint: "bad endpoint;" }, "Abcdefghij1234567890");
assert.equal(blocked.applicable, false);
assert.ok(blocked.script.includes(':error "The VPS endpoint is not set. No changes were made."'));
assert.equal(blocked.script.includes("/system backup save"), false);
assert.equal(blocked.script.includes("bad endpoint"), false);

const injected = buildWinboxScript({ ...device, serverPublicKey: `${key}"; /user add` }, "Abcdefghij1234567890");
assert.equal(injected.applicable, false);
assert.equal(injected.script.includes("/user add"), false);

const local = buildWinboxScript({ ...device, serverPublicKey: "", endpoint: "" }, "Abcdefghij1234567890");
assert.equal(local.applicable, true);
assert.equal(local.local, true);
assert.ok(local.script.includes("/interface wireguard add"));
assert.ok(local.script.includes("/user add"));
assert.equal(local.script.includes("/interface wireguard peers add"), false);
assert.ok(local.script.includes("The VPS peer is omitted"));

console.log("winbox script checks passed");
