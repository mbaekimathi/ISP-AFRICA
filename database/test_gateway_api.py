"""Offline tests for the gateway read/ops layer — custody derivation,
suspense assignment, payout settings staging, exports. MiniDb emulates the
exact SQL gateway_store's Phase-6 helpers run."""

import sys
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gateway_api
import gateway_store


def _clone(row):
    return dict(row) if row else None


class MiniDb:
    def __init__(self):
        self.tables = {}
        self.commits = 0

    def table(self, name):
        return self.tables.setdefault(name, [])

    def insert(self, name, **row):
        self.table(name).append(row)
        return row

    def cursor(self):
        return MiniCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


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

        if "last_known_balance" in flat and "FROM company_daraja_settings" in flat:
            rows = d.table("company_daraja_settings")
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("SELECT * FROM company_daraja_settings"):
            rows = d.table("company_daraja_settings")
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE company_daraja_settings SET"):
            columns = [part.split("=")[0].strip() for part in
                       flat.split("SET", 1)[1].split("WHERE")[0].split(",")]
            for r in d.table("company_daraja_settings"):
                for column, value in zip(columns, args):
                    r[column] = value
                self.rowcount = 1
        elif flat.startswith("SELECT id, first_name, last_name, email, status FROM isp_clients"):
            self._result = [_clone(r) for r in d.table("isp_clients")]
        elif "FROM gateway_payouts WHERE id = %s" in flat:
            rows = [p for p in d.table("gateway_payouts") if p["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE gateway_payouts SET status = 'failed'"):
            for p in d.table("gateway_payouts"):
                if p["id"] == args[-1]:
                    p["status"] = "failed"
                    self.rowcount = 1
        elif "FROM gateway_payouts WHERE batch_id = %s GROUP BY status" in flat:
            groups = {}
            for p in d.table("gateway_payouts"):
                if p.get("batch_id") == args[0]:
                    groups[p["status"]] = groups.get(p["status"], 0) + 1
            self._result = [{"status": s, "n": n} for s, n in groups.items()]
        elif flat.startswith("UPDATE settlement_batches SET status"):
            for b in d.table("settlement_batches"):
                if b["id"] == args[1] and b.get("status") != args[0]:
                    b["status"] = args[0]
                    self.rowcount = 1
        elif "FROM gateway_ledger_entries e" in flat and "SELECT client_id, balance_after" in flat:
            latest = {}
            for e in d.table("gateway_ledger_entries"):
                latest[e["client_id"]] = e["balance_after"]
            self._result = [{"client_id": k, "balance_after": v} for k, v in latest.items()]
        elif flat.startswith("SELECT balance_after FROM gateway_ledger_entries"):
            entries = [e for e in d.table("gateway_ledger_entries") if e["client_id"] == args[0]]
            self._result = [{"balance_after": entries[-1]["balance_after"]}] if entries else []
        elif "FROM gateway_payouts GROUP BY status" in flat:
            groups = {}
            for p in d.table("gateway_payouts"):
                g = groups.setdefault(p["status"], {"n": 0, "total": Decimal("0")})
                g["n"] += 1
                g["total"] += Decimal(str(p.get("amount") or 0))
            self._result = [{"status": s, "n": g["n"], "total": g["total"]}
                            for s, g in groups.items()]
        elif "COUNT(*) AS n FROM gateway_payments" in flat and "status = 'confirmed'" in flat and "NOT IN" in flat:
            linked = {be["ledger_entry_id"] for be in d.table("settlement_batch_entries")}
            batched_payments = {e["payment_id"] for e in d.table("gateway_ledger_entries")
                                if e["id"] in linked}
            n = sum(1 for p in d.table("gateway_payments")
                    if p["client_id"] == args[0] and p["status"] == "confirmed"
                    and p["id"] not in batched_payments)
            self._result = [{"n": n}]
        elif "COUNT(*) AS n FROM gateway_payments WHERE status = 'unmatched'" in flat:
            self._result = [{"n": sum(1 for p in d.table("gateway_payments")
                                     if p["status"] == "unmatched")}]
        elif "COUNT(*) AS n FROM isp_payout_settings WHERE pending_change IS NOT NULL" in flat:
            self._result = [{"n": sum(1 for r in d.table("isp_payout_settings")
                                     if r.get("pending_change"))}]
        elif "COUNT(*) AS n FROM isp_payout_settings WHERE gateway_mode = 'company_gateway'" in flat:
            self._result = [{"n": sum(1 for r in d.table("isp_payout_settings")
                                     if r.get("gateway_mode") == "company_gateway"
                                     and r["client_id"] != args[0])}]
        elif "FROM gateway_payments p" in flat:
            rows = [p for p in d.table("gateway_payments")
                    if not args or args[0] not in {p.get("client_id"), p.get("status")} or True]
            rows = list(d.table("gateway_payments"))
            if "WHERE p.client_id = %s" in flat:
                rows = [p for p in rows if p["client_id"] == args[0]]
            elif "WHERE p.status = %s" in flat:
                rows = [p for p in rows if p["status"] == args[0]]
            out = []
            for p in rows:
                entry = next((e for e in d.table("gateway_ledger_entries")
                              if e.get("payment_id") == p["id"] and e["type"] == "collection"), None)
                be = next((x for x in d.table("settlement_batch_entries")
                           if entry and x["ledger_entry_id"] == entry["id"]), None)
                batch_id = be["batch_id"] if be else None
                out.append({**_clone(p), "batch_id": batch_id,
                            "custody": self._custody(p, batch_id)})
            self._result = out
        elif "FROM isp_payout_settings s" in flat:
            rows = [r for r in d.table("isp_payout_settings")
                    if r.get("gateway_mode") == "company_gateway"]
            if "s.client_id = %s" in flat:
                rows = [r for r in rows if r["client_id"] == args[0]]
            self._result = [_clone(r) for r in rows]
        elif "FROM settlement_batches" in flat and "GROUP BY status" in flat:
            groups = {}
            for b in d.table("settlement_batches"):
                if b["client_id"] == args[0]:
                    groups[b["status"]] = groups.get(b["status"], 0) + 1
            self._result = [{"status": s, "n": n} for s, n in groups.items()]
        elif "FROM gateway_ledger_entries WHERE client_id = %s" in flat:
            self._result = [_clone(e) for e in d.table("gateway_ledger_entries")
                            if e["client_id"] == args[0]]
        elif "FROM gateway_payouts po" in flat:
            rows = list(d.table("gateway_payouts"))
            if "po.client_id = %s" in flat:
                rows = [p for p in rows if p["client_id"] == args[0]]
            if "po.status = %s" in flat:
                status = args[1] if "po.client_id" in flat else args[0]
                rows = [p for p in rows if p["status"] == status]
            out = []
            for p in rows:
                batch = next((b for b in d.table("settlement_batches")
                              if b["id"] == p.get("batch_id")), {})
                out.append({**_clone(p), "batch_status": batch.get("status")})
            self._result = out
        elif "FROM settlement_batches b" in flat:
            rows = list(d.table("settlement_batches"))
            if "b.client_id = %s" in flat:
                rows = [b for b in rows if b["client_id"] == args[0]]
            out = []
            for b in rows:
                out.append({**_clone(b),
                            "entries": sum(1 for be in d.table("settlement_batch_entries")
                                           if be["batch_id"] == b["id"]),
                            "payouts": sum(1 for p in d.table("gateway_payouts")
                                           if p.get("batch_id") == b["id"])})
            self._result = out
        elif "FROM gateway_payments WHERE status = 'unmatched'" in flat:
            self._result = [_clone(p) for p in d.table("gateway_payments")
                            if p["status"] == "unmatched"]
        elif "FROM isp_payout_settings WHERE pending_change IS NOT NULL" in flat:
            self._result = [_clone(r) for r in d.table("isp_payout_settings")
                            if r.get("pending_change")]
        elif "FROM gateway_audit_log" in flat:
            rows = list(d.table("gateway_audit_log"))
            if "WHERE client_id = %s" in flat:
                rows = [a for a in rows if a.get("client_id") == args[0]]
            self._result = [_clone(a) for a in rows]
        elif "FROM gateway_payments WHERE id = %s" in flat:
            rows = [p for p in d.table("gateway_payments") if p["id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("INSERT INTO isp_payout_settings"):
            if not any(r["client_id"] == args[0] for r in d.table("isp_payout_settings")):
                d.table("isp_payout_settings").append(
                    {"client_id": args[0], "gateway_mode": "none",
                     "settlement_mode": "immediate", "hold_hours": 24,
                     "destination_type": None, "destination_value": "",
                     "account_reference": "", "min_payout_override": None,
                     "pending_change": None, "pending_change_effective_at": None})
            self.rowcount = 1
        elif flat.startswith("SELECT client_id FROM isp_payout_settings"):
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [{"client_id": rows[0]["client_id"]}] if rows else []
        elif flat.startswith("SELECT * FROM isp_payout_settings"):
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif "FROM isp_payout_settings WHERE client_id = %s" in flat:
            rows = [r for r in d.table("isp_payout_settings") if r["client_id"] == args[0]]
            self._result = [_clone(rows[0])] if rows else []
        elif flat.startswith("UPDATE gateway_payments SET client_id"):
            (client_id, pid) = args
            for p in d.table("gateway_payments"):
                if p["id"] == pid and p["status"] == "unmatched":
                    p.update(client_id=client_id, status="confirmed", confirmed_at="now")
                    self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_ledger_entries"):
            if len(args) == 6:  # payout-side entry: (id, client, payout_id, kind, amount, balance)
                lid, client, payout, kind, amount, balance = args
                payment = None
            else:  # collection entry: (id, client, payment_id, amount, balance)
                lid, client, payment, amount, balance = args
                payout, kind = None, "collection"
            d.table("gateway_ledger_entries").append(
                {"id": lid, "client_id": client, "payment_id": payment,
                 "payout_id": payout, "type": kind,
                 "amount": Decimal(str(amount)), "balance_after": Decimal(str(balance))})
            self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_audit_log"):
            d.table("gateway_audit_log").append({"id": args[0], "action": args[5]})
            self.rowcount = 1
        elif flat.startswith("INSERT INTO gateway_notifications"):
            d.table("gateway_notifications").append(
                {"id": args[0], "audience": args[2], "client_id": args[3], "kind": args[4]})
            self.rowcount = 1
        elif flat.startswith("UPDATE isp_payout_settings SET pending_change"):
            for r in d.table("isp_payout_settings"):
                if r["client_id"] == args[1]:
                    r["pending_change"] = args[0]
                    r["pending_change_effective_at"] = "now+24h"
                    self.rowcount = 1
        elif flat.startswith("UPDATE isp_payout_settings SET destination_type"):
            for r in d.table("isp_payout_settings"):
                if r["client_id"] == args[3]:
                    r.update(destination_type=args[0], destination_value=args[1],
                             account_reference=args[2])
                    self.rowcount = 1
        elif flat.startswith("UPDATE isp_payout_settings SET"):
            columns = [part.split("=")[0].strip() for part in
                       flat.split("SET", 1)[1].split("WHERE")[0].split(",")]
            for r in d.table("isp_payout_settings"):
                if r["client_id"] == args[-1]:
                    for column, value in zip(columns, args):
                        r[column] = value
                    self.rowcount = 1
        elif "FROM gateway_fee_bands" in flat:
            rows = sorted(d.table("gateway_fee_bands"),
                          key=lambda band: band.get("min_amount") or 0)
            self._result = [_clone(row) for row in rows]
        elif "FROM gateway_notifications" in flat:
            rows = list(d.table("gateway_notifications"))
            if "audience = 'client'" in flat:
                rows = [n for n in rows if n.get("audience") == "client"
                        and n.get("client_id") == args[0]]
            else:
                rows = [n for n in rows if n.get("audience") == "company"]
            self._result = [_clone(n) for n in rows]
        return 1

    def _custody(self, payment, batch_id):
        """Mirror of gateway_store.CUSTODY_SQL, evaluated in Python."""
        if payment["status"] == "unmatched":
            return "unmatched"
        if payment["status"] == "initiated":
            return "awaiting"
        if payment["status"] in ("failed", "cancelled"):
            return "failed"
        if not batch_id:
            return "held"
        statuses = [p["status"] for p in self.db.table("gateway_payouts")
                    if p.get("batch_id") == batch_id]
        if statuses and all(s == "confirmed" for s in statuses):
            return "delivered"
        if any(s in ("submitting", "submitted") for s in statuses):
            return "in_transit"
        if any(s in ("needs_review", "timed_out") for s in statuses):
            return "under_review"
        if any(s == "queued" for s in statuses):
            return "scheduled"
        return "failed"

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


def settings_row(cid="c1", **overrides):
    row = {"client_id": cid, "gateway_mode": "company_gateway",
           "settlement_mode": "immediate", "hold_hours": 24,
           "destination_type": "phone", "destination_value": "254700999888",
           "account_reference": "", "min_payout_override": None,
           "pending_change": None, "pending_change_effective_at": None}
    row.update(overrides)
    return row


def payment(pid="pay-1", cid="c1", **overrides):
    row = {"id": pid, "client_id": cid, "source": "pppoe", "channel": "stk",
           "msisdn": "254711122233", "amount": Decimal("500"), "mpesa_receipt": "RRC1",
           "checkout_id": "ws_1", "status": "confirmed", "confirmed_at": "now",
           "created_at": "now"}
    row.update(overrides)
    return row


class OverviewTests(unittest.TestCase):
    def test_overview_aggregates(self):
        db = MiniDb()
        db.insert("company_daraja_settings", id=1, last_known_balance=Decimal("9000"),
                  last_balance_at="then", status="active", kill_switch=0)
        db.insert("gateway_ledger_entries", id="e1", client_id="c1",
                  balance_after=Decimal("500"), created_at="t1", payment_id="p1",
                  payout_id=None, type="collection", amount=Decimal("500"))
        db.insert("gateway_payouts", id="po1", client_id="c1", status="queued", amount=Decimal("400"))
        db.insert("gateway_payments", id="u1", client_id=None, status="unmatched", amount=Decimal("50"))
        db.insert("isp_payout_settings", **settings_row(pending_change="{}"))
        out = gateway_api.overview(db.cursor())
        self.assertEqual(str(out["float"]["balance"]), "9000")
        self.assertEqual(out["heldByClient"], [{"clientId": "c1", "balance": "500"}])
        self.assertEqual(out["payouts"]["queued"]["count"], 1)
        self.assertEqual(out["suspenseCount"], 1)
        self.assertEqual(out["pendingDestinationChanges"], 1)


class CustodyTests(unittest.TestCase):
    def seed(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row())
        return db

    def link(self, db, pid, batch_id="b-1"):
        db.insert("gateway_ledger_entries", id=f"e-{pid}", client_id="c1",
                  payment_id=pid, payout_id=None, type="collection",
                  amount=Decimal("500"), balance_after=Decimal("500"), created_at="t")
        db.insert("settlement_batch_entries", batch_id=batch_id, ledger_entry_id=f"e-{pid}")

    def test_custody_matrix(self):
        db = self.seed()
        db.insert("gateway_payments", **payment("p-await", status="initiated"))
        db.insert("gateway_payments", **payment("p-unmatched", status="unmatched", client_id=None))
        db.insert("gateway_payments", **payment("p-held"))
        db.insert("gateway_payments", **payment("p-transit"))
        self.link(db, "p-transit")
        db.insert("gateway_payouts", id="po-1", batch_id="b-1", client_id="c1",
                  status="submitted", amount=Decimal("500"))
        rows = {r["id"]: r["custody"]
                for r in gateway_store.custody_rows(db.cursor(), client_id="c1")}
        self.assertEqual(rows["p-await"], "awaiting")
        self.assertEqual(rows["p-held"], "held")
        self.assertEqual(rows["p-transit"], "in_transit")

    def test_custody_unmatched_shows_for_director(self):
        db = self.seed()
        db.insert("gateway_payments", **payment("p-u", status="unmatched", client_id=None))
        rows = gateway_store.custody_rows(db.cursor())
        self.assertEqual(rows[0]["custody"], "unmatched")
        self.assertTrue(rows[0]["msisdn"].startswith("2547"))
        self.assertNotEqual(rows[0]["msisdn"], "254711122233")  # masked

    def test_delivered_when_all_confirmed(self):
        db = self.seed()
        db.insert("gateway_payments", **payment("p-done"))
        self.link(db, "p-done")
        db.insert("gateway_payouts", id="po-1", batch_id="b-1", client_id="c1",
                  status="confirmed", amount=Decimal("500"))
        rows = gateway_store.custody_rows(db.cursor())
        self.assertEqual(rows[0]["custody"], "delivered")


class SuspenseTests(unittest.TestCase):
    def test_assign_credits_client_once(self):
        db = MiniDb()
        db.insert("gateway_payments", **payment("u-1", cid=None, status="unmatched"))
        result = gateway_store.assign_unmatched(db.cursor(), "u-1", "c9", "emp-1")
        self.assertEqual(result["payment_id"], "u-1")
        payout_row = db.table("gateway_payments")[0]
        self.assertEqual(payout_row["status"], "confirmed")
        self.assertEqual(payout_row["client_id"], "c9")
        entry = db.table("gateway_ledger_entries")[0]
        self.assertEqual(entry["client_id"], "c9")
        self.assertEqual(entry["type"], "collection")
        # A second assign can't happen — the payment left 'unmatched'.
        self.assertIsNone(gateway_store.assign_unmatched(db.cursor(), "u-1", "c9", "emp-1"))

    def test_assign_unknown_payment(self):
        db = MiniDb()
        self.assertIsNone(gateway_store.assign_unmatched(db.cursor(), "nope", "c9", "emp-1"))

    def test_assign_endpoint_validates(self):
        db = MiniDb()
        db.insert("gateway_payments", **payment("u-1", cid=None, status="unmatched"))
        result, error = gateway_api.assign_suspense(db.cursor(), "u-1", {}, "emp-1")
        self.assertIsNone(result)
        self.assertIn("clientId", error)
        result, error = gateway_api.assign_suspense(
            db.cursor(), "u-1", {"clientId": "c9"}, "emp-1")
        self.assertIn("assigned", result)
        # Client was notified.
        self.assertTrue(any(n["audience"] == "client" for n in db.table("gateway_notifications")))


class SettingsTests(unittest.TestCase):
    def test_mode_change_is_immediate_and_audited(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row(gateway_mode="own_daraja"))
        result, error = gateway_api.save_isp_settings(
            db.cursor(), "c1", {"gatewayMode": "company_gateway"}, actor_id="c1")
        self.assertIsNone(error)
        row = db.table("isp_payout_settings")[0]
        self.assertEqual(row["gateway_mode"], "company_gateway")
        self.assertTrue(any(a["action"] == "settings.updated"
                            for a in db.table("gateway_audit_log")))

    def test_opt_in_activates_company_gateway(self):
        db = MiniDb()
        db.insert("company_daraja_settings", id=1, status="draft", kill_switch=0)
        db.insert("isp_payout_settings", **settings_row(gateway_mode="own_daraja"))
        gateway_api.save_isp_settings(
            db.cursor(), "c1", {"gatewayMode": "company_gateway"}, actor_id="c1")
        self.assertEqual(db.table("company_daraja_settings")[0]["status"], "active")
        self.assertTrue(any(a["action"] == "gateway.status"
                            for a in db.table("gateway_audit_log")))

    def test_last_pooled_client_leaving_returns_gateway_to_draft(self):
        db = MiniDb()
        db.insert("company_daraja_settings", id=1, status="active", kill_switch=0)
        db.insert("isp_payout_settings", **settings_row())
        gateway_api.save_isp_settings(
            db.cursor(), "c1", {"gatewayMode": "own_daraja"}, actor_id="c1")
        self.assertEqual(db.table("company_daraja_settings")[0]["status"], "draft")

    def test_gateway_stays_active_while_another_client_is_pooled(self):
        db = MiniDb()
        db.insert("company_daraja_settings", id=1, status="active", kill_switch=0)
        db.insert("isp_payout_settings", **settings_row())
        db.insert("isp_payout_settings", **settings_row("c2"))
        gateway_api.save_isp_settings(
            db.cursor(), "c1", {"gatewayMode": "own_daraja"}, actor_id="c1")
        self.assertEqual(db.table("company_daraja_settings")[0]["status"], "active")

    def test_suspended_gateway_is_not_overridden(self):
        db = MiniDb()
        db.insert("company_daraja_settings", id=1, status="suspended", kill_switch=0)
        db.insert("isp_payout_settings", **settings_row(gateway_mode="own_daraja"))
        gateway_api.save_isp_settings(
            db.cursor(), "c1", {"gatewayMode": "company_gateway"}, actor_id="c1")
        self.assertEqual(db.table("company_daraja_settings")[0]["status"], "suspended")

    def test_first_destination_applies_immediately(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row(
            destination_type=None, destination_value=""))
        result, error = gateway_api.save_isp_settings(
            db.cursor(), "c1",
            {"destination": {"type": "phone", "value": "0700999888"}}, actor_id="c1")
        self.assertIsNone(error)
        self.assertEqual(result["outcome"], "destination-set")
        row = db.table("isp_payout_settings")[0]
        self.assertEqual(row["destination_value"], "254700999888")
        self.assertIsNone(row["pending_change"])

    def test_destination_change_stages_with_cooling_off(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row())
        result, error = gateway_api.save_isp_settings(
            db.cursor(), "c1",
            {"destination": {"type": "phone", "value": "0711222333"}}, actor_id="c1")
        self.assertIsNone(error)
        self.assertEqual(result["outcome"], "destination-pending")
        row = db.table("isp_payout_settings")[0]
        # Live destination unchanged; the new one is queued.
        self.assertEqual(row["destination_value"], "254700999888")
        self.assertIn("254711222333", row["pending_change"])
        self.assertEqual(row["pending_change_effective_at"], "now+24h")
        # Both audiences were notified.
        audiences = {n["audience"] for n in db.table("gateway_notifications")}
        self.assertEqual(audiences, {"company", "client"})

    def test_invalid_destination_rejected_before_store(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row())
        result, error = gateway_api.save_isp_settings(
            db.cursor(), "c1",
            {"destination": {"type": "phone", "value": "not-a-phone"}}, actor_id="c1")
        self.assertIsNone(result)
        self.assertTrue(error)
        self.assertIsNone(db.table("isp_payout_settings")[0]["pending_change"])

    def test_paybill_requires_account_reference(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row())
        result, error = gateway_api.save_isp_settings(
            db.cursor(), "c1",
            {"destination": {"type": "paybill", "value": "888999"}}, actor_id="c1")
        self.assertIsNone(result)
        self.assertIn("accountReference", error)


class ListTests(unittest.TestCase):
    def test_isp_summary_masks_phone(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row())
        out = gateway_api.isp_summary(db.cursor(), "c1")
        self.assertEqual(out["mode"], "company_gateway")
        self.assertTrue(out["destination"]["value"].startswith("2547"))
        self.assertNotEqual(out["destination"]["value"], "254700999888")

    def test_pending_changes_masks_and_shapes(self):
        db = MiniDb()
        db.insert("isp_payout_settings", **settings_row(pending_change='{"x":1}'))
        rows = gateway_api.pending_changes(db.cursor())["pending"]
        self.assertEqual(len(rows), 1)
        self.assertIn("current", rows[0])
        self.assertNotEqual(rows[0]["current"]["destination_value"], "254700999888")

    def test_export_payouts_csv(self):
        db = MiniDb()
        db.insert("settlement_batches", id="b-1", client_id="c1", status="processing",
                  gross=Decimal("500"), net=Decimal("480"), commission=Decimal("15"),
                  payout_fee=Decimal("5"), period_from="a", period_to="b", created_at="c")
        db.insert("gateway_payouts", id="po-1", batch_id="b-1", client_id="c1",
                  destination_type="phone", destination_value="254700999888",
                  account_reference="", amount=Decimal("480"), status="queued",
                  mpesa_receipt=None, last_error="", attempt_count=0,
                  submitted_at=None, confirmed_at=None, created_at="c")
        result, error = gateway_api.export_csv(db.cursor(), "payouts", {"client": ["c1"]})
        self.assertIsNone(error)
        self.assertIn("gateway-payouts.csv", result["filename"])
        self.assertIn("po-1", result["csv"])
        self.assertNotIn("254700999888", result["csv"])  # masked even in export

    def test_export_bad_kind(self):
        db = MiniDb()
        result, error = gateway_api.export_csv(db.cursor(), "secrets", {})
        self.assertIsNone(result)
        self.assertTrue(error)


class CompanyGatewaySettingsTests(unittest.TestCase):
    def seed(self, **overrides):
        db = MiniDb()
        row = {"id": 1, "initiator_name": "i", "initiator_password_enc": "enc",
               "payout_shortcode": "600099", "status": "active", "kill_switch": 0,
               "commission_percent": Decimal("2.00"), "commission_flat": Decimal("0"),
               "default_hold_hours": 24, "min_payout": Decimal("100"),
               "max_payout_per_tx": Decimal("0"), "payout_fee_estimate": Decimal("0")}
        row.update(overrides)
        db.insert("company_daraja_settings", **row)
        return db

    def test_view_masks_secrets(self):
        db = self.seed()
        out = gateway_api.settings_view(db.cursor())
        self.assertTrue(out["configured"])
        self.assertTrue(out["initiatorPasswordSet"])
        self.assertNotIn("initiatorPassword", out)
        self.assertNotIn("enc", str(out))
        self.assertEqual(out["status"], "active")

    def test_view_unconfigured(self):
        db = MiniDb()
        self.assertEqual(gateway_api.settings_view(db.cursor()), {"configured": False})

    def test_isp_fees_shows_costs_without_secrets(self):
        db = self.seed(
            commission_percent=Decimal("2.50"), commission_flat=Decimal("10"),
            payout_fee_estimate=Decimal("15"), max_payout_per_tx=Decimal("50000"),
            txn_fees_enabled=1)
        db.insert("gateway_fee_bands", id="fb-1", company_id="company",
                  min_amount=Decimal("1"), max_amount=Decimal("1000"), fee=Decimal("5"))
        db.insert("gateway_fee_bands", id="fb-2", company_id="company",
                  min_amount=Decimal("1001"), max_amount=None, fee=Decimal("12"))
        out = gateway_api.isp_fees(db.cursor())
        self.assertTrue(out["configured"])
        self.assertEqual(out["commissionPercent"], "2.50")
        self.assertEqual(out["commissionFlat"], "10")
        self.assertEqual(out["payoutFeeEstimate"], "15")
        self.assertEqual(out["maxPayoutPerTx"], "50000")
        self.assertTrue(out["txnFeesEnabled"])
        self.assertEqual([band["fee"] for band in out["bands"]], ["5", "12"])
        self.assertIsNone(out["bands"][1]["max"])
        self.assertNotIn("enc", str(out))

    def test_isp_fees_unconfigured(self):
        db = MiniDb()
        self.assertEqual(gateway_api.isp_fees(db.cursor()), {"configured": False})

    def test_isp_settings_defaults_when_no_payout_row(self):
        # A client who signed up after the startup backfill has no
        # isp_payout_settings row — the settings page must still get a
        # usable object, never null.
        db = MiniDb()
        out = gateway_api.isp_settings(db.cursor(), "new-client")
        self.assertEqual(out["settings"]["gateway_mode"], "none")
        self.assertEqual(out["settings"]["settlement_mode"], "immediate")
        self.assertIsNone(out["settings"]["min_payout_override"])
        self.assertEqual(out["settings"]["settle_schedule"], [])

    def test_kill_switch_toggle_is_audited(self):
        db = self.seed()
        result, error = gateway_api.save_company_gateway(
            db.cursor(), {"killSwitch": True}, "emp-1")
        self.assertIsNone(error)
        self.assertEqual(result["outcome"], "saved")
        self.assertEqual(db.table("company_daraja_settings")[0]["kill_switch"], 1)
        self.assertTrue(result["settings"]["killSwitch"])
        self.assertTrue(any(a["action"] == "gateway.settings"
                            for a in db.table("gateway_audit_log")))

    def test_initiator_password_is_sealed_and_masked_in_audit(self):
        db = self.seed()
        result, error = gateway_api.save_company_gateway(
            db.cursor(), {"initiatorPassword": "new-secret"}, "emp-1")
        self.assertIsNone(error)
        stored = db.table("company_daraja_settings")[0]["initiator_password_enc"]
        self.assertTrue(stored.startswith("gcm1."))
        self.assertNotIn("new-secret", stored)
        audit = db.table("gateway_audit_log")[0]
        self.assertNotIn("new-secret", str(audit))

    def test_decimal_fields_validate(self):
        db = self.seed()
        result, error = gateway_api.save_company_gateway(
            db.cursor(), {"commissionPercent": "not-a-number"}, "emp-1")
        self.assertIsNone(result)
        self.assertIn("commissionPercent", error)

    def test_status_whitelist(self):
        db = self.seed()
        result, error = gateway_api.save_company_gateway(
            db.cursor(), {"status": "broken"}, "emp-1")
        self.assertIsNone(result)
        self.assertIn("status", error)

    def test_no_changes_is_unchanged(self):
        db = self.seed()
        result, error = gateway_api.save_company_gateway(
            db.cursor(), {"status": "active", "killSwitch": False}, "emp-1")
        self.assertIsNone(error)
        self.assertEqual(result["outcome"], "unchanged")
        self.assertEqual(db.table("gateway_audit_log"), [])

    def test_shortcode_validation(self):
        db = self.seed()
        result, error = gateway_api.save_company_gateway(
            db.cursor(), {"payoutShortcode": "12"}, "emp-1")
        self.assertIsNone(result)
        self.assertTrue(error)


class ClientDirectoryTests(unittest.TestCase):
    def test_directory_lists_all_isps(self):
        db = MiniDb()
        db.insert("isp_clients", id="c1", first_name="Ada", last_name="Wanjiru",
                  email="a@x", status="approved")
        out = gateway_api.clients(db.cursor())
        self.assertEqual(out["directory"][0]["name"], "Ada Wanjiru")
        self.assertEqual(out["directory"][0]["id"], "c1")


class MarkFailedTests(unittest.TestCase):
    def test_marks_never_sent_failed(self):
        db = MiniDb()
        db.insert("settlement_batches", id="b-1", client_id="c1", status="processing")
        db.insert("gateway_payouts", id="po-1", batch_id="b-1", client_id="c1",
                  status="needs_review", originator_conversation_id=None,
                  conversation_id=None, mpesa_receipt=None)
        result, error = gateway_api.mark_payout_failed(db.cursor(), "po-1", "emp-1")
        self.assertIsNone(error)
        self.assertEqual(db.table("gateway_payouts")[0]["status"], "failed")
        self.assertEqual(db.table("settlement_batches")[0]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
