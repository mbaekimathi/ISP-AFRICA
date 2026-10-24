import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

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


class VoucherCursor:
    """Minimal fake covering the pppoe_vouchers queries the helpers run."""

    def __init__(self):
        self.vouchers = {}
        self.subscribers = {
            "sub-1": {"pppoe_username": "0712345678", "first_name": "Amina", "last_name": "Wanjiku"},
        }
        self.rowcount = 0
        self._result = []
        self.statements = []

    def execute(self, sql, args=None):
        args = list(args or [])
        flat = " ".join(sql.split())
        self.statements.append(flat)
        self._result = []
        if flat.startswith("UPDATE pppoe_vouchers"):
            wanted = set(args)
            count = 0
            for voucher in self.vouchers.values():
                owner = self.subscribers.get(voucher["subscriber_id"], {})
                if voucher["status"] == "issued" and owner.get("pppoe_username") in wanted:
                    voucher["status"] = "used"
                    count += 1
            self.rowcount = count
        elif flat.startswith("INSERT INTO pppoe_vouchers"):
            vid, client_id, subscriber_id, stk_id, package_id, package_name, code, amount, checkout = args
            self.vouchers[vid] = {
                "id": vid,
                "subscriber_id": subscriber_id,
                "package_name": package_name,
                "code": code,
                "amount": amount,
                "checkout_id": checkout,
                "status": "issued",
            }
        elif flat.startswith("SELECT id FROM pppoe_vouchers WHERE code"):
            self._result = [{"id": v["id"]} for v in self.vouchers.values() if v["code"] == args[0]]
        elif flat.startswith("SELECT id, code, status FROM pppoe_vouchers"):
            self._result = [
                {"id": v["id"], "code": v["code"], "status": v["status"]}
                for v in self.vouchers.values()
                if v["checkout_id"] == args[0]
            ]
        elif flat.startswith("SELECT v.code, v.amount, v.status, v.issued_at, v.used_at"):
            self._result = [
                {
                    "code": v["code"],
                    "amount": v["amount"],
                    "status": v["status"],
                    "issued_at": None,
                    "used_at": None,
                    "package_name": v["package_name"] or "Subscription",
                    "first_name": self.subscribers[v["subscriber_id"]]["first_name"],
                    "last_name": self.subscribers[v["subscriber_id"]]["last_name"],
                    "pppoe_username": self.subscribers[v["subscriber_id"]]["pppoe_username"],
                }
                for v in self.vouchers.values()
                if v["code"] == args[0]
            ]

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


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
        self.assertNotIn("Session-Timeout", [row["attribute"] for row in built["replies"]])
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
        # An active client whose CPE held a session before and dropped it is
        # disconnected, even while the management tunnel still answers.
        self.assertEqual(pppoe_service.router_status("active", 0, later, TODAY, "", "up", True), "disconnected")
        # An open radacct session is proof the tunnel works — a flapping
        # management check must not mask a live session as disconnected.
        self.assertEqual(pppoe_service.router_status("active", 1, later, TODAY, "", "down"), "surfing")
        self.assertEqual(pppoe_service.router_status("suspended", 0, later, TODAY, "", "down"), "suspended")
        self.assertEqual(pppoe_service.router_status("expired", 0, earlier, TODAY, "", "down"), "expired")
        self.assertEqual(pppoe_service.router_status("pending_activation", 0, None, TODAY), "pending_activation")
        self.assertEqual(pppoe_service.router_status("suspended", 0, later, TODAY), "suspended")
        self.assertEqual(pppoe_service.router_status("suspended", 1, later, TODAY), "suspended_online")
        self.assertEqual(pppoe_service.router_status("disconnected", 0, later, TODAY), "expired")
        self.assertEqual(pppoe_service.router_status("disconnected", 1, later, TODAY), "expired_online")
        self.assertEqual(pppoe_service.router_status("cancelled", 0, later, TODAY), "expired")
        self.assertEqual(pppoe_service.analysis_bucket("suspended", 0, later, TODAY), "disconnected")
        self.assertEqual(pppoe_service.analysis_bucket("suspended", 1, later, TODAY), "disconnected")
        self.assertEqual(pppoe_service.analysis_bucket("disconnected", 0, later, TODAY), "expired")
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


