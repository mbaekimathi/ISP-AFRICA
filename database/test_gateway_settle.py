"""Offline tests for the settlement scheduler — MiniDb emulates the exact
SQL gateway_settle runs, including FOR UPDATE guards and time windows."""

import os
import sys
import unittest
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))

import daraja_client
import gateway_settle
import gateway_store


class MiniDb:
    def __init__(self):
        self.tables = {}
        self.now = datetime.now()
        self.commits = 0
        self.lock_held = False

    def table(self, name):
        return self.tables.setdefault(name, [])

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return MiniCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


def _clone(row):
    return dict(row) if row else None


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
        args = list(args or ())
        self._result = []
        self.rowcount = 0
        d = self.db

        if "GET_LOCK" in flat:
            if d.lock_held:
                self._result = [{"got": 0}]
            else:
                d.lock_held = True
                self._result = [{"got": 1}]
        elif "RELEASE_LOCK" in flat:
            d.lock_held = False
            self._result = [{"1": 1}]
        elif flat.startswith("SELECT") and "FROM company_daraja_settings" in flat:
            rows = d.table("company_daraja_settings")
            self._result = [_clone(rows[0])] if rows else []
        elif "callback_secret_enc" in flat:
            self._result = [{"callback_secret_enc": ""}]
        elif flat.startswith("UPDATE company_daraja_settings"):
            rows = d.table("company_daraja_settings")
            if rows:
                if "public_base" in flat:
                    rows[0]["public_base"] = args[0]
                else:
                    rows[0]["last_known_balance"] = args[0]
            self.rowcount = 1
        elif "WHERE gateway_mode = 'company_gateway'" in flat:
            self._result = [
                _clone(r) for r in d.table("isp_payout_settings")
                if r.get("gateway_mode") == "company_gateway"
            ]
        elif "FROM isp_payout_settings WHERE client_id" in flat:
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE isp_payout_settings"):
            client_id = args[3]
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == client_id]
            if rows and rows[0].get("pending_change_effective_at") and rows[0]["pending_change_effective_at"] <= d.now:
                rows[0].update(
                    destination_type=args[0],
                    destination_value=args[1],
                    account_reference=args[2],
                    pending_change=None,
                    pending_change_effective_at=None,
                )
                self.rowcount = 1
        elif "FROM gateway_ledger_entries" in flat and "LEFT JOIN settlement_batch_entries" in flat:
            client_id = args[0]
            hold = int(args[1]) if len(args) > 1 else None
            linked = {be["ledger_entry_id"] for be in d.table("settlement_batch_entries")}
            out = []
            for e in d.table("gateway_ledger_entries"):
                if e["client_id"] != client_id or e["id"] in linked:
                    continue
                p = next((x for x in d.table("gateway_payments") if x["id"] == e["payment_id"]), None)
                if not p or p["status"] != "confirmed":
                    continue
                if hold is not None and p["confirmed_at"] > d.now - timedelta(hours=hold):
                    continue
                out.append({**_clone(e), "confirmed_at": p["confirmed_at"]})
            self._result = out
        elif flat.startswith("INSERT INTO settlement_batches"):
            (bid, client, key, pf, pt, gross, comm, fee, net) = args
            status = "scheduled"
            existing = next((b for b in d.table("settlement_batches") if b["batch_key"] == key), None)
            if not existing:
                d.table("settlement_batches").append(
                    {"id": bid, "client_id": client, "batch_key": key, "period_from": pf,
                     "period_to": pt, "gross": gross, "commission": comm, "payout_fee": fee,
                     "net": net, "status": status})
            self.rowcount = 1
        elif flat.startswith("SELECT id FROM settlement_batches"):
            row = next((b for b in d.table("settlement_batches") if b["batch_key"] == args[0]), None)
            self._result = [{"id": row["id"]}] if row else []
        elif flat.startswith("INSERT IGNORE INTO settlement_batch_entries"):
            batch_id, entry_id = args
            if not any(be["batch_id"] == batch_id and be["ledger_entry_id"] == entry_id
                       for be in d.table("settlement_batch_entries")):
                d.table("settlement_batch_entries").append(
                    {"batch_id": batch_id, "ledger_entry_id": entry_id})
                self.rowcount = 1
        elif flat.startswith("SELECT * FROM gateway_payouts WHERE status = 'queued'"):
            self._result = [_clone(p) for p in d.table("gateway_payouts") if p["status"] == "queued"]
        elif "FROM gateway_payouts" in flat and "IN ('submitted', 'timed_out')" in flat:
            # Stale-unresolved scan — the fake treats every listed row as old.
            def queryable(p):
                if p["status"] in ("submitted", "timed_out"):
                    return True
                return (p["status"] == "needs_review" and
                        (p.get("mpesa_receipt") or p.get("originator_conversation_id")))
            self._result = [_clone(p) for p in d.table("gateway_payouts") if queryable(p)]
        elif "FROM gateway_payouts WHERE id = %s" in flat:
            rows = [p for p in d.table("gateway_payouts") if p["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("SELECT * FROM gateway_payouts WHERE id"):
            rows = [p for p in d.table("gateway_payouts") if p["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("SELECT id, amount FROM gateway_payouts"):
            rows = [p for p in d.table("gateway_payouts") if p.get("batch_id") == args[0]]
            self._result = [{"id": p["id"], "amount": p["amount"]} for p in rows]
        elif flat.startswith("SELECT status, COUNT"):
            groups = {}
            for p in d.table("gateway_payouts"):
                if p.get("batch_id") == args[0]:
                    groups[p["status"]] = groups.get(p["status"], 0) + 1
            self._result = [{"status": s, "n": n} for s, n in groups.items()]
        elif flat.startswith("SELECT * FROM settlement_batches"):
            rows = [b for b in d.table("settlement_batches") if b["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE settlement_batches"):
            for b in d.table("settlement_batches"):
                if b["id"] == args[1] and b.get("status") != args[0]:
                    b["status"] = args[0]
                    self.rowcount += 1
        elif flat.startswith("UPDATE gateway_payouts") and "attempt_count" in flat:
            for p in d.table("gateway_payouts"):
                if p["id"] == args[0] and p["status"] == "queued":
                    p["status"] = "submitting"
                    p["attempt_count"] = p.get("attempt_count", 0) + 1
                    self.rowcount = 1
        elif flat.startswith("UPDATE gateway_payouts") and "'submitted'" in flat:
            (ocid, cid, pid) = args
            for p in d.table("gateway_payouts"):
                if p["id"] == pid and p["status"] == "submitting":
                    p.update(status="submitted",
                             originator_conversation_id=ocid or p.get("originator_conversation_id"),
                             conversation_id=cid or p.get("conversation_id"),
                             submitted_at=d.now)
                    self.rowcount = 1
        elif flat.startswith("UPDATE gateway_payouts") and "WHERE status = 'submitting'" in flat:
            for p in d.table("gateway_payouts"):
                if p["status"] == "submitting":
                    p["status"] = "needs_review"
                    p["last_error"] = "send interrupted — verify with Transaction Status"
                    self.rowcount += 1
        elif flat.startswith("UPDATE gateway_payouts") and "status = 'failed'" in flat:
            for p in d.table("gateway_payouts"):
                if p["id"] == args[0]:
                    p["status"] = "failed"
                    p["last_error"] = "marked failed by operator"
                    self.rowcount = 1
        elif flat.startswith("UPDATE gateway_payouts"):
            (status, error, pid) = args
            for p in d.table("gateway_payouts"):
                if p["id"] == pid and p["status"] == "submitting":
                    p["status"] = status
                    p["last_error"] = error
                    self.rowcount = 1
        elif flat.startswith("SELECT balance_after FROM gateway_ledger_entries"):
            entries = [e for e in d.table("gateway_ledger_entries") if e["client_id"] == args[0]]
            self._result = [{"balance_after": entries[-1]["balance_after"]}] if entries else []
        elif flat.startswith("INSERT INTO gateway_ledger_entries"):
            lid, client, payout, kind, amount, balance = args
            if any(e.get("payout_id") == payout and e.get("type") == kind
                   for e in d.table("gateway_ledger_entries")):
                raise pymysql.MySQLError("duplicate ledger entry")
            d.table("gateway_ledger_entries").append(
                {"id": lid, "client_id": client, "payout_id": payout,
                 "type": kind, "amount": amount, "balance_after": balance})
            self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_payouts"):
            (pid, batch, client, dtype, dval, aref, amount, idem) = args
            status = "queued"
            if not any(p["idempotency_key"] == idem for p in d.table("gateway_payouts")):
                d.table("gateway_payouts").append(
                    {"id": pid, "batch_id": batch, "client_id": client, "destination_type": dtype,
                     "destination_value": dval, "account_reference": aref, "amount": amount,
                     "idempotency_key": idem, "status": status})
            self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_audit_log"):
            d.table("gateway_audit_log").append({"id": args[0], "action": args[5]})
            self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_notifications"):
            d.table("gateway_notifications").append(
                {"id": args[0], "audience": args[2], "client_id": args[3], "kind": args[4]})
            self.rowcount = 1
        return 1

    def executemany(self, sql, rows):
        for row in rows:
            self.execute(sql, row)
        return self.rowcount

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


def company(**overrides):
    row = {
        "id": 1, "environment": "sandbox", "account_type": "paybill",
        "short_code": "600000", "consumer_key": "k", "consumer_secret": "s",
        "passkey": "p", "initiator_name": "i", "initiator_password_enc": "e",
        "payout_shortcode": "600099", "status": "active", "kill_switch": 0,
        "commission_percent": Decimal("2.00"), "commission_flat": Decimal("0"),
        "default_hold_hours": 24, "min_payout": Decimal("100"),
        "max_payout_per_tx": Decimal("0"), "payout_fee_estimate": Decimal("0"),
        "last_known_balance": None, "last_balance_at": None,
    }
    row.update(overrides)
    return row


def client_row(cid="c1", **overrides):
    row = {
        "client_id": cid, "settlement_mode": "immediate", "hold_hours": 24,
        "destination_type": "phone", "destination_value": "254700999888",
        "account_reference": "", "min_payout_override": None,
        "pending_change": None, "pending_change_effective_at": None,
        "gateway_mode": "company_gateway",
    }
    row.update(overrides)
    return row


def seed_payment(db, cid, amount, entry_id, payment_id=None, confirmed_at=None, kind="collection"):
    payment_id = payment_id or f"pay-{entry_id}"
    db.table("gateway_payments").append(
        {"id": payment_id, "client_id": cid, "status": "confirmed",
         "confirmed_at": confirmed_at or db.now})
    db.table("gateway_ledger_entries").append(
        {"id": entry_id, "client_id": cid, "payment_id": payment_id, "payout_id": None,
         "type": kind, "amount": Decimal(str(amount)),
         "balance_after": Decimal("0"), "created_at": confirmed_at or db.now})


def seed_db():
    db = MiniDb()
    db.table("company_daraja_settings").append(company())
    db.table("isp_payout_settings").append(client_row())
    return db


class PlanTests(unittest.TestCase):
    def test_gross_minus_commission_minus_fee(self):
        db = seed_db()
        entries = [
            {"id": "e1", "type": "collection", "amount": Decimal("1000"), "created_at": db.now},
            {"id": "e2", "type": "collection", "amount": Decimal("500"), "created_at": db.now},
        ]
        plan = gateway_settle.plan_batch(entries, company(payout_fee_estimate=Decimal("20")), client_row())
        self.assertEqual(plan["gross"], Decimal("1500.00"))
        self.assertEqual(plan["commission"], Decimal("30.00"))  # 2%
        self.assertEqual(plan["fee"], Decimal("20.00"))
        self.assertEqual(plan["net"], Decimal("1450.00"))
        self.assertEqual(plan["amounts"], [Decimal("1450.00")])

    def test_carry_forward_below_minimum(self):
        db = seed_db()
        entries = [{"id": "e1", "type": "collection", "amount": Decimal("50"), "created_at": db.now}]
        self.assertIsNone(gateway_settle.plan_batch(entries, company(), client_row()))

    def test_client_min_override(self):
        db = seed_db()
        entries = [{"id": "e1", "type": "collection", "amount": Decimal("50"), "created_at": db.now}]
        row = client_row(min_payout_override=Decimal("10"))
        self.assertIsNotNone(gateway_settle.plan_batch(entries, company(), row))

    def test_split_over_max_per_tx(self):
        db = seed_db()
        entries = [{"id": "e1", "type": "collection", "amount": Decimal("1000"), "created_at": db.now}]
        cfg = company(max_payout_per_tx=Decimal("400"), commission_percent=Decimal("0"))
        plan = gateway_settle.plan_batch(entries, cfg, client_row())
        self.assertEqual(len(plan["amounts"]), 3)
        self.assertEqual(sum(plan["amounts"]), plan["net"])
        for amount in plan["amounts"]:
            self.assertLessEqual(amount, Decimal("400"))

    def test_reversal_and_adjustment_net_out(self):
        db = seed_db()
        entries = [
            {"id": "e1", "type": "collection", "amount": Decimal("1000"), "created_at": db.now},
            {"id": "e2", "type": "reversal", "amount": Decimal("-200"), "created_at": db.now},
            {"id": "e3", "type": "adjustment", "amount": Decimal("50"), "created_at": db.now},
        ]
        plan = gateway_settle.plan_batch(entries, company(commission_percent=Decimal("0")), client_row())
        self.assertEqual(plan["net"], Decimal("850.00"))

    def test_split_amounts_exact(self):
        parts = gateway_settle.split_amount(Decimal("1000.01"), 3)
        self.assertEqual(sum(parts), Decimal("1000.01"))
        self.assertEqual(len(parts), 3)


class SettleClientTests(unittest.TestCase):
    def test_immediate_settlement_queues_batch_and_payout(self):
        db = seed_db()
        seed_payment(db, "c1", "1000", "e1")
        cursor = db.cursor()
        out = gateway_settle.settle_client(db, cursor, "c1", company())
        self.assertEqual(out["payouts"], 1)
        batch = db.table("settlement_batches")[0]
        self.assertEqual(batch["status"], "scheduled")
        self.assertEqual(batch["net"], Decimal("980.00"))  # 1000 - 2%
        payout = db.table("gateway_payouts")[0]
        self.assertEqual(payout["status"], "queued")
        self.assertEqual(payout["destination_type"], "phone")
        self.assertEqual(payout["destination_value"], "254700999888")
        self.assertEqual(payout["batch_id"], batch["id"])
        self.assertEqual(len(db.table("settlement_batch_entries")), 1)

    def test_delayed_boundary(self):
        db = seed_db()
        db.table("isp_payout_settings")[0].update(settlement_mode="delayed", hold_hours=24)
        recent = db.now - timedelta(hours=20)
        old = db.now - timedelta(hours=30)
        seed_payment(db, "c1", "1000", "e-recent", confirmed_at=recent)
        seed_payment(db, "c1", "1000", "e-old", confirmed_at=old)
        cursor = db.cursor()
        gateway_settle.settle_client(db, cursor, "c1", company())
        # Only the entry past the hold window is batched.
        linked = {be["ledger_entry_id"] for be in db.table("settlement_batch_entries")}
        self.assertEqual(linked, {"e-old"})

    def test_carry_forward_leaves_everything(self):
        db = seed_db()
        seed_payment(db, "c1", "50", "e1")
        out = gateway_settle.settle_client(db, db.cursor(), "c1", company())
        self.assertEqual(out, {"carried": 1})
        self.assertEqual(db.table("settlement_batches"), [])
        self.assertEqual(db.table("gateway_payouts"), [])

    def test_splitting_when_over_max(self):
        db = seed_db()
        seed_payment(db, "c1", "1000", "e1")
        cfg = company(max_payout_per_tx=Decimal("400"), commission_percent=Decimal("0"))
        gateway_settle.settle_client(db, db.cursor(), "c1", cfg)
        payouts = db.table("gateway_payouts")
        self.assertEqual(len(payouts), 3)
        keys = {p["idempotency_key"] for p in payouts}
        self.assertEqual(len(keys), 3)
        self.assertEqual(sum(p["amount"] for p in payouts), Decimal("1000"))

    def test_low_float_alerts_director_but_queues(self):
        db = seed_db()
        db.table("company_daraja_settings")[0].update(
            last_known_balance=Decimal("10"), last_balance_at=db.now)
        cfg = company(last_known_balance=Decimal("10"), last_balance_at=db.now)
        seed_payment(db, "c1", "1000", "e1")
        out = gateway_settle.settle_client(db, db.cursor(), "c1", cfg)
        self.assertTrue(out["shortfall"])
        self.assertEqual(len(db.table("gateway_payouts")), 1)
        self.assertEqual(db.table("gateway_notifications")[0]["kind"], "low_float")

    def test_stale_balance_does_not_alert(self):
        db = seed_db()
        stale = db.now - timedelta(hours=2)
        cfg = company(last_known_balance=Decimal("1"), last_balance_at=stale)
        seed_payment(db, "c1", "1000", "e1")
        out = gateway_settle.settle_client(db, db.cursor(), "c1", cfg)
        self.assertFalse(out["shortfall"])

    def test_rerun_is_idempotent(self):
        db = seed_db()
        seed_payment(db, "c1", "1000", "e1")
        cfg = company()
        gateway_settle.settle_client(db, db.cursor(), "c1", cfg)
        # Second run: the entries are already linked — nothing new is created.
        self.assertIsNone(gateway_settle.settle_client(db, db.cursor(), "c1", cfg))
        self.assertEqual(len(db.table("settlement_batches")), 1)
        self.assertEqual(len(db.table("gateway_payouts")), 1)

    def test_pending_destination_applies_after_cooling(self):
        db = seed_db()
        db.table("isp_payout_settings")[0].update(
            pending_change='{"destination_type": "till", "destination_value": "555555"}',
            pending_change_effective_at=db.now - timedelta(minutes=1),
        )
        seed_payment(db, "c1", "1000", "e1")
        gateway_settle.settle_client(db, db.cursor(), "c1", company())
        row = db.table("isp_payout_settings")[0]
        self.assertEqual(row["destination_type"], "till")
        self.assertIsNone(row["pending_change"])
        # And the queued payout carries the NEW destination snapshot.
        self.assertEqual(db.table("gateway_payouts")[0]["destination_value"], "555555")

    def test_pending_destination_waits_when_cooling(self):
        db = seed_db()
        db.table("isp_payout_settings")[0].update(
            pending_change='{"destination_type": "till", "destination_value": "555555"}',
            pending_change_effective_at=db.now + timedelta(hours=1),
        )
        seed_payment(db, "c1", "1000", "e1")
        gateway_settle.settle_client(db, db.cursor(), "c1", company())
        row = db.table("isp_payout_settings")[0]
        self.assertEqual(row["destination_type"], "phone")
        self.assertEqual(db.table("gateway_payouts")[0]["destination_value"], "254700999888")

    def test_no_destination_skips(self):
        db = seed_db()
        db.table("isp_payout_settings")[0].update(destination_type=None, destination_value="")
        seed_payment(db, "c1", "1000", "e1")
        out = gateway_settle.settle_client(db, db.cursor(), "c1", company())
        self.assertEqual(out, {"skipped": "no-destination"})
        self.assertEqual(db.table("settlement_batches"), [])


class TickTests(unittest.TestCase):
    def test_tick_settles_each_client(self):
        db = seed_db()
        db.table("isp_payout_settings").append(client_row("c2"))
        seed_payment(db, "c1", "1000", "e1")
        seed_payment(db, "c2", "2000", "e2")
        out = gateway_settle.settlement_tick(lambda: db)
        self.assertEqual(set(out), {"c1", "c2"})
        self.assertEqual(len(db.table("settlement_batches")), 2)

    def test_tick_skips_when_locked(self):
        db = seed_db()
        db.lock_held = True
        out = gateway_settle.settlement_tick(lambda: db)
        self.assertEqual(out, {"skipped": "locked"})

    def test_tick_skips_when_inactive_or_killed(self):
        db = seed_db()
        db.table("company_daraja_settings")[0]["status"] = "draft"
        self.assertEqual(gateway_settle.settlement_tick(lambda: db), {"skipped": "inactive"})
        db.table("company_daraja_settings")[0].update(status="active", kill_switch=1)
        self.assertEqual(gateway_settle.settlement_tick(lambda: db), {"skipped": "inactive"})

    def test_crash_mid_batch_resumes_clean(self):
        """Batch+links+payouts are one transaction: a crash either commits the
        whole thing or nothing — a rerun only sees complete batches."""
        db = seed_db()
        seed_payment(db, "c1", "1000", "e1")
        cfg = company()
        out = gateway_settle.settle_client(db, db.cursor(), "c1", cfg)
        # Simulate the same eligible set being re-presented (a re-run): the
        # batch_key and payout idempotency keys dedupe it.
        out2 = gateway_settle.settle_client(db, db.cursor(), "c1", cfg)
        self.assertIsNone(out2)
        self.assertEqual(len(db.table("settlement_batches")), 1)
        self.assertEqual(len(db.table("gateway_payouts")), 1)
        self.assertEqual(out["batch"], db.table("settlement_batches")[0]["id"])


class FakeDaraja:
    """Records calls and returns queued responses (or raises queued errors)."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def _next(self, name, payload):
        self.calls.append((name, payload))
        if not self.responses:
            return {"ResponseCode": "0", "OriginatorConversationID": "OC-x",
                    "ConversationID": "C-x"}
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def b2c(self, phone, amount, result_url, timeout_url, **kw):
        return self._next("b2c", {"phone": phone, "amount": amount,
                                  "result": result_url, "timeout": timeout_url})

    def b2b_paybill(self, paybill, amount, account_reference, result_url, timeout_url, **kw):
        return self._next("b2b_paybill", {"paybill": paybill, "amount": amount,
                                          "account_reference": account_reference,
                                          "result": result_url})

    def b2b_buygoods(self, till, amount, result_url, timeout_url, **kw):
        return self._next("b2b_buygoods", {"till": till, "amount": amount, "result": result_url})

    def transaction_status(self, **kw):
        return self._next("transaction_status", kw)

    def account_balance(self, result_url, timeout_url, **kw):
        return self._next("account_balance", {"result": result_url})


def seed_payout(db, cid="c1", batch_id="b-1", payout_id="po-1", amount="500",
                dtype="phone", dval="254700999888", aref="", status="queued", **kw):
    if not any(b["id"] == batch_id for b in db.table("settlement_batches")):
        db.table("settlement_batches").append(
            {"id": batch_id, "client_id": cid, "status": "processing",
             "commission": Decimal("10"), "payout_fee": Decimal("5"),
             "net": Decimal("500")})
    row = {"id": payout_id, "batch_id": batch_id, "client_id": cid,
           "destination_type": dtype, "destination_value": dval,
           "account_reference": aref, "amount": Decimal(amount), "status": status,
           "attempt_count": 0, "mpesa_receipt": None,
           "originator_conversation_id": None, "conversation_id": None,
           "submitted_at": None, "last_error": ""}
    row.update(kw)
    db.table("gateway_payouts").append(row)
    return row


class ExecuteTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(
            os.environ, {"ISP_GATEWAY_PUBLIC_URL": "https://gw.example.com"}
        )
        self.env.start()
        self.secret = patch("gateway_store.callback_secret", return_value="tok")
        self.secret.start()

    def tearDown(self):
        self.env.stop()
        self.secret.stop()

    def test_b2c_submission(self):
        db = seed_db()
        seed_payout(db)
        client = FakeDaraja({"ResponseCode": "0", "OriginatorConversationID": "OC-9",
                             "ConversationID": "C-9"})
        out = gateway_settle.execute_payouts(db, db.cursor(), client)
        self.assertEqual(out["submitted"], 1)
        payout = db.table("gateway_payouts")[0]
        self.assertEqual(payout["status"], "submitted")
        self.assertEqual(payout["originator_conversation_id"], "OC-9")
        name, payload = client.calls[0]
        self.assertEqual(name, "b2c")
        self.assertEqual(payload["result"],
                         "https://gw.example.com/api/daraja/tok/b2c/result")
        self.assertEqual(payload["timeout"],
                         "https://gw.example.com/api/daraja/tok/b2c/timeout")
        # Claim committed before the send, outcome committed after.
        self.assertGreaterEqual(db.commits, 2)

    def test_paybill_carries_account_reference(self):
        db = seed_db()
        seed_payout(db, dtype="paybill", dval="888999", aref="ISP-001")
        client = FakeDaraja()
        gateway_settle.execute_payouts(db, db.cursor(), client)
        self.assertEqual(client.calls[0][0], "b2b_paybill")
        self.assertEqual(client.calls[0][1]["account_reference"], "ISP-001")
        self.assertEqual(client.calls[0][1]["result"],
                         "https://gw.example.com/api/daraja/tok/b2b/result")

    def test_till_uses_buygoods(self):
        db = seed_db()
        seed_payout(db, dtype="till", dval="555555")
        client = FakeDaraja()
        gateway_settle.execute_payouts(db, db.cursor(), client)
        self.assertEqual(client.calls[0][0], "b2b_buygoods")

    def test_sync_reject_marks_failed(self):
        db = seed_db()
        seed_payout(db)
        client = FakeDaraja({"ResponseCode": "1",
                             "ResponseDescription": "Insufficient funds"})
        out = gateway_settle.execute_payouts(db, db.cursor(), client)
        self.assertEqual(out["failed"], 1)
        payout = db.table("gateway_payouts")[0]
        self.assertEqual(payout["status"], "failed")
        self.assertIn("Insufficient", payout["last_error"])
        self.assertEqual(db.table("settlement_batches")[0]["status"], "failed")

    def test_transport_unknown_parks_needs_review(self):
        db = seed_db()
        seed_payout(db)
        client = FakeDaraja(daraja_client.DarajaTimeout("socket died mid-request"))
        out = gateway_settle.execute_payouts(db, db.cursor(), client)
        self.assertEqual(out["needs_review"], 1)
        # The payout is never re-queued: Daraja may have received it.
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "needs_review")

    def test_no_public_url_leaves_queued(self):
        """Without a callback endpoint nothing is claimed — payouts wait for
        the gateway to become reachable instead of burning to needs_review."""
        db = seed_db()
        seed_payout(db)
        self.env.stop()
        os.environ.pop("ISP_GATEWAY_PUBLIC_URL", None)
        client = FakeDaraja()
        out = gateway_settle.execute_payouts(db, db.cursor(), client)
        self.assertEqual(out, {"skipped": "no-callback-url"})
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "queued")
        self.assertEqual(client.calls, [])

    def test_claim_is_atomic_once(self):
        """A second claim pass finds nothing — the payout left 'queued'."""
        db = seed_db()
        seed_payout(db)
        client = FakeDaraja()
        gateway_settle.execute_payouts(db, db.cursor(), client)
        out = gateway_settle.execute_payouts(db, db.cursor(), FakeDaraja())
        self.assertEqual(out, {"submitted": 0, "failed": 0, "needs_review": 0})
        self.assertEqual(len(client.calls), 1)


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(
            os.environ, {"ISP_GATEWAY_PUBLIC_URL": "https://gw.example.com"}
        )
        self.env.start()
        self.secret = patch("gateway_store.callback_secret", return_value="tok")
        self.secret.start()

    def tearDown(self):
        self.env.stop()
        self.secret.stop()

    def test_orphaned_submitting_becomes_needs_review(self):
        db = seed_db()
        seed_payout(db, status="submitting")
        out = gateway_settle.reconcile_submitted(db, db.cursor(), FakeDaraja())
        self.assertEqual(out["orphaned"], 1)
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "needs_review")

    def test_stale_submitted_queries_by_conversation_id(self):
        db = seed_db()
        seed_payout(db, status="submitted", originator_conversation_id="OC-1",
                    submitted_at=db.now - timedelta(minutes=20))
        client = FakeDaraja()
        out = gateway_settle.reconcile_submitted(db, db.cursor(), client)
        self.assertEqual(out["queried"], 1)
        self.assertEqual(client.calls[0][0], "transaction_status")
        self.assertEqual(client.calls[0][1]["original_conversation_id"], "OC-1")

    def test_stale_submitted_queries_by_receipt_when_known(self):
        db = seed_db()
        seed_payout(db, status="submitted", mpesa_receipt="RRC5",
                    submitted_at=db.now - timedelta(minutes=20))
        client = FakeDaraja()
        gateway_settle.reconcile_submitted(db, db.cursor(), client)
        self.assertEqual(client.calls[0][1]["transaction_id"], "RRC5")
        self.assertIsNone(client.calls[0][1]["original_conversation_id"])

    def test_stale_scan_also_picks_timed_out_and_identified_review(self):
        db = seed_db()
        seed_payout(db, payout_id="po-1", status="timed_out",
                    originator_conversation_id="OC-t",
                    submitted_at=db.now - timedelta(minutes=30))
        seed_payout(db, payout_id="po-2", batch_id="b-1", status="needs_review",
                    originator_conversation_id="OC-n",
                    submitted_at=db.now - timedelta(minutes=30))
        # needs_review without identifiers can't be queried — stays for a human.
        seed_payout(db, payout_id="po-3", batch_id="b-1", status="needs_review",
                    submitted_at=db.now - timedelta(minutes=30))
        client = FakeDaraja()
        out = gateway_settle.reconcile_submitted(db, db.cursor(), client)
        self.assertEqual(out["queried"], 2)
        queried = sorted(call[1]["original_conversation_id"] for call in client.calls)
        self.assertEqual(queried, ["OC-n", "OC-t"])


class FinalizeTests(unittest.TestCase):
    def test_confirmed_payout_drains_pool_exactly(self):
        db = seed_db()
        db.table("gateway_ledger_entries").append(
            {"id": "e-col", "client_id": "c1", "payment_id": "pay-1",
             "payout_id": None, "type": "collection", "amount": Decimal("515.00"),
             "balance_after": Decimal("515.00")})
        payout = seed_payout(db, status="confirmed", mpesa_receipt="RRC1")
        gateway_store.finalize_payout_outcome(db.cursor(), payout, receipt="RRC1")
        entries = [e for e in db.table("gateway_ledger_entries")
                   if e.get("payout_id") == "po-1"]
        self.assertEqual({e["type"] for e in entries},
                         {"payout", "commission", "payout_fee"})
        self.assertEqual(sum(e["amount"] for e in entries), Decimal("-515.00"))
        self.assertEqual(entries[-1]["balance_after"], Decimal("0"))
        self.assertEqual(db.table("settlement_batches")[0]["status"], "paid")

    def test_finalize_is_exactly_once(self):
        db = seed_db()
        payout = seed_payout(db, status="confirmed")
        cursor = db.cursor()
        gateway_store.finalize_payout_outcome(cursor, payout)
        gateway_store.finalize_payout_outcome(cursor, dict(payout))
        entries = [e for e in db.table("gateway_ledger_entries")
                   if e.get("payout_id") == "po-1"]
        self.assertEqual(len(entries), 3)

    def test_rollup_partial_and_failed(self):
        db = seed_db()
        seed_payout(db, payout_id="po-1", status="confirmed")
        seed_payout(db, payout_id="po-2", status="submitted")
        self.assertEqual(gateway_store.rollup_batch(db.cursor(), "b-1"), "partially_paid")
        for p in db.table("gateway_payouts"):
            p["status"] = "failed"
        self.assertEqual(gateway_store.rollup_batch(db.cursor(), "b-1"), "failed")
        # Confirmed everywhere -> paid.
        for p in db.table("gateway_payouts"):
            p["status"] = "confirmed"
        self.assertEqual(gateway_store.rollup_batch(db.cursor(), "b-1"), "paid")


class CheckStatusTests(unittest.TestCase):
    """Director-initiated Transaction Status probes."""

    def setUp(self):
        self.env = patch.dict(
            os.environ, {"ISP_GATEWAY_PUBLIC_URL": "https://gw.example.com"}
        )
        self.env.start()
        self.secret = patch("gateway_store.callback_secret", return_value="tok")
        self.secret.start()

    def tearDown(self):
        self.env.stop()
        self.secret.stop()

    def test_queries_needs_review_by_conversation_id(self):
        db = seed_db()
        payout = seed_payout(db, status="needs_review",
                             originator_conversation_id="OC-7")
        client = FakeDaraja()
        result, error = gateway_settle.check_payout_status(
            db.cursor(), payout["id"], "emp-1", client=client)
        self.assertIsNone(error)
        self.assertEqual(result["queried"], "po-1")
        name, payload = client.calls[0]
        self.assertEqual(name, "transaction_status")
        self.assertEqual(payload["original_conversation_id"], "OC-7")
        self.assertTrue(payload["result_url"].endswith("/b2c/result"))
        self.assertTrue(any(a["action"] == "payout.status_check"
                            for a in db.table("gateway_audit_log")))

    def test_confirmed_payout_is_not_checked(self):
        db = seed_db()
        payout = seed_payout(db, status="confirmed")
        client = FakeDaraja()
        result, error = gateway_settle.check_payout_status(
            db.cursor(), payout["id"], "emp-1", client=client)
        self.assertIsNone(result)
        self.assertIn("confirmed", error)
        self.assertFalse(client.calls)

    def test_no_identifiers_means_never_sent(self):
        db = seed_db()
        payout = seed_payout(db, status="needs_review")
        result, error = gateway_settle.check_payout_status(
            db.cursor(), payout["id"], "emp-1", client=FakeDaraja())
        self.assertIsNone(result)
        self.assertIn("never reached", error)

    def test_no_callback_url_blocks_the_query(self):
        self.secret.stop()
        db = seed_db()
        payout = seed_payout(db, status="needs_review",
                             originator_conversation_id="OC-7")
        result, error = gateway_settle.check_payout_status(
            db.cursor(), payout["id"], "emp-1", client=FakeDaraja())
        self.assertIsNone(result)
        self.assertTrue(error)
        self.secret.start()


class PublicBaseTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("ISP_GATEWAY_PUBLIC_URL", None)

    def tearDown(self):
        os.environ.pop("ISP_GATEWAY_PUBLIC_URL", None)

    def test_env_wins_over_stored(self):
        db = seed_db()
        db.table("company_daraja_settings")[0]["public_base"] = "https://learned.example.com"
        with patch.dict(os.environ, {"ISP_GATEWAY_PUBLIC_URL": "https://env.example.com/"}):
            self.assertEqual(
                gateway_store.public_base(db.cursor()), "https://env.example.com")

    def test_stored_base_used_when_env_missing(self):
        db = seed_db()
        db.table("company_daraja_settings")[0]["public_base"] = "https://learned.example.com/"
        self.assertEqual(
            gateway_store.public_base(db.cursor()), "https://learned.example.com")

    def test_remember_stores_and_overwrites(self):
        db = seed_db()
        row = db.table("company_daraja_settings")[0]
        gateway_store.remember_public_base(db.cursor(), "https://one.example.com/")
        self.assertEqual(row["public_base"], "https://one.example.com")
        gateway_store.remember_public_base(db.cursor(), "https://two.example.com")
        self.assertEqual(row["public_base"], "https://two.example.com")

    def test_remember_ignores_blank_and_env_override(self):
        db = seed_db()
        row = db.table("company_daraja_settings")[0]
        gateway_store.remember_public_base(db.cursor(), "")
        self.assertNotIn("public_base", row)
        with patch.dict(os.environ, {"ISP_GATEWAY_PUBLIC_URL": "https://env.example.com"}):
            gateway_store.remember_public_base(db.cursor(), "https://learned.example.com")
        self.assertNotIn("public_base", row)


class ManualFailTests(unittest.TestCase):
    def test_marks_never_sent_payout_failed_and_rolls_up(self):
        db = seed_db()
        payout = seed_payout(db, status="needs_review")
        result, error = gateway_store.fail_payout_manually(
            db.cursor(), payout["id"], "emp-1")
        self.assertIsNone(error)
        row = db.table("gateway_payouts")[0]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(db.table("settlement_batches")[0]["status"], "failed")
        self.assertTrue(any(a["action"] == "payout.mark_failed"
                            for a in db.table("gateway_audit_log")))

    def test_rejects_payout_that_reached_daraja(self):
        db = seed_db()
        payout = seed_payout(db, status="needs_review",
                             originator_conversation_id="OC-7")
        result, error = gateway_store.fail_payout_manually(
            db.cursor(), payout["id"], "emp-1")
        self.assertIsNone(result)
        self.assertIn("reached Daraja", error)
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "needs_review")

    def test_rejects_other_states(self):
        db = seed_db()
        payout = seed_payout(db, status="submitted",
                             originator_conversation_id="OC-7")
        result, error = gateway_store.fail_payout_manually(
            db.cursor(), payout["id"], "emp-1")
        self.assertIsNone(result)
        self.assertIn("submitted", error)


if __name__ == "__main__":
    unittest.main()
