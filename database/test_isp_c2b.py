"""Offline tests for optional ISP-owned C2B auto-credit."""

import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pymysql

import gateway_crypto
import isp_c2b


class UniqueViolation(pymysql.MySQLError):
    pass


class MiniDb:
    def __init__(self):
        self.tables = {}

    def table(self, name):
        return self.tables.setdefault(name, [])

    def insert(self, name, **row):
        self.table(name).append(row)
        return row

    def cursor(self):
        return MiniCursor(self)


class MiniCursor:
    def __init__(self, db):
        self.db = db
        self._result = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, args=None):
        flat = " ".join(str(sql).split())
        args = tuple(args or ())
        self._result = []
        self.rowcount = 0
        d = self.db

        if flat.startswith("SHOW COLUMNS"):
            self._result = [{"Field": "present"}]
        elif flat.startswith("CREATE TABLE"):
            self.rowcount = 0
        elif flat.startswith("ALTER TABLE"):
            self.rowcount = 0
        elif flat.startswith("INSERT INTO isp_payout_settings"):
            client_id = args[0]
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == client_id]
            if not rows:
                row = {"client_id": client_id, "gateway_mode": "own_daraja", "c2b_enabled": 0}
                if len(args) > 1:
                    row["c2b_secret_enc"] = args[1]
                d.table("isp_payout_settings").append(row)
            elif len(args) > 1:
                rows[0]["c2b_secret_enc"] = args[1]
            self.rowcount = 1
        elif flat.startswith("UPDATE isp_payout_settings SET c2b_enabled"):
            for row in d.table("isp_payout_settings"):
                if row["client_id"] == args[1]:
                    row["c2b_enabled"] = args[0]
                    self.rowcount = 1
        elif flat.startswith("UPDATE isp_payout_settings") and "c2b_registered_at" in flat:
            for row in d.table("isp_payout_settings"):
                if row["client_id"] == args[2]:
                    row["c2b_registered_at"] = "now"
                    row["c2b_register_ok"] = args[0]
                    row["c2b_register_detail"] = args[1]
                    self.rowcount = 1
        elif "FROM isp_payout_settings" in flat and "c2b_secret_enc" in flat and "c2b_enabled" in flat and "WHERE c2b_secret" in flat:
            self._result = [
                {
                    "client_id": r["client_id"],
                    "c2b_secret_enc": r.get("c2b_secret_enc"),
                    "c2b_enabled": r.get("c2b_enabled", 0),
                }
                for r in d.table("isp_payout_settings")
                if r.get("c2b_secret_enc")
            ]
        elif "SELECT c2b_secret_enc FROM isp_payout_settings" in flat:
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [{"c2b_secret_enc": rows[0].get("c2b_secret_enc")}] if rows else []
        elif "FROM isp_payout_settings WHERE client_id" in flat:
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [dict(rows[0])] if rows else []
        elif "FROM pppoe_subscribers" in flat and "LIKE CONCAT" in flat:
            ref = str(args[-1] if len(args) > 1 else args[0]).lower()
            client = args[0] if len(args) > 1 else None
            matches = []
            for sub in d.table("pppoe_subscribers"):
                if client and sub.get("client_id") != client:
                    continue
                if int(sub.get("deleted") or 0):
                    continue
                if str(sub.get("pppoe_username") or "").lower().startswith(ref):
                    matches.append(
                        {
                            "subscriber_id": sub["id"],
                            "id": sub["id"],
                            "client_id": sub["client_id"],
                            "pppoe_username": sub["pppoe_username"],
                            "package_id": sub.get("package_id"),
                        }
                    )
            self._result = matches[:5]
        elif "FROM pppoe_subscribers" in flat:
            ref = str(args[-1] if len(args) > 1 else args[0]).lower()
            client = args[0] if len(args) > 1 else None
            matches = []
            for sub in d.table("pppoe_subscribers"):
                if client and sub.get("client_id") != client:
                    continue
                if int(sub.get("deleted") or 0):
                    continue
                if str(sub.get("pppoe_username") or "").lower() == ref:
                    matches.append(
                        {
                            "subscriber_id": sub["id"],
                            "id": sub["id"],
                            "client_id": sub["client_id"],
                            "pppoe_username": sub["pppoe_username"],
                            "package_id": sub.get("package_id"),
                        }
                    )
            self._result = matches[:2]
        elif flat.startswith("INSERT INTO isp_c2b_payments"):
            if any(p.get("mpesa_receipt") == args[5] for p in d.table("isp_c2b_payments")):
                raise UniqueViolation("receipt")
            d.table("isp_c2b_payments").append(
                {
                    "id": args[0],
                    "client_id": args[1],
                    "subscriber_id": args[2],
                    "msisdn": args[3],
                    "amount": args[4],
                    "mpesa_receipt": args[5],
                    "account_reference": args[6],
                    "status": args[7],
                    "reason": args[8],
                    "raw_callback": args[9],
                    "created_at": "now",
                }
            )
            self.rowcount = 1
        elif flat.startswith("UPDATE isp_payment_settings"):
            self.rowcount = 1
        elif flat.startswith("UPDATE isp_c2b_payments"):
            for row in d.table("isp_c2b_payments"):
                if row["id"] == args[1]:
                    row["reason"] = args[0]
                    self.rowcount = 1
        elif "FROM isp_c2b_payments WHERE client_id" in flat and "SUM" in flat:
            matched = sum(
                1
                for p in d.table("isp_c2b_payments")
                if p["client_id"] == args[0] and p["status"] == "confirmed"
            )
            unmatched = sum(
                1
                for p in d.table("isp_c2b_payments")
                if p["client_id"] == args[0] and p["status"] == "unmatched"
            )
            self._result = [{"matched": matched, "unmatched": unmatched}]
        elif "FROM isp_c2b_payments WHERE client_id" in flat:
            self._result = [dict(p) for p in d.table("isp_c2b_payments") if p["client_id"] == args[0]]
        elif "SELECT public_base FROM company_daraja_settings" in flat:
            rows = d.table("company_daraja_settings")
            self._result = [{"public_base": (rows[0].get("public_base") if rows else "") or ""}]
        return 1

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