class RerateTests(unittest.TestCase):
    """A package change on a surfing client re-rates the session instead of hanging it up."""

    class Cursor:
        def __init__(self, sessions):
            self.sessions = sessions
            self.last = ""

        def execute(self, sql, args=None):
            self.last = sql

        def fetchall(self):
            return self.sessions

        def fetchone(self):
            return {"secret": "nas-secret"}

    def rerate(self, coa_outcome):
        calls = []
        sessions = [{"nasipaddress": "10.88.0.5", "acctsessionid": "81a00001", "framedipaddress": "10.10.0.9"}]
        original = (pppoe_store.send_rate_change, pppoe_store.send_disconnect)
        pppoe_store.send_rate_change = lambda *args: calls.append(("coa", args)) or coa_outcome
        pppoe_store.send_disconnect = lambda *args: calls.append(("disconnect", args)) or "sent"
        try:
            result = pppoe_store.rerate_sessions(self.Cursor(sessions), {"router_id": "r1"}, "0712345678", "10M/20M")
        finally:
            pppoe_store.send_rate_change, pppoe_store.send_disconnect = original
        return result, calls

    def test_acked_coa_keeps_the_session(self):
        result, calls = self.rerate("sent")
        self.assertEqual(result, "updated")
        self.assertEqual([kind for kind, _ in calls], ["coa"])
        self.assertEqual(calls[0][1], ("10.88.0.5", "nas-secret", "0712345678", "10M/20M", "81a00001", "10.10.0.9"))

    def test_refused_coa_falls_back_to_a_disconnect(self):
        result, calls = self.rerate("refused")
        self.assertEqual(result, "reconnected")
        self.assertEqual([kind for kind, _ in calls], ["coa", "disconnect"])

    def test_no_open_session_needs_nothing(self):
        result = pppoe_store.rerate_sessions(self.Cursor([]), {"router_id": "r1"}, "0712345678", "10M/20M")
        self.assertEqual(result, "unchanged")

    def test_rate_change_packet_carries_mikrotik_rate_limit(self):
        import socket as socket_module

        captured = {}

        class FakeUdp:
            def settimeout(self, _seconds):
                pass

            def sendto(self, packet, address):
                captured["packet"], captured["address"] = packet, address

            def recvfrom(self, _size):
                return bytes([44]), None

            def close(self):
                pass

        original = socket_module.socket
        socket_module.socket = lambda *_args: FakeUdp()
        try:
            outcome = pppoe_store.send_rate_change("10.88.0.5", "nas-secret", "0712345678", "10M/20M")
        finally:
            socket_module.socket = original
        self.assertEqual(outcome, "sent")
        self.assertEqual(captured["address"], ("10.88.0.5", 3799))
        self.assertEqual(captured["packet"][0], pppoe_store.COA_REQUEST)
        self.assertIn((14988).to_bytes(4, "big") + bytes([8, 9]) + b"10M/20M", captured["packet"])


