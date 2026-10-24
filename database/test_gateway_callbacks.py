"""Offline tests for the gateway callback pipeline.

A stateful MiniDb answers the exact SQL gateway_store/gateway_callbacks run,
so the full confirm-and-credit matrix executes with no MySQL and no network.
Live-DB uniqueness/locking is covered separately by test_gateway_db.py.
"""

import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pymysql

import gateway_callbacks
import gateway_crypto
import gateway_store


def _clone(row):
    return dict(row) if row else None


class MiniDb:
    """Tiny relational store keyed by table name; rows are dicts."""

    def __init__(self):
        self.tables = {}
        self.rowcount = 0

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

    # context-manager + contextlib-free fake connection helpers
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

        # --- gateway_payments -------------------------------------------------
        if flat.startswith("INSERT INTO gateway_payments"):
            if "checkout_id" in flat:
                (pid, client, source, sub, hs, msisdn, amount, checkout) = args
                self.insert_payment(pid, client, source, amount, checkout,
                                    msisdn=msisdn, subscriber=sub, hotspot=hs, status="initiated")
            else:
                (pid, msisdn, amount, receipt, ref, raw) = args
                if any(p.get("mpesa_receipt") == receipt for p in d.table("gateway_payments")):
                    raise UniqueViolation("mpesa_receipt")
                self.insert_payment(pid, None, "manual", amount, None, msisdn=msisdn,
                                    receipt=receipt, ref=ref, raw=raw, status="unmatched",
                                    channel="c2b")
            self.rowcount = 1
        elif flat.startswith("UPDATE gateway_payments") and "SET status = 'unmatched'" in flat:
            row = self.find_payment(id=args[-1])
            self._apply(row, status="unmatched",
                        mpesa_receipt=args[0] or row.get("mpesa_receipt"),
                        msisdn=args[1] or row.get("msisdn"), raw_callback=args[2])
        elif flat.startswith("UPDATE gateway_payments") and "SET status = 'confirmed'" in flat:
            row = self.find_payment(id=args[-1])
            self._apply(row, status="confirmed",
                        mpesa_receipt=args[0] or row.get("mpesa_receipt"),
                        msisdn=args[1] or row.get("msisdn"), raw_callback=args[2],
                        confirmed_at="now")
        elif flat.startswith("UPDATE gateway_payments") and "SET status = %s" in flat:
            status, raw, checkout = args
            for row in d.table("gateway_payments"):
                if row.get("checkout_id") == checkout and row["status"] in ("initiated", "unmatched"):
                    row["status"] = status
                    row["last_verified_at"] = "now"
                    row["raw_callback"] = raw or row.get("raw_callback")
                    self.rowcount += 1
        elif flat.startswith("UPDATE gateway_payments SET last_verified_at"):
            for row in d.table("gateway_payments"):
                if row.get("checkout_id") == args[0]:
                    row["last_verified_at"] = "now"
                    self.rowcount += 1
        elif "status IN ('failed', 'cancelled')" in flat and "FROM gateway_payments" in flat:
            rows = [
                p for p in d.table("gateway_payments")
                if p.get("status") in ("failed", "cancelled")
                and p.get("checkout_id") and not p.get("last_verified_at")
            ]
            self._result = [
                {"id": p["id"], "client_id": p["client_id"],
                 "checkout_id": p["checkout_id"], "created_at": p.get("created_at")}
                for p in rows
            ]
        elif "FROM gateway_payments" in flat and "checkout_id" in flat:
            row = self.find_payment(checkout=args[-1])
            self._result = [_clone(row)] if row else []
        elif flat.startswith("SELECT id, client_id, checkout_id, created_at\n") or "stale" in flat:
            self._result = []
        elif "FROM gateway_payments WHERE checkout_id" in flat:
            row = self.find_payment(checkout=args[0])
            self._result = [_clone(row)] if row else []

        # --- ledger / payouts / settings ------------------------------------
        elif flat.startswith("INSERT INTO gateway_ledger_entries"):
            if len(args) == 6:
                lid, client, payout, kind, amount, balance = args
                if any(e.get("payout_id") == payout and e.get("type") == kind
                       for e in d.table("gateway_ledger_entries")):
                    raise UniqueViolation("ledger-payout")
                d.table("gateway_ledger_entries").append(
                    {"id": lid, "client_id": client, "payment_id": None, "payout_id": payout,
                     "type": kind, "amount": amount, "balance_after": balance})
            else:
                lid, client, payment, amount, balance = args
                if any(e.get("payment_id") == payment and e.get("type") == "collection"
                       for e in d.table("gateway_ledger_entries")):
                    raise UniqueViolation("ledger-payment")
                d.table("gateway_ledger_entries").append(
                    {"id": lid, "client_id": client, "payment_id": payment, "payout_id": None,
                     "type": "collection", "amount": amount, "balance_after": balance})
            self.rowcount = 1
        elif flat.startswith("SELECT balance_after FROM gateway_ledger_entries"):
            entries = [e for e in d.table("gateway_ledger_entries") if e["client_id"] == args[0]]
            self._result = [{"balance_after": entries[-1]["balance_after"]}] if entries else []
        elif flat.startswith("SELECT client_id FROM isp_payout_settings"):
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else [{"client_id": args[0]}]
        elif flat.startswith("SELECT * FROM settlement_batches"):
            rows = [b for b in d.table("settlement_batches") if b["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("SELECT id, amount FROM gateway_payouts"):
            rows = [p for p in d.table("gateway_payouts") if p.get("batch_id") == args[0]]
            self._result = [{"id": p["id"], "amount": p.get("amount")} for p in rows]
        elif flat.startswith("SELECT status, COUNT"):
            groups = {}
            for p in d.table("gateway_payouts"):
                if p.get("batch_id") == args[0]:
                    groups[p["status"]] = groups.get(p["status"], 0) + 1
            self._result = [{"status": s, "n": n} for s, n in groups.items()]
        elif flat.startswith("UPDATE settlement_batches"):
            for b in d.table("settlement_batches"):
                if b["id"] == args[1] and b.get("status") != args[0]:
                    b["status"] = args[0]
                    self.rowcount += 1
        elif flat.startswith("SELECT * FROM gateway_payouts WHERE id"):
            row = self.find_payout(id=args[0])
            self._result = [_clone(row)] if row else []
        elif flat.startswith("SELECT * FROM gateway_payouts"):
            column = "originator_conversation_id" if "originator" in flat else "conversation_id"
            row = self.find_payout(**{column: args[0]})
            self._result = [_clone(row)] if row else []
        elif flat.startswith("UPDATE gateway_payouts"):
            (status, receipt, error, conv, ocid, _s, pid) = args
            row = self.find_payout(id=pid)
            self._apply(row, status=status,
                        mpesa_receipt=receipt or row.get("mpesa_receipt"),
                        last_error=error or row.get("last_error"),
                        conversation_id=conv or row.get("conversation_id"),
                        originator_conversation_id=ocid or row.get("originator_conversation_id"))

        # --- callback events / secrets / audit --------------------------------
        elif flat.startswith("INSERT INTO gateway_callback_events"):
            eid, endpoint, dedupe, raw = args
            if any(e["dedupe_hash"] == dedupe for e in d.table("gateway_callback_events")):
                raise UniqueViolation("dedupe_hash")
            d.table("gateway_callback_events").append(
                {"id": eid, "endpoint": endpoint, "dedupe_hash": dedupe, "raw_body": raw})
            self.rowcount = 1
        elif flat.startswith("SELECT callback_secret_enc FROM company_daraja_settings"):
            rows = d.table("company_daraja_settings")
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE company_daraja_settings"):
            rows = d.table("company_daraja_settings")
            if rows:
                rows[0]["last_known_balance"] = args[0]
                self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_audit_log"):
            d.table("gateway_audit_log").append({"id": args[0], "action": args[5]})
            self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_notifications"):
            d.table("gateway_notifications").append({"id": args[0]})
            self.rowcount = 1

        # --- source rows (portal claims) ---------------------------------------
        elif flat.startswith("UPDATE pppoe_stk_requests SET status = 'processing'"):
            for row in d.table("pppoe_stk_requests"):
                if row["checkout_id"] == args[0] and row["status"] in ("pending", "failed"):
                    row["status"] = "processing"
                    self.rowcount += 1
        elif flat.startswith("UPDATE pppoe_stk_requests") and "status = 'paid'" in flat:
            for row in d.table("pppoe_stk_requests"):
                if row["checkout_id"] == args[-1]:
                    row["status"] = "paid"
                    if "mpesa_code = COALESCE" in flat:
                        row["mpesa_code"] = args[0] or row.get("mpesa_code")
                    self.rowcount += 1
        elif flat.startswith("UPDATE pppoe_stk_requests SET status = 'failed'"):
            for row in d.table("pppoe_stk_requests"):
                if row["checkout_id"] == args[-1] and row["status"] == "pending":
                    row["status"] = "failed"
                    self.rowcount += 1
        elif "FROM pppoe_stk_requests" in flat:
            rows = [r for r in d.table("pppoe_stk_requests") if r["checkout_id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("SELECT package_id FROM pppoe_subscribers"):
            rows = [r for r in d.table("pppoe_subscribers") if r["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE pppoe_subscriptions"):
            self.rowcount = 1
        elif flat.startswith("UPDATE pppoe_subscribers"):
            self.rowcount = 1
        elif flat.startswith("UPDATE hotspot_purchases") and "status = 'paid'" in flat:
            for row in d.table("hotspot_purchases"):
                if row["checkout_id"] == args[-1] and row["status"] in ("pending", "failed"):
                    row["status"] = "paid"
                    if "mpesa_code = COALESCE" in flat:
                        row["mpesa_code"] = args[0] or row.get("mpesa_code")
                    self.rowcount += 1
        elif flat.startswith("UPDATE hotspot_purchases SET status = 'failed'"):
            for row in d.table("hotspot_purchases"):
                if row["checkout_id"] == args[0] and row["status"] == "pending":
                    row["status"] = "failed"
                    self.rowcount += 1
        return 1

    # --- helpers -----------------------------------------------------------

    def insert_payment(self, pid, client, source, amount, checkout, **kw):
        row = {"id": pid, "client_id": client, "source": source, "subscriber_id": kw.get("subscriber"),
               "hotspot_purchase_id": kw.get("hotspot"), "channel": kw.get("channel", "stk"),
               "msisdn": kw.get("msisdn", ""), "amount": amount, "mpesa_receipt": kw.get("receipt"),
               "checkout_id": checkout, "account_reference": kw.get("ref", ""),
               "status": kw.get("status", "initiated"), "raw_callback": kw.get("raw"),
               "confirmed_at": None}
        self.db.table("gateway_payments").append(row)
        return row

    def find_payment(self, id=None, checkout=None):
        for row in self.db.table("gateway_payments"):
            if (id and row["id"] == id) or (checkout and row.get("checkout_id") == checkout):
                return row
        return None

    def find_payout(self, **kw):
        for row in self.db.table("gateway_payouts"):
            if all(row.get(k) == v for k, v in kw.items()):
                return row
        return None

    def _apply(self, row, **fields):
        if row is not None:
            row.update(fields)
            self.rowcount = 1

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


class UniqueViolation(pymysql.MySQLError):
    pass


class FakeConnect:
    """connect() context manager over a shared MiniDb."""

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

    def rollback(self):
        pass


def stk_callback(checkout="ws_CO_1", code="0", receipt="QXX123", amount=500, phone=254700123456):
    return {
        "Body": {
            "stkCallback": {
                "CheckoutRequestID": checkout,
                "ResultCode": code,
                "ResultDesc": "ok" if code == "0" else "declined",
                "CallbackMetadata": {
                    "Item": [
                        {"Name": "Amount", "Value": amount},
                        {"Name": "MpesaReceiptNumber", "Value": receipt},
                        {"Name": "PhoneNumber", "Value": phone},
                    ]
                },
            }
        }
    }


class RouteTests(unittest.TestCase):
    def test_parses_every_endpoint(self):
        for ep in gateway_callbacks.ENDPOINTS:
            secret, endpoint = gateway_callbacks.route(f"/api/daraja/abc123/{ep}")
            self.assertEqual(secret, "abc123")
            self.assertEqual(endpoint, ep)

    def test_rejects_unknown_and_legacy_paths(self):
        self.assertIsNone(gateway_callbacks.route("/api/daraja/callback"))
        self.assertIsNone(gateway_callbacks.route("/api/daraja/abc/nope"))
        self.assertIsNone(gateway_callbacks.route("/api/other/stk"))
        self.assertIsNone(gateway_callbacks.route("/api/daraja/"))

    def test_secret_compare(self):
        db = MiniDb()
        sealed = gateway_crypto.seal("s3cr3t")
        db.insert("company_daraja_settings", id=1, callback_secret_enc=sealed)
        cursor = db.cursor()
        self.assertTrue(gateway_callbacks.secret_ok(cursor, "s3cr3t"))
        self.assertFalse(gateway_callbacks.secret_ok(cursor, "s3cr3x"))
        self.assertFalse(gateway_callbacks.secret_ok(cursor, ""))

    def test_secret_missing_row_denies(self):
        self.assertFalse(gateway_callbacks.secret_ok(MiniDb().cursor(), "anything"))


class DedupeTests(unittest.TestCase):
    def test_event_logged_once(self):
        db = MiniDb()
        payload = stk_callback()
        first = gateway_callbacks.handle(db.cursor(), "stk", payload)
        second = gateway_callbacks.handle(db.cursor(), "stk", payload)
        self.assertTrue(first)
        self.assertIsNone(second)
        self.assertEqual(len(db.table("gateway_callback_events")), 1)

    def test_different_endpoints_dont_collide(self):
        db = MiniDb()
        self.assertTrue(gateway_callbacks.handle(db.cursor(), "b2c/result", {"a": 1}))
        self.assertTrue(gateway_callbacks.handle(db.cursor(), "b2c/timeout", {"a": 1}))


class ConfirmTests(unittest.TestCase):
    def seed(self, amount=Decimal("500.00")):
        db = MiniDb()
        cursor = db.cursor()
        cursor.insert_payment("pay-1", "client-1", "pppoe", amount, "ws_CO_1", msisdn="254700123456")
        return db, cursor

    def test_confirm_writes_one_ledger_entry(self):
        db, cursor = self.seed()
        self.assertEqual(
            gateway_store.confirm_collection(cursor, "ws_CO_1", receipt="QXX1", amount=500), "confirmed")
        payment = cursor.find_payment(checkout="ws_CO_1")
        self.assertEqual(payment["status"], "confirmed")
        self.assertEqual(payment["mpesa_receipt"], "QXX1")
        ledger = db.table("gateway_ledger_entries")
        self.assertEqual(len(ledger), 1)
        self.assertEqual(str(ledger[0]["balance_after"]), "500.00")

    def test_second_confirm_is_a_noop(self):
        db, cursor = self.seed()
        gateway_store.confirm_collection(cursor, "ws_CO_1", receipt="QXX1", amount=500)
        self.assertEqual(gateway_store.confirm_collection(cursor, "ws_CO_1", amount=500), "already")
        self.assertEqual(len(db.table("gateway_ledger_entries")), 1)

    def test_wrong_amount_goes_to_suspense(self):
        db, cursor = self.seed()
        self.assertEqual(
            gateway_store.confirm_collection(cursor, "ws_CO_1", receipt="QXX9", amount=1), "unmatched")
        payment = cursor.find_payment(checkout="ws_CO_1")
        self.assertEqual(payment["status"], "unmatched")
        self.assertEqual(payment["mpesa_receipt"], "QXX9")
        self.assertEqual(len(db.table("gateway_ledger_entries")), 0)

    def test_unknown_checkout_returns_none(self):
        self.assertIsNone(gateway_store.confirm_collection(MiniDb().cursor(), "nope"))

    def test_fail_marks_collection(self):
        db, cursor = self.seed()
        self.assertTrue(gateway_store.fail_collection(cursor, "ws_CO_1", "cancelled", "user cancelled"))
        self.assertEqual(cursor.find_payment(checkout="ws_CO_1")["status"], "cancelled")

    def test_late_success_after_fail_still_credits(self):
        """Timeout marked it failed, then the real payment landed — the money
        wins: status flips to confirmed and the ledger entry is written."""
        db, cursor = self.seed()
        gateway_store.fail_collection(cursor, "ws_CO_1", "failed", "prompt expired")
        self.assertEqual(
            gateway_store.confirm_collection(cursor, "ws_CO_1", receipt="QXX5", amount=500),
            "confirmed")


class C2bTests(unittest.TestCase):
    def test_unmatched_receipt_lands_in_suspense(self):
        db = MiniDb()
        gateway_callbacks.process_c2b_confirmation(
            FakeConnect(db),
            {"TransID": "QAB777", "TransAmount": "350.00", "MSISDN": "254700111222", "BillRefNumber": "john"},
        )
        rows = db.table("gateway_payments")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "unmatched")
        self.assertIsNone(rows[0]["client_id"])
        self.assertEqual(rows[0]["mpesa_receipt"], "QAB777")
        self.assertEqual(len(db.table("gateway_notifications")), 1)

    def test_duplicate_receipt_dedupes(self):
        db = MiniDb()
        payload = {"TransID": "QAB777", "TransAmount": "350.00", "MSISDN": "254700111222"}
        gateway_callbacks.process_c2b_confirmation(FakeConnect(db), payload)
        gateway_callbacks.process_c2b_confirmation(FakeConnect(db), payload)
        self.assertEqual(len(db.table("gateway_payments")), 1)


class PayoutResultTests(unittest.TestCase):
    def seed(self):
        db = MiniDb()
        db.insert("settlement_batches", id="b-1", client_id="c1", status="processing",
                  commission=Decimal("10.00"), payout_fee=Decimal("5.00"), net=Decimal("100.00"))
        db.insert("gateway_payouts", id="po-1", batch_id="b-1", client_id="c1",
                  destination_type="phone", destination_value="254700111222",
                  account_reference="", amount=Decimal("100.00"),
                  originator_conversation_id="OC-1", conversation_id="AG-1",
                  status="submitted", mpesa_receipt=None, last_error="")
        return db

    def test_result_confirms_payout(self):
        db = self.seed()
        db.table("gateway_ledger_entries").append(
            {"id": "e-col", "client_id": "c1", "payment_id": "pay-1", "payout_id": None,
             "type": "collection", "amount": Decimal("115.00"), "balance_after": Decimal("115.00")})
        gateway_callbacks.process_payout_result(
            FakeConnect(db), "b2c/result",
            {"Result": {"OriginatorConversationID": "OC-1", "ConversationID": "AG-1",
                        "ResultCode": "0",
                        "ResultParameters": {"ResultParameter": [{"Key": "TransactionID", "Value": "RRC1"}]}}},
        )
        payout = db.table("gateway_payouts")[0]
        self.assertEqual(payout["status"], "confirmed")
        self.assertEqual(payout["mpesa_receipt"], "RRC1")
        # Ledger drains the pool: payout + commission + fee shares back to zero.
        entries = [e for e in db.table("gateway_ledger_entries") if e.get("payout_id") == "po-1"]
        self.assertEqual({e["type"] for e in entries}, {"payout", "commission", "payout_fee"})
        self.assertEqual(sum(e["amount"] for e in entries), Decimal("-115.00"))
        self.assertEqual(entries[-1]["balance_after"], Decimal("0"))
        self.assertEqual(db.table("settlement_batches")[0]["status"], "paid")
        # The client was told the money landed.
        self.assertTrue(db.table("gateway_notifications"))

    def test_result_is_exactly_once(self):
        db = self.seed()
        payload = {"Result": {"OriginatorConversationID": "OC-1", "ConversationID": "AG-1",
                              "ResultCode": "0"}}
        gateway_callbacks.process_payout_result(FakeConnect(db), "b2c/result", payload)
        gateway_callbacks.process_payout_result(FakeConnect(db), "b2c/result", payload)
        entries = [e for e in db.table("gateway_ledger_entries") if e.get("payout_id") == "po-1"]
        self.assertEqual(len(entries), 3)  # payout + commission + payout_fee, once each

    def test_timeout_marks_payout(self):
        db = self.seed()
        gateway_callbacks.process_payout_result(
            FakeConnect(db), "b2c/timeout",
            {"Result": {"OriginatorConversationID": "OC-1"}},
        )
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "timed_out")
        # A timed-out payout writes no ledger entries — the outcome is unknown.
        self.assertEqual(
            [e for e in db.table("gateway_ledger_entries") if e.get("payout_id") == "po-1"], [])

    def test_inner_conversation_id_matches(self):
        """Transaction Status answers echo the original ids inside
        ResultParameters — a payout resolves even when the top-level ids are
        the status query's own."""
        db = self.seed()
        gateway_callbacks.process_payout_result(
            FakeConnect(db), "b2c/result",
            {"Result": {"OriginatorConversationID": "STATUS-Q", "ConversationID": "STATUS-C",
                        "ResultCode": "0",
                        "ResultParameters": {"ResultParameter": [
                            {"Key": "OriginatorConversationID", "Value": "OC-1"},
                            {"Key": "TransactionID", "Value": "RRC9"},
                        ]}}},
        )
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "confirmed")
        self.assertEqual(db.table("gateway_payouts")[0]["mpesa_receipt"], "RRC9")

    def test_unknown_payout_is_ignored(self):
        db = MiniDb()
        gateway_callbacks.process_payout_result(
            FakeConnect(db), "b2b/result", {"Result": {"OriginatorConversationID": "??"}})


class CreditPathTests(unittest.TestCase):
    """The whole callback chain: dedupe -> verify -> confirm -> credit."""

    def seed_pppoe(self):
        db = MiniDb()
        db.cursor().insert_payment("pay-1", "client-1", "pppoe", Decimal("500.00"), "ws_CO_1")
        db.insert("pppoe_stk_requests", id="req-1", client_id="client-1",
                  subscriber_id="sub-1", package_id="pkg-1", package_price=Decimal("500.00"),
                  amount=Decimal("500.00"), checkout_id="ws_CO_1", mpesa_code="",
                  status="pending", package_name="Monthly")
        db.insert("pppoe_subscribers", id="sub-1", package_id="pkg-1")
        return db

    def test_pppoe_claim_renews_and_marks_paid(self):
        db = self.seed_pppoe()
        with patch("pppoe_store.renew") as renew:
            gateway_callbacks.fulfil_stk_credit(db.cursor(), "ws_CO_1")
            renew.assert_called_once()
        self.assertEqual(db.table("pppoe_stk_requests")[0]["status"], "paid")

    def test_second_claim_is_a_noop(self):
        db = self.seed_pppoe()
        with patch("pppoe_store.renew") as renew:
            gateway_callbacks.fulfil_stk_credit(db.cursor(), "ws_CO_1")
            gateway_callbacks.fulfil_stk_credit(db.cursor(), "ws_CO_1")
            renew.assert_called_once()  # poll + callback raced, renew ran once

    def test_process_stk_failure_marks_rows(self):
        """A failure callback only kills the row once the query agrees."""
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared",
            return_value=({"ResultCode": "1032", "ResultDesc": "Request cancelled by user"}, True),
        ):
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback(code="1032"))
        self.assertEqual(db.table("gateway_payments")[0]["status"], "cancelled")
        self.assertEqual(db.table("pppoe_stk_requests")[0]["status"], "failed")

    def test_process_stk_false_failure_callback_still_credits(self):
        """The money wins: a premature cancel callback is overridden when
        stkpushquery says the charge actually completed."""
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared", return_value=({"ResultCode": "0", "ResultDesc": "ok"}, True)
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback(code="1032"))
            renew.assert_called_once()
        self.assertEqual(db.table("gateway_payments")[0]["status"], "confirmed")
        self.assertEqual(db.table("pppoe_stk_requests")[0]["status"], "paid")

    def test_process_stk_undecided_failure_callback_stays_initiated(self):
        """A cancel callback whose query cannot decide leaves the row open
        for the sweep instead of killing a payment that may still land."""
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared", return_value=(None, True)
        ):
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback(code="1032"))
        self.assertEqual(db.table("gateway_payments")[0]["status"], "initiated")
        self.assertEqual(db.table("pppoe_stk_requests")[0]["status"], "pending")

    def test_sweep_recheck_heals_false_failure(self):
        """A row killed by a premature callback gets re-verified by the
        sweep — Daraja saying paid confirms it and credits the request."""
        db = self.seed_pppoe()
        cursor = db.cursor()
        cursor.find_payment(checkout="ws_CO_1")["status"] = "failed"
        db.table("pppoe_stk_requests")[0]["status"] = "failed"
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared", return_value=({"ResultCode": "0", "ResultDesc": "ok"}, True)
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.sweep(FakeConnect(db))
            renew.assert_called_once()
        self.assertEqual(db.table("gateway_payments")[0]["status"], "confirmed")
        self.assertEqual(db.table("pppoe_stk_requests")[0]["status"], "paid")

    def test_sweep_recheck_leaves_confirmed_failure_alone(self):
        """A genuinely failed request re-verifies as failed — nothing is
        credited and the mark is stamped so it waits before the next look."""
        db = self.seed_pppoe()
        cursor = db.cursor()
        cursor.find_payment(checkout="ws_CO_1")["status"] = "failed"
        db.table("pppoe_stk_requests")[0]["status"] = "failed"
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared",
            return_value=({"ResultCode": "1032", "ResultDesc": "Request cancelled by user"}, True),
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.sweep(FakeConnect(db))
            renew.assert_not_called()
        payment = db.table("gateway_payments")[0]
        self.assertEqual(payment["status"], "failed")
        self.assertEqual(payment.get("last_verified_at"), "now")

    def test_process_stk_paid_verifies_then_credits(self):
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared", return_value=({"ResultCode": "0", "ResultDesc": "ok"}, True)
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback())
            renew.assert_called_once()
        payment = db.table("gateway_payments")[0]
        self.assertEqual(payment["status"], "confirmed")
        self.assertEqual(payment["mpesa_receipt"], "QXX123")
        self.assertEqual(len(db.table("gateway_ledger_entries")), 1)
        self.assertEqual(db.table("pppoe_stk_requests")[0]["status"], "paid")

    def test_process_stk_rejected_query_does_not_credit(self):
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared",
            return_value=({"ResultCode": "1", "ResultDesc": "failed"}, True),
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback())
            renew.assert_not_called()
        self.assertEqual(db.table("gateway_payments")[0]["status"], "failed")

    def test_process_stk_unreachable_query_leaves_initiated(self):
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared", side_effect=TimeoutError("down")
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback())
            renew.assert_not_called()
        self.assertEqual(db.table("gateway_payments")[0]["status"], "initiated")

    def test_process_stk_pending_query_leaves_initiated(self):
        """An interim query answer (still pending) is not a failure — the
        payment stays initiated for the next attempt instead of dying."""
        db = self.seed_pppoe()
        settings = {"gateway_pool": True, "environment": "sandbox"}
        with patch("portal_server.daraja_settings", return_value=settings), patch(
            "portal_server.stk_query_shared",
            return_value=({"errorCode": "500.001.1001", "errorMessage": "processing"}, True),
        ), patch("pppoe_store.renew") as renew:
            gateway_callbacks.process_stk(FakeConnect(db), stk_callback())
            renew.assert_not_called()
        self.assertEqual(db.table("gateway_payments")[0]["status"], "initiated")


if __name__ == "__main__":
    unittest.main()
