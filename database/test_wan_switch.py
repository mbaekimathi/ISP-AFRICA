import unittest

import wan_switch


def uplink(interface, provider, method="dhcp", health="healthy", active=False, gateway=""):
    return {
        "interface": interface,
        "provider": provider,
        "method": method,
        "gateway": gateway,
        "downloadMbps": 100 if interface == "ether1" else 50,
        "uploadMbps": 100 if interface == "ether1" else 50,
        "health": health,
        "eligible": True,
        "active": active,
    }


class WanSwitchTests(unittest.TestCase):
    def setUp(self):
        self.uplinks = [
            uplink("ether1", "Safaricom", active=True),
            uplink("ether2", "Upstream", health="healthy"),
        ]

    def test_manual_switch_keeps_standby_and_management(self):
        plan = wan_switch.prepare_switch(self.uplinks, "ether2", "manual-single", True, False, "7.16")
        self.assertTrue(plan["allowed"])
        kinds = [item["kind"] for item in plan["changes"]]
        self.assertIn("preserve-management", kinds)
        standby = [item for item in plan["changes"] if item["kind"] == "dhcp-distance" and item["interface"] == "ether1"][0]
        active = [item for item in plan["changes"] if item["kind"] == "dhcp-distance" and item["interface"] == "ether2"][0]
        self.assertEqual(standby["distance"], 200)
        self.assertFalse(standby["addDefaultRoute"])
        self.assertEqual(active["distance"], 1)
        self.assertTrue(active["addDefaultRoute"])
        rendered = str(plan["changes"])
        self.assertNotIn("reboot", rendered)
        self.assertNotIn("tracking", rendered)
        self.assertNotIn("disabled", rendered)
        self.assertTrue(any("interrupted" in line for line in plan["impact"]))

    def test_other_modes_do_not_switch_automatically(self):
        for mode in ("load-balance", "failover", "hybrid"):
            plan = wan_switch.prepare_switch(self.uplinks, "ether2", mode, True, True, "7.16")
            self.assertFalse(plan["allowed"])
            self.assertEqual(plan["changes"], [])

    def test_unhealthy_and_unreachable_need_an_override(self):
        unhealthy = [uplink("ether1", "Safaricom", active=True), uplink("ether2", "Upstream", health="unhealthy")]
        held = wan_switch.prepare_switch(unhealthy, "ether2", "manual-single", True, False, "7")
        self.assertFalse(held["allowed"])
        self.assertTrue(held["needsOverride"])
        down = [uplink("ether1", "Safaricom", active=True), uplink("ether2", "Upstream", health="unreachable")]
        blocked = wan_switch.prepare_switch(down, "ether2", "manual-single", True, False, "7")
        self.assertTrue(blocked["needsOverride"])
        allowed = wan_switch.prepare_switch(down, "ether2", "manual-single", True, True, "7")
        self.assertTrue(allowed["allowed"])
        self.assertIn("unreachable", allowed["warning"])

    def test_confirmation_is_required(self):
        plan = wan_switch.prepare_switch(self.uplinks, "ether2", "manual-single", False, False, "6.49")
        self.assertFalse(plan["allowed"])
        self.assertTrue(plan["needsConfirm"])

    def test_failed_verification_restores_the_previous_uplink(self):
        calls = []

        def writer(commands):
            calls.append(commands)
            if len(calls) == 1:
                return {"applied": True, "managementOk": True, "gatewayOk": False, "routeOk": False, "natOk": False}
            return {"applied": True, "managementOk": True, "gatewayOk": True, "routeOk": True, "natOk": True}

        outcome, message, result = wan_switch.execute(
            {"interface": "ether2", "confirm": True, "override": False, "mode": "manual-single", "uplinks": self.uplinks},
            {"routeros_version": "7.16"},
            writer,
        )
        self.assertEqual(outcome, "failed")
        self.assertFalse(result["commitActive"])
        self.assertFalse(result["needsManualRecovery"])
        self.assertIn("restored", message)
        self.assertEqual(len(calls), 2)

    def test_unconfirmed_recovery_is_not_reported_as_success(self):
        calls = {"count": 0}

        def writer(_commands):
            calls["count"] += 1
            if calls["count"] == 1:
                return {"applied": True, "managementOk": False, "gatewayOk": False, "routeOk": False, "natOk": False}
            return {"applied": False, "managementOk": False, "gatewayOk": False, "routeOk": False, "natOk": False}

        outcome, message, result = wan_switch.execute(
            {"interface": "ether2", "confirm": True, "override": False, "mode": "manual-single", "uplinks": self.uplinks},
            {"routeros_version": "7.16"},
            writer,
        )
        self.assertEqual(outcome, "failed")
        self.assertTrue(result["needsManualRecovery"])
        self.assertFalse(result["commitActive"])
        self.assertIn("manual recovery", message)

    def test_no_change_when_the_router_cannot_be_reached(self):
        def writer(_commands):
            return {"applied": False, "managementOk": False, "gatewayOk": False, "routeOk": False, "natOk": False}

        outcome, message, result = wan_switch.execute(
            {"interface": "ether2", "confirm": True, "override": False, "mode": "manual-single", "uplinks": self.uplinks},
            {"routeros_version": "7.16"},
            writer,
        )
        self.assertEqual(outcome, "failed")
        self.assertFalse(result["needsManualRecovery"])
        self.assertFalse(result["commitActive"])
        self.assertIn("unchanged", message)

    def test_success_commits_only_after_checks(self):
        def writer(_commands):
            return {"applied": True, "managementOk": True, "gatewayOk": True, "routeOk": True, "natOk": True}

        outcome, _message, result = wan_switch.execute(
            {"interface": "ether2", "confirm": True, "override": False, "mode": "manual-single", "uplinks": self.uplinks},
            {"routeros_version": "7.16"},
            writer,
        )
        self.assertEqual(outcome, "succeeded")
        self.assertTrue(result["commitActive"])
        self.assertEqual(result["target"], "ether2")

    def test_missing_internet_does_not_commit(self):
        def writer(_commands):
            return {
                "applied": True,
                "managementOk": True,
                "gatewayOk": True,
                "routeOk": True,
                "natOk": True,
                "internetOk": False,
            }

        outcome, message, result = wan_switch.execute(
            {"interface": "ether2", "confirm": True, "override": False, "mode": "manual-single", "uplinks": self.uplinks},
            {"routeros_version": "7.16"},
            writer,
        )
        self.assertEqual(outcome, "failed")
        self.assertFalse(result["commitActive"])
        self.assertIn("restored", message)

    def test_override_requires_network_staff_when_staff_exist(self):
        self.assertFalse(wan_switch.override_allowed("", True))
        self.assertTrue(wan_switch.override_allowed("it-support", True))
        self.assertTrue(wan_switch.override_allowed("", False))

    def test_recording_the_current_uplink_does_not_build_router_changes(self):
        recorded = wan_switch.record_current(self.uplinks, "ether1", "manual-single", True)
        self.assertEqual(recorded["target"], "ether1")
        self.assertNotIn("changes", recorded)
        with self.assertRaises(wan_switch.SwitchError):
            wan_switch.record_current(self.uplinks, "ether2", "manual-single", False)


if __name__ == "__main__":
    unittest.main()
