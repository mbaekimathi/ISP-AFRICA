import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import routeros_api


class ScriptedSocket:
    def __init__(self, replies):
        self.replies = replies
        self.sent = []
        self.incoming = b""

    def sendall(self, payload):
        self.sent.append(payload)
        if self.replies:
            self.incoming += self.replies.pop(0)

    def recv(self, size):
        if not self.incoming:
            return b""
        chunk, self.incoming = self.incoming[:size], self.incoming[size:]
        return chunk

    def settimeout(self, _timeout):
        return None

    def close(self):
        return None


def sentence(*words):
    return routeros_api.encode_sentence(words)


class RouterOsApiTests(unittest.TestCase):
    def test_drop_duration_uses_start_and_end(self):
        from datetime import datetime, timedelta

        start = datetime(2026, 10, 16, 8, 0, 0)
        end = start + timedelta(minutes=18, seconds=5)
        self.assertEqual(routeros_api.duration_label(start, end, end), "18m 5s")
        ongoing = routeros_api.health_event("ether1", "No carrier on the WAN port", start, None, start + timedelta(minutes=42))
        self.assertTrue(ongoing["open"])
        self.assertEqual(ongoing["duration"], "42m")
        self.assertIsNone(ongoing["endedAt"])

    def test_health_trend_opens_on_live_time(self):
        health = routeros_api.sample_health()
        self.assertEqual(len(health["trend"]), 12)
        self.assertEqual(len(health["trends"]["days"]), 7)
        self.assertEqual(len(health["trends"]["weeks"]), 8)
        self.assertEqual(len(health["trends"]["month"]), 30)
        self.assertEqual(len(health["trends"]["year"]), 12)
        self.assertGreater(sum(point["minutes"] for point in health["trend"]), 0)

    def test_sample_is_labeled_and_not_a_live_check(self):
        sample = routeros_api.sample_router("Tower")
        self.assertTrue(sample["sample"])
        self.assertEqual(sample["identity"], "Tower")
        self.assertGreater(len(sample["interfaces"]), 0)
        self.assertNotIn("password", sample)


    def test_password_round_trip(self):
        sealed = routeros_api.seal_password("Abcdefghijk123")
        self.assertNotIn("Abcdefghijk123", sealed)
        self.assertEqual(routeros_api.open_password(sealed), "Abcdefghijk123")

    def test_read_uses_login_and_prints_running_state(self):
        sock = ScriptedSocket(
            [
                sentence("!done"),
                sentence("!re", "=name=Tower") + sentence("!done"),
                sentence(
                    "!re",
                    "=version=7.16",
                    "=uptime=1d2h",
                    "=cpu-load=4",
                    "=board-name=hAP",
                    "=free-memory=1048576",
                    "=total-memory=2097152",
                )
                + sentence("!done"),
                sentence(
                    "!re",
                    "=name=isp-centric",
                    "=type=wg",
                    "=running=true",
                    "=disabled=false",
                    "=rx-byte=10",
                    "=tx-byte=20",
                )
                + sentence("!done"),
                sentence("!trap", "=message=no such command") + sentence("!done"),
                sentence("!re") + sentence("!done"),
            ]
        )

        def opener(_address, timeout):
            self.assertEqual(timeout, 4)
            return sock

        live = routeros_api.read_router("10.88.0.2", "secret-password", opener=opener)
        self.assertTrue(live["reachable"])
        self.assertEqual(live["identity"], "Tower")
        self.assertEqual(live["uptime"], "1d2h")
        self.assertEqual(live["cpuLoad"], "4")
        self.assertEqual(live["freeMemory"], "1 MB")
        self.assertEqual(live["interfaces"][0]["name"], "isp-centric")
        self.assertTrue(live["interfaces"][0]["running"])
        self.assertIsNone(live["hotspotActive"])
        self.assertEqual(live["pppoeActive"], 1)
        self.assertNotIn(b"secret-password", b"".join(sock.sent[1:]))
        self.assertIn(b"/system/resource/print", sock.sent[2])

    def test_empty_reply_counts_as_zero_sessions(self):
        sock = ScriptedSocket(
            [
                sentence("!done"),
                sentence("!re", "=name=Tower") + sentence("!done"),
                sentence("!re", "=cpu-load=1", "=free-memory=80179200", "=total-memory=134217728") + sentence("!done"),
                sentence("!done"),
                sentence("!empty") + sentence("!done"),
                sentence("!empty") + sentence("!done"),
            ]
        )
        live = routeros_api.read_router("10.88.0.2", "secret-password", opener=lambda _address, _timeout: sock)
        self.assertEqual(live["hotspotActive"], 0)
        self.assertEqual(live["pppoeActive"], 0)
        self.assertEqual(live["freeMemory"], "76.5 MB")
        self.assertEqual(live["totalMemory"], "128 MB")

    def test_idle_bridge_ports_are_not_outages(self):
        self.assertIsNone(routeros_api.interface_outage({"name": "ether4", "running": False, "disabled": False, "slave": True, "type": "ether"}))
        self.assertIsNone(routeros_api.interface_outage({"name": "lo", "running": False, "disabled": False, "slave": False, "type": "loopback"}))
        self.assertEqual(
            routeros_api.interface_outage({"name": "ether1", "running": False, "disabled": False, "slave": False, "type": "ether"}),
            "ether1 link down",
        )
        labeled = routeros_api.label_port_roles(
            [{"name": "ether1", "comment": ""}, {"name": "ether2", "comment": "kept"}],
            {"ether1": ["wan"], "ether2": ["hotspot", "pppoe"]},
        )
        self.assertEqual(labeled[0]["comment"], "WAN")
        self.assertEqual(labeled[1]["comment"], "kept")

    def test_setup_reads_wifi_users_and_services(self):
        sock = ScriptedSocket(
            [
                sentence("!done"),
                sentence("!re", "=name=Tower") + sentence("!done"),
                sentence("!re", "=servers=1.1.1.1,8.8.8.8") + sentence("!done"),
                sentence("!re", "=name=winbox", "=port=8291", "=disabled=false") + sentence("!done"),
                sentence("!re", "=name=admin", "=group=full", "=disabled=false") + sentence("!done"),
                sentence("!re", "=name=wifi1", "=disabled=false", "=configuration.ssid=Office", "=security=default") + sentence("!done"),
                sentence("!re", "=name=default", "=passphrase=Office1234") + sentence("!done"),
                sentence("!trap", "=message=no such command") + sentence("!done"),
                sentence("!done"),
                sentence("!re", "=enabled=true") + sentence("!done"),
            ]
        )

        def opener(_address, timeout):
            self.assertEqual(timeout, 4)
            return sock

        setup = routeros_api.read_setup("10.88.0.2", "secret-password", opener=opener)
        self.assertEqual(setup["identity"], "Tower")
        self.assertEqual(setup["dns"], "1.1.1.1,8.8.8.8")
        self.assertEqual(setup["services"][0]["name"], "winbox")
        self.assertFalse(setup["services"][0]["disabled"])
        self.assertEqual(setup["users"][0]["name"], "admin")
        self.assertEqual(setup["wifi"][0]["ssid"], "Office")
        self.assertEqual(setup["wifi"][0]["password"], "Office1234")
        self.assertTrue(setup["wifi"][0]["passwordVisible"])
        self.assertFalse(setup["wifi"][0]["disabled"])
        self.assertTrue(setup["ntpEnabled"])
        self.assertNotIn("secret-password", setup["wifi"][0]["password"])

    def test_link_up_without_a_ping_is_unhealthy(self):
        self.assertEqual(routeros_api.classify_uplink({"running": "true", "disabled": "false"}, [{"received": "0"}]), "unhealthy")
        self.assertEqual(routeros_api.classify_uplink({"running": "true", "disabled": "false"}, [{"received": "1"}]), "healthy")
        self.assertEqual(routeros_api.classify_uplink({"running": "false", "disabled": "false"}, []), "unreachable")

    def test_planned_dhcp_route_is_not_proof_of_a_default_route(self):
        self.assertFalse(routeros_api.default_route_ok([], "ether2"))
        self.assertFalse(
            routeros_api.default_route_ok(
                [{"dst-address": "0.0.0.0/0", "distance": "1", "gateway": "1.2.3.4", "immediate-gw": "1.2.3.4%ether1"}],
                "ether2",
            )
        )
        self.assertTrue(
            routeros_api.default_route_ok(
                [{"dst-address": "0.0.0.0/0", "distance": "1", "gateway": "1.2.3.4", "immediate-gw": "1.2.3.4%ether2", "active": "true"}],
                "ether2",
            )
        )

    def test_apply_checks_the_route_on_the_router(self):
        def done(*words):
            return sentence("!re", *words) + sentence("!done")

        sock = ScriptedSocket(
            [
                sentence("!done"),
                done("=interface=ether2", "=.id=*1"),
                sentence("!done"),
                sentence("!done"),
                sentence("!done"),
                done("=name=Tower"),
                done("=name=ether2", "=running=true"),
                sentence("!done"),
                done("=comment=isp-centric-wan-nat-ether2", "=disabled=false"),
                done("=received=0"),
            ]
        )

        def opener(_address, timeout):
            self.assertEqual(timeout, 4)
            return sock

        report = routeros_api.apply_uplink_plan(
            "10.88.0.5",
            "secret-password",
            [
                {"kind": "dhcp-distance", "interface": "ether2", "distance": 1, "addDefaultRoute": True},
                {"kind": "nat", "interface": "ether2", "enabled": True},
                {"kind": "preserve-management", "interface": "isp-centric"},
            ],
            opener=opener,
        )
        self.assertTrue(report["applied"])
        self.assertTrue(report["gatewayOk"])
        self.assertTrue(report["natOk"])
        self.assertFalse(report["routeOk"])
        self.assertFalse(report["internetOk"])
        self.assertNotIn(b"secret-password", b"".join(sock.sent[1:]))

    def test_hotspot_switch_writes_without_a_script(self):
        done = sentence("!done")
        sock = ScriptedSocket(
            [
                done,
                sentence("!re", "=name=ether3", "=type=ether", "=comment=Hotspot") + done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
            ]
        )
        report = routeros_api.apply_hotspot_access("10.88.0.5", "secret-password", False, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/firewall/filter/add", sent)
        self.assertIn(b"isp-centric-hotspot-block", sent)
        self.assertNotIn(b"/system/script", sent)

    def test_port_choice_is_written_without_a_script(self):
        done = sentence("!done")
        sock = ScriptedSocket(
            [
                done,
                sentence("!re", "=.id=*1", "=name=ether1", "=type=ether") + done,
                done,
                done,
                done,
                done,
            ]
        )
        report = routeros_api.apply_port_uses(
            "10.88.0.5",
            "secret-password",
            {"ether1": ["wan"]},
            opener=lambda _address, _timeout: sock,
        )
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/ip/dhcp-client/add", sent)
        self.assertIn(b"=comment=WAN", sent)
        self.assertNotIn(b"/system/script", sent)
        self.assertNotIn(b"secret-password", b"".join(sock.sent[1:]))

    def test_pppoe_enforcement_writes_firewall_without_a_script(self):
        message = routeros_api.router_change_message(routeros_api.RouterError("not enough permissions (9)"))
        self.assertIn("cannot change them", message)
        done = sentence("!done")
        sock = ScriptedSocket(
            [
                done,
                sentence("!re", "=name=ether2", "=type=ether", "=comment=PPPoE") + done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
                done,
            ]
        )
        report = routeros_api.apply_pppoe_enforcement("10.88.0.5", "secret-password", True, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"pppoe-subscribed", sent)
        self.assertIn(b"dns-server=10.10.0.1", sent)
        self.assertIn(b"dst-port=53", sent)
        self.assertIn(b"in-interface=all-ppp", sent)
        self.assertIn(b"out-interface=all-ppp", sent)
        self.assertIn(b"dst-address-list=pppoe-suspended", sent)
        self.assertIn(b"dst-address-list=pppoe-expired", sent)
        self.assertIn(b"/ip/firewall/nat/add", sent)
        self.assertIn(b"to-ports=8790", sent)
        self.assertIn(b"/ip/firewall/connection/print", sent)
        self.assertIn(b"/ipv6/firewall/filter/add", sent)
        self.assertIn(b"/interface/pppoe-server/server/add", sent)
        self.assertIn(b"in-interface=ether2", sent)
        self.assertNotIn(b"/system/script", sent)
        self.assertNotIn(b"secret-password", b"".join(sock.sent[1:]))

    def test_pppoe_port_skips_the_wan_interface(self):
        done = sentence("!done")
        sock = ScriptedSocket(
            [
                done,
                sentence("!re", "=name=ether1", "=type=ether") + sentence("!re", "=name=ether2", "=type=ether") + done,
                sentence("!re", "=.id=*9", "=interface=ether1", "=service-name=pppoe") + done,
                sentence("!re", "=interface=ether1", "=list=WAN") + sentence("!re", "=interface=bridge", "=list=LAN") + done,
                sentence("!re", "=interface=ether1") + done,
                done,
            ]
            + [done] * 50
        )
        report = routeros_api.apply_pppoe_enforcement("10.88.0.5", "secret-password", True, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/interface/pppoe-server/server/set", sent)
        self.assertIn(b"=interface=ether2", sent)

    def test_pppoe_port_honors_the_configured_access_interface(self):
        done = sentence("!done")
        sock = ScriptedSocket(
            [
                done,
                sentence("!re", "=name=ether1", "=type=ether") + sentence("!re", "=name=ether5", "=type=ether") + done,
                sentence("!re", "=.id=*9", "=interface=ether1", "=service-name=pppoe") + done,
                sentence("!re", "=interface=ether1", "=list=WAN") + done,
                sentence("!re", "=interface=ether1") + done,
                done,
            ]
            + [done] * 50
        )
        report = routeros_api.apply_pppoe_enforcement(
            "10.88.0.5", "secret-password", True, access="ether5", opener=lambda _address, _timeout: sock
        )
        self.assertTrue(report["applied"])
        self.assertIn(b"=interface=ether5", b"".join(sock.sent))

    def test_live_sessions_reads_devices_from_the_router(self):
        sock = ScriptedSocket(
            [
                sentence("!done"),
                sentence(
                    "!re",
                    "=name=<pppoe-user1>",
                    "=user=user1",
                    "=remote-address=8C:44:BB:2F:AA:E8",
                    "=uptime=18m29s",
                    "=dynamic=true",
                    "=running=true",
                )
                + sentence("!re", "=name=<pppoe-other>", "=user=other", "=remote-address=AA:BB:CC:DD:EE:FF", "=dynamic=true")
                + sentence("!done"),
                sentence("!re", "=name=user1", "=caller-id=8C:44:BB:2F:AA:E8", "=address=10.10.0.2", "=uptime=18m29s") + sentence("!done"),
                sentence("!re", "=name=<pppoe-user1>", "=rx-byte=2704487", "=tx-byte=25497108")
                + sentence("!re", "=name=ether1", "=rx-byte=9", "=tx-byte=9")
                + sentence("!done"),
            ]
        )
        sessions = routeros_api.live_sessions("10.88.0.2", "secret-password", "user1", opener=lambda _address, _timeout: sock)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["mac"], "8C:44:BB:2F:AA:E8")
        self.assertEqual(sessions[0]["ip"], "10.10.0.2")
        self.assertEqual(sessions[0]["uptime"], "18m29s")
        self.assertEqual(sessions[0]["seconds"], 18 * 60 + 29)
        self.assertEqual(sessions[0]["bytesIn"], 2704487)
        self.assertEqual(sessions[0]["bytesOut"], 25497108)

    def test_live_sessions_falls_back_to_active_rows(self):
        sock = ScriptedSocket(
            [
                sentence("!done"),
                sentence("!done"),
                sentence("!re", "=name=user1", "=caller-id=8c:44:bb:2f:aa:e8", "=address=10.10.0.2", "=uptime=5s") + sentence("!done"),
                sentence("!done"),
            ]
        )
        sessions = routeros_api.live_sessions("10.88.0.2", "secret-password", "user1", opener=lambda _address, _timeout: sock)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["mac"], "8c:44:bb:2f:aa:e8")
        self.assertEqual(sessions[0]["seconds"], 5)
        self.assertEqual(sessions[0]["bytesIn"], 0)
        self.assertEqual(routeros_api.norm_mac("8c-44-bb-2f-aa-e8"), routeros_api.norm_mac("8C:44:BB:2F:AA:E8"))

    def test_a_selection_script_runs_and_is_removed(self):
        self.assertFalse(routeros_api.script_is_allowed("{ /system reboot; }"))
        source = "{\n# ISP CENTRIC port setup.\n/interface set [find where name=\"ether2\"] comment=\"LAN\";\n}"
        self.assertTrue(routeros_api.script_is_allowed(source))
        sock = ScriptedSocket(
            [
                sentence("!done"),
                sentence("!done"),
                sentence("!done", "=ret=*1"),
                sentence("!done"),
                sentence("!done"),
            ]
        )
        report = routeros_api.run_script("10.88.0.5", "secret-password", source, opener=lambda _address, _timeout: sock)
        self.assertTrue(report["applied"])
        sent = b"".join(sock.sent)
        self.assertIn(b"/system/script/run", sent)
        self.assertIn(b"/system/script/remove", sent)
        self.assertNotIn(b"secret-password", b"".join(sock.sent[1:]))


if __name__ == "__main__":
    unittest.main()