class VoucherTests(unittest.TestCase):
    def test_voucher_code_is_readable_and_unambiguous(self):
        code = pppoe_store.voucher_code()
        self.assertRegex(code, r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$")
        self.assertNotIn("0", code)
        self.assertNotIn("1", code)
        self.assertNotEqual(code, pppoe_store.voucher_code())

    def test_issue_voucher_is_idempotent_per_checkout(self):
        cursor = VoucherCursor()
        first = pppoe_store.issue_voucher(
            cursor,
            "client-1",
            "sub-1",
            {"checkoutId": "ws_1", "stkRequestId": "stk-1", "packageId": "pkg-1", "packageName": "Home 10", "amount": "500.00"},
        )
        again = pppoe_store.issue_voucher(cursor, "client-1", "sub-1", {"checkoutId": "ws_1", "amount": "500.00"})
        self.assertEqual(first["code"], again["code"])
        self.assertEqual(first["status"], "issued")
        inserts = [sql for sql in cursor.statements if sql.startswith("INSERT INTO pppoe_vouchers")]
        self.assertEqual(len(inserts), 1)

    def test_voucher_is_spent_once_the_subscriber_is_online(self):
        cursor = VoucherCursor()
        voucher = pppoe_store.issue_voucher(cursor, "client-1", "sub-1", {"checkoutId": "ws_2", "amount": "500.00"})
        self.assertEqual(pppoe_store.mark_vouchers_used(cursor, ["someone-else@isp"]), 0)
        self.assertEqual(pppoe_store.voucher_for_checkout(cursor, "ws_2")["status"], "issued")
        self.assertEqual(pppoe_store.mark_vouchers_used(cursor, ["0712345678@isp", "0712345678"]), 1)
        # A spent voucher can never be consumed again.
        self.assertEqual(pppoe_store.mark_vouchers_used(cursor, ["0712345678"]), 0)
        detail = pppoe_store.voucher_detail(cursor, voucher["code"])
        self.assertEqual(detail["status"], "used")
        self.assertEqual(detail["package_name"], "Subscription")
        self.assertIsNone(pppoe_store.voucher_detail(cursor, "ZZZZ-ZZZZ-ZZZZ"))


class DarajaCallbackTests(unittest.TestCase):
    def test_parse_extracts_the_real_mpesa_code(self):
        payload = {
            "Body": {
                "stkCallback": {
                    "CheckoutRequestID": "ws_CO_17102026_123456",
                    "ResultCode": 0,
                    "ResultDesc": "The service request is processed successfully.",
                    "CallbackMetadata": {
                        "Item": [
                            {"Name": "Amount", "Value": 500},
                            {"Name": "MpesaReceiptNumber", "Value": "TJK4H2ABCD"},
                            {"Name": "TransactionDate", "Value": 20261017120000},
                            {"Name": "PhoneNumber", "Value": 254712345678},
                        ]
                    },
                }
            }
        }
        checkout_id, code, desc, receipt, phone = pppoe_store.parse_daraja_callback(payload)
        self.assertEqual(checkout_id, "ws_CO_17102026_123456")
        self.assertEqual(code, 0)
        self.assertEqual(receipt, "TJK4H2ABCD")
        self.assertEqual(phone, "254712345678")

    def test_parse_handles_a_declined_callback(self):
        payload = {
            "Body": {
                "stkCallback": {
                    "CheckoutRequestID": "ws_CO_999",
                    "ResultCode": 1032,
                    "ResultDesc": "Request cancelled by user",
                }
            }
        }
        checkout_id, code, desc, receipt, _ = pppoe_store.parse_daraja_callback(payload)
        self.assertEqual(code, 1032)
        self.assertEqual(receipt, "")
        self.assertIn("cancelled", desc)


class RenewConn:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0

    def begin(self):
        return None

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class RenewCursor:
    """Serves just the reads renew() runs and records every write."""

    def __init__(self, subscriber, package=None):
        self.subscriber = subscriber
        self.package = package
        self.statements = []
        self._one = None
        self.connection = RenewConn()

    def execute(self, sql, args=None):
        flat = " ".join(sql.split())
        self.statements.append((flat, list(args or [])))
        self._one = None
        if flat.startswith("SELECT s.*, sub.id AS subscription_id"):
            self._one = dict(self.subscriber)
        elif flat.startswith("SELECT COUNT(*) AS open_sessions"):
            self._one = {"open_sessions": 0}
        elif flat.startswith("SELECT COUNT(*) AS any_sessions"):
            self._one = {"any_sessions": 1}
        elif flat.startswith("SELECT id, name, price, download_mbps"):
            self._one = dict(self.package) if self.package else None

    def fetchone(self):
        return self._one

    def fetchall(self):
        return []

    def ran(self, prefix):
        return [args for flat, args in self.statements if flat.startswith(prefix)]


def subless_row(**extra):
    """require_owned output for a subscriber with no pppoe_subscriptions row."""
    row = {
        "id": "sub-1",
        "client_id": "client-1",
        "pppoe_username": "amina-home",
        "status": "active",
        "package_id": "pkg-1",
        "start_date": date(2026, 9, 1),
        "password_sealed": "",
        "session_limit": 1,
        "static_ip": None,
        "router_id": "router-1",
        "subscription_id": None,
        "billing_status": None,
        "expiry_date": None,
        "price": None,
        "next_due_date": None,
        "billing_cycle": None,
        "cycle_days": None,
        "grace_days": None,
        "auto_renew": None,
        "discount": None,
        "discount_reason": None,
        "sub_start": None,
        "package_name": None,
        "download_mbps": None,
        "upload_mbps": None,
        "package_devices": None,
        "router_name": "Router",
        "tunnel_status": "up",
        "tunnel_ip": "10.88.0.5",
        "api_secret": "sealed",
        "last_action": "",
    }
    row.update(extra)
    return row


PACKAGE = {
    "id": "pkg-1",
    "name": "Home 10",
    "price": "500.00",
    "download_mbps": 10,
    "upload_mbps": 5,
    "status": "active",
    "availability_routers": "[]",
    "simultaneous_devices": 2,
}


class RenewHealTests(unittest.TestCase):
    def test_renew_recreates_a_missing_subscription_row(self):
        cursor = RenewCursor(subless_row(), PACKAGE)
        with patch("pppoe_store.apply_plan", return_value={}) as plan, patch(
            "pppoe_store.coa_for", return_value="queued"
        ), patch("pppoe_store.subscriber_detail", return_value={"id": "sub-1"}):
            body = pppoe_store.renew(
                cursor,
                "client-1",
                "sub-1",
                {"amount": "500.00", "mpesaReference": "TJK4H2ABCD", "packageId": "pkg-1"},
            )
        inserts = cursor.ran("INSERT INTO pppoe_subscriptions")
        self.assertEqual(len(inserts), 1)
        self.assertEqual(inserts[0][1], "sub-1")
        self.assertEqual(inserts[0][2], "pkg-1")
        self.assertEqual(inserts[0][3], "500.00")
        updates = cursor.ran("UPDATE pppoe_subscriptions SET next_due_date")
        self.assertEqual(len(updates), 1)
        self.assertEqual(cursor.ran("UPDATE pppoe_subscribers SET status = 'active'"), [["sub-1"]])
        # A full-price payment on a healed 30-day cycle buys 30 days.
        self.assertEqual(body["daysPurchased"], 30)
        plan.assert_called_once()
        self.assertTrue(plan.call_args[0][2])
        self.assertEqual(cursor.connection.commits, 1)

    def test_renew_without_any_package_is_rejected(self):
        cursor = RenewCursor(subless_row(package_id=None))
        with patch("pppoe_store.apply_plan"), patch("pppoe_store.coa_for"), patch("pppoe_store.subscriber_detail"):
            with self.assertRaises(pppoe_store.PppoeError) as raised:
                pppoe_store.renew(cursor, "client-1", "sub-1", {"amount": "500.00"})
        self.assertIn("package", str(raised.exception).lower())
        self.assertEqual(cursor.ran("INSERT INTO pppoe_subscriptions"), [])

    def test_renew_falls_back_to_the_paid_price(self):
        # The isp_packages row is gone too — the amount paid prices the cycle
        # so a received payment is never stranded.
        cursor = RenewCursor(subless_row(package_id="pkg-gone"))
        with patch("pppoe_store.apply_plan", return_value={}), patch(
            "pppoe_store.coa_for", return_value="queued"
        ), patch("pppoe_store.subscriber_detail", return_value={"id": "sub-1"}):
            body = pppoe_store.renew(
                cursor,
                "client-1",
                "sub-1",
                {"amount": "300.00", "packageId": "pkg-gone", "packagePrice": "300.00"},
            )
        inserts = cursor.ran("INSERT INTO pppoe_subscriptions")
        self.assertEqual(inserts[0][2], "pkg-gone")
        self.assertEqual(inserts[0][3], "300.00")
        self.assertEqual(body["daysPurchased"], 30)

    def test_require_owned_uses_left_joins(self):
        cursor = RenewCursor(subless_row())
        row = pppoe_store.require_owned(cursor, "client-1", "sub-1")
        self.assertEqual(row["id"], "sub-1")
        self.assertIsNone(row["subscription_id"])
        joined = " ".join(flat for flat, _ in cursor.statements)
        self.assertIn("LEFT JOIN pppoe_subscriptions", joined)
        self.assertIn("LEFT JOIN isp_packages", joined)


if __name__ == "__main__":
    unittest.main()