class FakeConnect:
    def __init__(self, db):
        self.db = db

    def __call__(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return MiniCursor(self.db)

    def commit(self):
        pass


class RouteTests(unittest.TestCase):
    def test_parses_isp_endpoints(self):
        secret, endpoint = isp_c2b.route("/api/daraja/isp/tok123/c2b/confirmation")
        self.assertEqual(secret, "tok123")
        self.assertEqual(endpoint, "c2b/confirmation")

    def test_rejects_company_style_paths(self):
        self.assertIsNone(isp_c2b.route("/api/daraja/tok123/c2b/confirmation"))


class OptInTests(unittest.TestCase):
    def test_disabled_by_default_and_secret_gated(self):
        db = MiniDb()
        sealed = gateway_crypto.seal("secret-a")
        db.insert(
            "isp_payout_settings",
            client_id="c1",
            gateway_mode="own_daraja",
            c2b_enabled=0,
            c2b_secret_enc=sealed,
        )
        self.assertIsNone(isp_c2b.client_for_secret(db.cursor(), "secret-a"))
        isp_c2b.set_enabled(db.cursor(), "c1", True)
        self.assertEqual(isp_c2b.client_for_secret(db.cursor(), "secret-a"), "c1")

    def test_match_and_renew(self):
        db = MiniDb()
        db.insert(
            "isp_payout_settings",
            client_id="c1",
            gateway_mode="own_daraja",
            c2b_enabled=1,
        )
        db.insert(
            "pppoe_subscribers",
            id="sub-1",
            client_id="c1",
            pppoe_username="john",
            package_id="pkg-1",
            deleted=0,
            service="pppoe",
        )
        with patch("pppoe_store.renew") as renew:
            isp_c2b.process_confirmation(
                FakeConnect(db),
                "c1",
                {
                    "TransID": "ISP001",
                    "TransAmount": "500.00",
                    "MSISDN": "254700111222",
                    "BillRefNumber": "john",
                },
            )
            renew.assert_called_once()
        row = db.table("isp_c2b_payments")[0]
        self.assertEqual(row["status"], "confirmed")
        self.assertEqual(row["subscriber_id"], "sub-1")

    def test_unknown_ref_unmatched(self):
        db = MiniDb()
        db.insert("isp_payout_settings", client_id="c1", gateway_mode="own_daraja", c2b_enabled=1)
        with patch("pppoe_store.renew") as renew:
            isp_c2b.process_confirmation(
                FakeConnect(db),
                "c1",
                {"TransID": "ISP002", "TransAmount": "100.00", "BillRefNumber": "ghost"},
            )
            renew.assert_not_called()
        self.assertEqual(db.table("isp_c2b_payments")[0]["status"], "unmatched")
        self.assertIn("No PPPoE username matches", db.table("isp_c2b_payments")[0]["reason"])

    def test_health_reports_optional_off(self):
        db = MiniDb()
        db.insert(
            "isp_payout_settings",
            client_id="c1",
            gateway_mode="own_daraja",
            c2b_enabled=0,
            c2b_register_ok=0,
            c2b_register_detail="",
        )
        db.insert("company_daraja_settings", id=1, public_base="https://pay.example.com")
        health = isp_c2b.health(
            db.cursor(),
            "c1",
            {"account_type": "paybill", "short_code": "123456"},
        )
        self.assertTrue(health["optional"])
        self.assertFalse(health["enabled"])
        self.assertFalse(health["ready"])

    def test_invalid_access_token_explains_missing_c2b_product(self):
        detail = isp_c2b._explain_register_error("Error Occurred - Invalid Access Token -", "live")
        self.assertIn("Customer to Business Register URL", detail)
        self.assertIn("live", detail)


if __name__ == "__main__":
    unittest.main()
