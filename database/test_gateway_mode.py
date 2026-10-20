"""Offline tests for gateway_mode resolution and the new access guards.

A FakeCursor answers the exact queries portal_server.daraja_settings and the
api.py guards run, so the whole matrix is exercised without MySQL.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import api
import portal_server
import routeros_api


def sealed(value):
    return routeros_api.seal_password(value)


class FakeCursor:
    """Routes flat SQL to canned row sets by the table name it reads."""

    def __init__(
        self,
        payout=None,
        settings=None,
        company=None,
        session=None,
        employee=None,
        client_status=None,
    ):
        self.payout = payout  # dict or None: isp_payout_settings row
        self.settings = settings or []  # isp_payment_settings rows
        self.company = company  # company_daraja_settings row
        self.session = session  # isp_sessions row
        self.employee = employee  # isp_employees row
        self.client_status = client_status or "approved"
        self._result = []
        self.statements = []

    def execute(self, sql, args=None):
        flat = " ".join(str(sql).split())
        self.statements.append(flat)
        self._result = []
        if "FROM isp_payout_settings" in flat:
            self._result = [self.payout] if self.payout else []
        elif "FROM isp_payment_settings" in flat:
            self._result = list(self.settings)
        elif "FROM company_daraja_settings" in flat:
            self._result = [self.company] if self.company else []
        elif "FROM isp_sessions" in flat:
            self._result = [self.session] if self.session else []
        elif "FROM isp_employees" in flat:
            self._result = [self.employee] if self.employee else []
        elif "FROM isp_clients" in flat:
            self._result = [{"status": self.client_status}]
        return 1

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


def isp_row(scope, secret="secret", passkey="pass", **overrides):
    row = {
        "scope": scope,
        "environment": "sandbox",
        "account_type": "paybill",
        "short_code": "600000",
        "consumer_key": f"key-{scope}",
        "consumer_secret": sealed(secret),
        "passkey": sealed(passkey),
        "callback_url": "",
    }
    row.update(overrides)
    return row


def company_row(**overrides):
    row = {
        "environment": "live",
        "account_type": "paybill",
        "short_code": "700000",
        "consumer_key": "company-key",
        "consumer_secret": sealed("company-secret"),
        "passkey": sealed("company-pass"),
    }
    row.update(overrides)
    return row


class DarajaSettingsTests(unittest.TestCase):
    """The portal must pick the same row it did before gateway_mode existed,
    for every backfill outcome — no payment behavior may change."""

    def test_no_payout_row_keeps_legacy_selection(self):
        cursor = FakeCursor(
            payout=None,
            settings=[isp_row("own"), isp_row("company")],
        )
        row = portal_server.daraja_settings(cursor, "client-1")
        self.assertEqual(row["scope"], "own")
        self.assertEqual(row["consumer_secret"], "secret")

    def test_own_daraja_matches_legacy_for_own_scope(self):
        cursor = FakeCursor(
            payout={"gateway_mode": "own_daraja"},
            settings=[isp_row("own"), isp_row("company")],
        )
        row = portal_server.daraja_settings(cursor, "client-1")
        self.assertEqual(row["scope"], "own")

    def test_own_daraja_matches_legacy_for_company_scope(self):
        """Backfilled ISPs holding only a company-scoped row keep using it."""
        cursor = FakeCursor(
            payout={"gateway_mode": "own_daraja"},
            settings=[isp_row("company")],
        )
        row = portal_server.daraja_settings(cursor, "client-1")
        self.assertEqual(row["scope"], "company")
        self.assertEqual(row["consumer_secret"], "secret")

    def test_none_returns_nothing(self):
        cursor = FakeCursor(
            payout={"gateway_mode": "none"},
            settings=[isp_row("own"), isp_row("company")],
        )
        self.assertIsNone(portal_server.daraja_settings(cursor, "client-1"))

    def test_company_gateway_uses_server_side_credentials(self):
        """The ISP's own company-scoped row is never read in pooled mode —
        company credentials come only from company_daraja_settings."""
        cursor = FakeCursor(
            payout={"gateway_mode": "company_gateway"},
            settings=[isp_row("company", secret="isp-held-copy")],
            company=company_row(),
        )
        row = portal_server.daraja_settings(cursor, "client-1")
        self.assertEqual(row["scope"], "company")
        self.assertEqual(row["consumer_secret"], "company-secret")
        self.assertEqual(row["short_code"], "700000")
        self.assertFalse(
            any("FROM isp_payment_settings" in sql for sql in cursor.statements),
            "company_gateway must not read isp_payment_settings",
        )

    def test_company_gateway_without_config_returns_none(self):
        cursor = FakeCursor(
            payout={"gateway_mode": "company_gateway"},
            settings=[isp_row("own")],
            company=None,
        )
        self.assertIsNone(portal_server.daraja_settings(cursor, "client-1"))


class DirectorGuardTests(unittest.TestCase):
    def test_requires_an_employee_session(self):
        with self.assertRaises(api.ApiError) as caught:
            api.require_director(FakeCursor(session=None), "tok")
        self.assertEqual(caught.exception.status, 401)

    def test_pending_employee_rejected(self):
        cursor = FakeCursor(
            session={"account_id": "e1", "opened_by": None},
            employee={"status": "pending", "role": "director"},
        )
        with self.assertRaises(api.ApiError) as caught:
            api.require_director(cursor, "tok")
        self.assertEqual(caught.exception.status, 403)

    def test_non_director_rejected(self):
        for role in ("supervisor", "it-support", "customer-care", "technician", "sales", None):
            cursor = FakeCursor(
                session={"account_id": "e1", "opened_by": None},
                employee={"status": "approved", "role": role},
            )
            with self.assertRaises(api.ApiError) as caught:
                api.require_director(cursor, "tok")
            self.assertEqual(caught.exception.status, 403, role)

    def test_director_passes(self):
        cursor = FakeCursor(
            session={"account_id": "e1", "opened_by": None},
            employee={"status": "approved", "role": "director"},
        )
        self.assertEqual(api.require_director(cursor, "tok"), "e1")


class OwnerGuardTests(unittest.TestCase):
    def test_requires_a_client_session(self):
        with self.assertRaises(api.ApiError) as caught:
            api.require_owner_client(FakeCursor(session=None), "tok")
        self.assertEqual(caught.exception.status, 401)

    def test_pending_client_rejected(self):
        cursor = FakeCursor(
            session={"account_id": "c1", "opened_by": None},
            client_status="pending",
        )
        with self.assertRaises(api.ApiError) as caught:
            api.require_owner_client(cursor, "tok")
        self.assertEqual(caught.exception.status, 403)

    def test_staff_opened_session_is_read_only(self):
        cursor = FakeCursor(
            session={"account_id": "c1", "opened_by": "employee-9"},
            client_status="approved",
        )
        with self.assertRaises(api.ApiError) as caught:
            api.require_owner_client(cursor, "tok")
        self.assertEqual(caught.exception.status, 403)

    def test_owner_passes(self):
        cursor = FakeCursor(
            session={"account_id": "c1", "opened_by": None},
            client_status="approved",
        )
        self.assertEqual(api.require_owner_client(cursor, "tok"), "c1")


if __name__ == "__main__":
    unittest.main()
