"""Live checks against the account API and the router rules that protect it.

The confirmed uplink switch is not sent. That request can move traffic on a
connected router, and a development sample must not be treated as success.
"""

import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import routeros_api


BASE = "http://127.0.0.1:8765"


def api_is_up():
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=3) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


class SampleHealthTests(unittest.TestCase):
    def test_link_up_without_a_reply_is_not_healthy(self):
        self.assertEqual(
            routeros_api.classify_uplink({"name": "ether1", "running": True, "disabled": False}, [{"received": "0"}]),
            "unhealthy",
        )
        self.assertEqual(
            routeros_api.classify_uplink({"name": "ether1", "running": True, "disabled": False}, [{"received": "1"}]),
            "healthy",
        )

    def test_a_down_link_is_unreachable(self):
        self.assertEqual(
            routeros_api.classify_uplink({"name": "ether2", "running": False, "disabled": False}, None),
            "unreachable",
        )


@unittest.skipUnless(api_is_up(), "account API is not listening on 127.0.0.1:8765")
class AccountSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.jar = CookieJar()
        cls.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cls.jar))

    def call(self, method, path, body=None, timeout=20):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            BASE + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            payload = error.read().decode("utf-8")
            return error.code, json.loads(payload) if payload else {}

    def test_health_and_private_routes(self):
        status, body = self.call("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["database"], "ok")
        status, body = self.call("GET", "/api/mikrotiks")
        self.assertEqual(status, 401)
        self.assertIn("error", body)

    def test_router_pages_round_trip(self):
        password = os.environ.get("ISP_SEED_PASSWORD", "000000")
        status, body = self.call("POST", "/api/client/login", {"loginCode": "000000", "password": password})
        self.assertEqual(status, 200, body)
        self.assertIn("account", body)

        status, listing = self.call("GET", "/api/mikrotiks")
        self.assertEqual(status, 200, listing)
        self.assertGreaterEqual(listing["total"], 1)
        device_id = listing["devices"][0]["id"]

        status, device = self.call("GET", f"/api/mikrotiks/{device_id}")
        self.assertEqual(status, 200, device)
        self.assertIn("pppoeEnforced", device["device"])
        self.assertIn("hotspotEnabled", device["device"])
        original_pppoe = device["device"]["pppoeEnforced"]
        original_hotspot = device["device"]["hotspotEnabled"]

        status, live = self.call("GET", f"/api/mikrotiks/{device_id}/live", timeout=25)
        self.assertEqual(status, 200, live)
        self.assertIn("interfaces", live["live"])
        names = [item["name"] for item in live["live"]["interfaces"]]
        self.assertTrue(names or live["live"].get("message"))

        try:
            status, toggled = self.call("POST", f"/api/mikrotiks/{device_id}/pppoe", {"enforced": not original_pppoe})
            self.assertEqual(status, 200, toggled)
            self.assertEqual(toggled["device"]["pppoeEnforced"], not original_pppoe)
            status, hotspot = self.call("POST", f"/api/mikrotiks/{device_id}/hotspot", {"enabled": not original_hotspot})
            self.assertEqual(status, 200, hotspot)
            self.assertEqual(hotspot["device"]["hotspotEnabled"], not original_hotspot)
        finally:
            self.call("POST", f"/api/mikrotiks/{device_id}/pppoe", {"enforced": original_pppoe})
            self.call("POST", f"/api/mikrotiks/{device_id}/hotspot", {"enabled": original_hotspot})

        status, restored = self.call("GET", f"/api/mikrotiks/{device_id}")
        self.assertEqual(restored["device"]["pppoeEnforced"], original_pppoe)
        self.assertEqual(restored["device"]["hotspotEnabled"], original_hotspot)

        status, wan = self.call("GET", f"/api/mikrotiks/{device_id}/wan")
        self.assertEqual(status, 200, wan)
        self.assertIn(wan["mode"], {"load-balance", "failover", "hybrid", "manual-single"})
        self.assertIn("canOverride", wan)
        before = [item["interface"] for item in wan["uplinks"]]

        status, rejected = self.call(
            "POST",
            f"/api/mikrotiks/{device_id}/wan",
            {"mode": wan["mode"], "uplinks": [{"interface": "ether1", "provider": "", "method": "dhcp", "downloadMbps": 10, "uploadMbps": 10}]},
        )
        self.assertEqual(status, 400, rejected)
        status, after = self.call("GET", f"/api/mikrotiks/{device_id}/wan")
        self.assertEqual([item["interface"] for item in after["uplinks"]], before)

        if len(wan["uplinks"]) >= 2 and wan["mode"] == "manual-single":
            target = wan["uplinks"][1]["interface"]
            status, held = self.call(
                "POST",
                f"/api/mikrotiks/{device_id}/wan/switch",
                {"interface": target, "confirm": False, "override": False},
            )
            self.assertEqual(status, 400, held)
            self.assertNotIn("job", held)
            status, missing = self.call(
                "POST",
                f"/api/mikrotiks/{device_id}/wan/switch",
                {"interface": "not-a-port", "confirm": True, "override": True},
            )
            self.assertEqual(status, 400, missing)
            status, recorded = self.call(
                "POST",
                f"/api/mikrotiks/{device_id}/wan/active",
                {"interface": target, "confirm": False},
            )
            self.assertEqual(status, 400, recorded)
            status, health = self.call("GET", f"/api/mikrotiks/{device_id}/wan/reachability", timeout=25)
            self.assertEqual(status, 200, health)
            self.assertIn(target, health["health"])


if __name__ == "__main__":
    unittest.main()
