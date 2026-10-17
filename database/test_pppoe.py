import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pppoe_service
import pppoe_store
import routeros_api


TODAY = date(2026, 10, 16)


def context():
    return {
        "usernames": set(),
        "serials": set(),
        "phones": set(),
        "router": {"id": "router-1", "status": "active", "tunnelStatus": "up", "site": "Westlands"},
        "package": {
            "id": "pkg-1",
            "status": "active",
            "routers": ["router-1"],
            "downloadMbps": 10,
            "uploadMbps": 5,
            "price": "2500.00",
        },
        "usedIps": set(),
        "interfaces": ["ether2"],
        "pool": {"start": "10.10.0.2", "end": "10.10.0.4"},
    }


def payload(**extra):
    body = {
        "firstName": "Amina",
        "lastName": "Wanjiku",
        "phone": "0712345678",
        "password": "Abcdefg2",
        "routerId": "router-1",
        "packageId": "pkg-1",
        "startDate": "2026-10-16",
    }
    body.update(extra)
    return body


class MemoryCursor:
    def __init__(self):
        self.statements = []

    def execute(self, sql, args=None):
        self.statements.append((" ".join(sql.split()), args))


class PppoeValidationTests(unittest.TestCase):
    def test_phone_and_username_are_normalized(self):
        self.assertEqual(pppoe_service.normalize_phone("+254712345678"), "254712345678")
        self.assertEqual(pppoe_service.normalize_phone("0112345678"), "254112345678")
        self.assertIsNone(pppoe_service.normalize_phone("12345"))

    def test_register_plan_assigns_an_address_and_radius_profile(self):
        checked = pppoe_service.validate_pppoe_provisioning(payload(), context(), TODAY)
        self.assertEqual(checked["errors"], [])
        plan = checked["normalized"]
        self.assertEqual(plan["username"], "0712345678")
        self.assertEqual(plan["status"], "active")
        self.assertEqual(plan["staticIp"], "10.10.0.2")
        self.assertEqual(plan["rateLimit"], "5M/10M")
        built = pppoe_service.radius_plan(plan)
        attributes = [row["attribute"] for row in built["checks"]]
        self.assertIn("Cleartext-Password", attributes)
        self.assertIn("Simultaneous-Use", attributes)
        self.assertNotIn("Auth-Type", attributes)
        self.assertEqual(built["replies"][0]["value"], "10.10.0.2")
        self.assertIn("Session-Timeout", [row["attribute"] for row in built["replies"]])
        self.assertEqual(built["groupReplies"][0]["value"], "5M/10M")
        self.assertEqual(built["groupReplies"][1]["value"], "pppoe-subscribed")
        self.assertFalse(pppoe_store.subscription_can_surf({"status": "active", "billing_status": "suspended", "expiry_date": None}, TODAY))
        self.assertTrue(pppoe_store.subscription_can_surf({"status": "active", "billing_status": "paid", "expiry_date": date(2026, 10, 20)}, TODAY))

    def test_empty_start_date_dials_into_the_suspended_list(self):
        checked = pppoe_service.validate_pppoe_provisioning(payload(startDate=""), context(), TODAY)
        plan = checked["normalized"]
        self.assertEqual(plan["status"], "pending_activation")
        self.assertFalse(plan["radiusActive"])
        built = pppoe_service.radius_plan(plan)
        attributes = [row["attribute"] for row in built["checks"]]
        self.assertIn("Cleartext-Password", attributes)
        self.assertNotIn("Auth-Type", attributes)
        self.assertEqual(built["group"], "pppoe-expired")
        self.assertIn("pppoe-expired", [row["value"] for row in built["groupReplies"]])
        reply = {row["attribute"]: row["value"] for row in built["replies"]}
        self.assertEqual(reply["Session-Timeout"], str(pppoe_service.RESTRICTED_SESSION_SECONDS))

    def test_suspended_dials_into_the_paused_list(self):
        built = pppoe_service.radius_plan(
            {"password": "pass1234", "sessionLimit": 1, "radiusActive": False, "status": "suspended", "poolName": "pppoe-pool", "rateLimit": "64k/64k"}
        )
        self.assertEqual(built["group"], "pppoe-restricted")
        self.assertIn("pppoe-suspended", [row["value"] for row in built["groupReplies"]])

    def test_duplicate_username_and_exhausted_pool_block_creation(self):
        taken = context()
        taken["usernames"] = {"254712345678"}
        taken["usedIps"] = {"10.10.0.2", "10.10.0.3", "10.10.0.4"}
        checked = pppoe_service.validate_pppoe_provisioning(payload(staticIp=""), taken, TODAY)
        fields = {item["field"] for item in checked["errors"]}
        self.assertIn("username", fields)
        self.assertIn("staticIp", fields)
        self.assertIsNone(checked["normalized"])

    def test_package_must_belong_to_the_router(self):
        wrong = context()
        wrong["package"] = {**wrong["package"], "routers": ["other"]}
        checked = pppoe_service.validate_pppoe_provisioning(payload(), wrong, TODAY)
        self.assertIn("packageId", {item["field"] for item in checked["errors"]})

    def test_router_status_labels(self):
        later = date(2026, 10, 20)
        earlier = date(2026, 10, 15)
        self.assertEqual(pppoe_service.router_status("active", 1, later, TODAY), "surfing")
        self.assertEqual(pppoe_service.router_status("active", 0, later, TODAY), "not_surfing")
        self.assertEqual(pppoe_service.router_status("expired", 0, earlier, TODAY), "expired")
        self.assertEqual(pppoe_service.router_status("expired", 1, earlier, TODAY), "expired_online")
        self.assertEqual(pppoe_service.router_status("active", 0, earlier, TODAY), "expired")
        self.assertEqual(pppoe_service.router_status("active", 1, later, TODAY, "disconnect"), "disconnecting")
        self.assertEqual(pppoe_service.router_status("active", 0, later, TODAY, "", "down"), "disconnected")
        self.assertEqual(pppoe_service.router_status("active", 1, later, TODAY, "", "down"), "disconnected")
        self.assertEqual(pppoe_service.router_status("suspended", 0, later, TODAY, "", "down"), "not_surfing")
        self.assertEqual(pppoe_service.router_status("expired", 0, earlier, TODAY, "", "down"), "expired")
        self.assertEqual(pppoe_service.router_status("pending_activation", 0, None, TODAY), "pending_activation")
        self.assertEqual(pppoe_service.router_status("suspended", 0, later, TODAY), "not_surfing")
        self.assertEqual(pppoe_service.analysis_bucket("suspended", 0, later, TODAY), "disconnected")
        self.assertEqual(pppoe_service.analysis_bucket("active", 0, later, TODAY, "", "down"), "disconnected")
        self.assertEqual(pppoe_service.analysis_bucket("expired", 1, earlier, TODAY), "expired")
        self.assertEqual(pppoe_service.analysis_bucket("active", 1, later, TODAY, "disconnect"), "disconnected")
        tallied = pppoe_service.tally_client_analysis(
            [
                {"service": "pppoe", "status": "active", "open_sessions": 1, "expiry_date": later, "last_action": ""},
                {"service": "hotspot", "status": "expired", "open_sessions": 0, "expiry_date": earlier, "last_action": ""},
                {"service": "hotspot", "status": "pending_activation", "open_sessions": 0, "expiry_date": None, "last_action": ""},
            ],
            TODAY,
        )
        self.assertEqual(tallied["pppoe"]["surfing"], 1)
        self.assertEqual(tallied["hotspot"]["expired"], 1)
        self.assertEqual(tallied["hotspot"]["notSurfing"], 1)

    def test_lifecycle_rules(self):
        self.assertEqual(pppoe_service.job_transition("pending_activation", TODAY, None, TODAY), "active")
        self.assertIsNone(pppoe_service.job_transition("active", TODAY, date(2026, 10, 20), TODAY))
        self.assertEqual(pppoe_service.job_transition("active", TODAY, date(2026, 10, 15), TODAY), "expired")
        self.assertFalse(pppoe_service.can_reactivate("overdue", False))
        self.assertTrue(pppoe_service.can_reactivate("overdue", True))
        self.assertEqual(pppoe_service.duplicate_session_action(1, 1), "reject_new")
        renewed = pppoe_service.renewal_dates(date(2026, 10, 20), "monthly", 0, 3, TODAY, True)
        self.assertEqual(renewed["nextDueDate"], "2026-11-20")
        self.assertIsNone(pppoe_service.renewal_dates(TODAY, "monthly", 0, 3, TODAY, False))

    def test_radius_replace_repeats_safely(self):
        checked = pppoe_service.validate_pppoe_provisioning(payload(), context(), TODAY)
        cursor = MemoryCursor()
        pppoe_store.write_radius(cursor, checked["normalized"]["username"], checked["normalized"])
        pppoe_store.write_radius(cursor, checked["normalized"]["username"], checked["normalized"])
        deletes = [sql for sql, _args in cursor.statements if sql.startswith("DELETE FROM radcheck")]
        inserts = [args for sql, args in cursor.statements if sql.startswith("INSERT INTO radcheck")]
        self.assertEqual(len(deletes), 2)
        self.assertGreaterEqual(len(inserts), 2)
        self.assertTrue(all(args[0] == "0712345678" for args in inserts))

    def test_coa_reaches_the_nas_that_holds_the_session(self):
        """A subscriber bound to a deleted router is still kicked on the NAS it actually dialed."""

        class SessionCursor(MemoryCursor):
            def fetchall(self):
                sql, _args = self.statements[-1]
                if sql.startswith("SELECT nasipaddress"):
                    return [{"nasipaddress": "10.88.0.2", "acctsessionid": "sess-1", "framedipaddress": "10.10.0.2"}]
                return []

            def fetchone(self):
                sql, _args = self.statements[-1]
                if sql.startswith("SELECT secret FROM nas"):
                    return {"secret": "nas-secret"}
                return None

        sent = []
        original = pppoe_store.send_disconnect
        pppoe_store.send_disconnect = lambda *args: sent.append(args) or "sent"
        try:
            result = pppoe_store.coa_for(SessionCursor(), {"router_id": "deleted-router"}, "254795606115")
        finally:
            pppoe_store.send_disconnect = original
        self.assertEqual(result, "sent")
        self.assertEqual(sent, [("10.88.0.2", "nas-secret", "254795606115", "sess-1", "10.10.0.2")])

    def test_coa_falls_back_to_the_assigned_router_without_a_live_session(self):
        class IdleCursor(MemoryCursor):
            def fetchall(self):
                return []

            def fetchone(self):
                sql, _args = self.statements[-1]
                if sql.startswith("SELECT secret_sealed"):
                    return {"secret_sealed": routeros_api.seal_password("router-secret"), "nasname": "10.88.0.9"}
                return None

        sent = []
        original = pppoe_store.send_disconnect
        pppoe_store.send_disconnect = lambda *args: sent.append(args) or "sent"
        try:
            result = pppoe_store.coa_for(IdleCursor(), {"router_id": "router-1"}, "254795606115")
        finally:
            pppoe_store.send_disconnect = original
        self.assertEqual(result, "sent")
        self.assertEqual(sent, [("10.88.0.9", "router-secret", "254795606115")])


if __name__ == "__main__":
    unittest.main()
