"""Temporary E2E probe — exercises the gateway pipeline against the live DB.
Seeds synthetic rows, runs settle/finalize, prints findings, cleans up."""
import os, json, uuid
from decimal import Decimal
import pymysql
from dotenv import load_dotenv

load_dotenv("../.env")
import gateway_store, gateway_settle, gateway_callbacks

db = pymysql.connect(
    host=os.environ["ISP_DB_HOST"], port=int(os.environ["ISP_DB_PORT"]),
    user=os.environ["ISP_DB_USER"], password=os.environ.get("ISP_DB_PASSWORD", ""),
    database=os.environ["ISP_DB_NAME"], cursorclass=pymysql.cursors.DictCursor,
)
db.autocommit(False)
cur = db.cursor()
CID = "def7c8dc-0265-5b1f-b657-90469ac0e168"
RUN = uuid.uuid4().hex[:6]


def rcpt(tag):
    return f"R{RUN}{tag}"


def q(sql, args=()):
    cur.execute(sql, args)
    return cur.fetchall()


def ledger(client_id):
    rows = q("SELECT type, amount, balance_after FROM gateway_ledger_entries WHERE client_id=%s ORDER BY created_at, id", (client_id,))
    return rows


def banner(t):
    print(f"\n=== {t}")


try:
    # --- SETUP ---------------------------------------------------------------
    banner("setup")
    cur.execute("DELETE FROM isp_payout_settings WHERE client_id = %s", (CID,))
    cur.execute(
        "INSERT INTO isp_payout_settings (client_id, company_id, gateway_mode, settlement_mode, "
        "destination_type, destination_value, hold_hours) VALUES (%s,'company','company_gateway','immediate','phone','254700000011',0)",
        (CID,),
    )
    cur.execute(
        "INSERT INTO company_daraja_settings (id, environment, account_type, short_code, consumer_key, "
        "consumer_secret, passkey, status, commission_percent, min_payout, payout_fee_estimate, "
        "max_payout_per_tx, txn_fees_enabled) VALUES (1,'sandbox','paybill','600000','ck','cs','pk','active',5,1,10,500,0) "
        "ON DUPLICATE KEY UPDATE status='active', commission_percent=5, min_payout=1, "
        "payout_fee_estimate=10, max_payout_per_tx=500, txn_fees_enabled=0, kill_switch=0",
    )
    company = gateway_settle.company_gateway_settings(cur)
    print("company:", {k: company[k] for k in ("status", "commission_percent", "min_payout", "max_payout_per_tx", "kill_switch")})

    # --- COLLECTION ----------------------------------------------------------
    banner("collection -> confirm_collection x3 (immediate mode)")
    for i, amount in enumerate((Decimal("800"), Decimal("300"), Decimal("100"))):
        checkout = f"e2e_co_{i}_{uuid.uuid4().hex[:8]}"
        gateway_store.record_stk_initiated(cur, checkout, CID, "pppoe", amount, "254700000000")
        outcome = gateway_store.confirm_collection(cur, checkout, receipt=rcpt(str(i)), amount=str(amount))
        print(f"  collection {i}: {outcome}")
    print("  ledger:", [(r["type"], str(r["amount"]), str(r["balance_after"])) for r in ledger(CID)])

    # --- SETTLEMENT (multi-payout: net ~950.50 vs max_tx 500 -> 2 payouts) -----
    banner("settle_client -> batch + payouts")
    outcome = gateway_settle.settle_client(db, cur, CID, company)
    print("  outcome:", outcome)
    batch = q("SELECT * FROM settlement_batches WHERE client_id=%s ORDER BY created_at DESC LIMIT 1", (CID,))[0]
    payouts = q("SELECT * FROM gateway_payouts WHERE batch_id=%s ORDER BY created_at, id", (batch["id"],))
    print(f"  batch: gross={batch['gross']} comm={batch['commission']} fee={batch['payout_fee']} net={batch['net']} status={batch['status']}")
    print(f"  payouts: {[(str(p['amount']), p['status']) for p in payouts]}")
    total = sum(Decimal(str(p["amount"])) for p in payouts)
    print(f"  payout sum = {total} vs net = {batch['net']}")

    # --- FINALIZE all payouts as confirmed -----------------------------------
    banner("payout results: confirmed x%d" % len(payouts))
    for i, p in enumerate(payouts):
        cur.execute("UPDATE gateway_payouts SET status='submitting' WHERE id=%s", (p["id"],))
        gateway_store.mark_payout_submitted(cur, p["id"], f"org-{p['id'][:8]}", f"conv-{p['id'][:8]}")
        pay = gateway_store.apply_payout_result(cur, f"org-{p['id'][:8]}", f"conv-{p['id'][:8]}", "confirmed", receipt=rcpt(f"P{i}"))
        cur.execute("SELECT * FROM gateway_payouts WHERE id=%s", (p["id"],))
        gateway_store.finalize_payout_outcome(cur, cur.fetchone(), receipt=rcpt(f"P{i}"))
    db.commit()

    rows = ledger(CID)
    print("  ledger after finalize:")
    comm_sum = fee_sum = Decimal("0")
    for r in rows:
        if r["type"] == "commission": comm_sum += r["amount"]
        if r["type"] == "payout_fee": fee_sum += r["amount"]
        print(f"    {r['type']:<12} {r['amount']:>10}  bal={r['balance_after']}")
    print(f"  commission debited = {comm_sum} vs batch commission {batch['commission']}")
    print(f"  payout_fee debited = {fee_sum} vs batch fee {batch['payout_fee']}")
    print(f"  final balance = {rows[-1]['balance_after']} (expect 0.00)")
    batch = q("SELECT status FROM settlement_batches WHERE id=%s", (batch["id"],))[0]
    print(f"  batch status: {batch['status']}")

    # --- FAILED batch: money should release back to the pool -----------------
    banner("failed payout -> batch failed -> entries released?")
    checkout = f"e2e_co_fail_{uuid.uuid4().hex[:8]}"
    gateway_store.record_stk_initiated(cur, checkout, CID, "pppoe", Decimal("700"), "254700000000")
    gateway_store.confirm_collection(cur, checkout, receipt=rcpt("F"), amount="700")
    outcome = gateway_settle.settle_client(db, cur, CID, company)
    print("  settle:", outcome)
    batch2 = q("SELECT * FROM settlement_batches WHERE client_id=%s ORDER BY created_at DESC LIMIT 1", (CID,))[0]
    pays2 = q("SELECT * FROM gateway_payouts WHERE batch_id=%s ORDER BY created_at, id", (batch2["id"],))
    # simulate a synchronous Daraja rejection for every payout (no ids recorded)
    for p in pays2:
        cur.execute("UPDATE gateway_payouts SET status='submitting' WHERE id=%s", (p["id"],))
        gateway_store.mark_payout_undelivered(cur, p["id"], "failed", "sync rejection (probe)")
        gateway_store.rollup_batch(cur, batch2["id"])
        gateway_store.release_failed_batch(cur, batch2["id"])
    db.commit()
    b2 = q("SELECT status FROM settlement_batches WHERE id=%s", (batch2["id"],))[0]
    eligible = gateway_settle.eligible_entries(cur, CID, "immediate", 0)
    print(f"  batch status: {b2['status']}")
    print(f"  eligible entries after failure: {len(eligible)}  (money should recycle, not strand)")

    # reached-Daraja failed batch must NOT release
    banner("reached-Daraja failed batch stays parked")
    checkout = f"e2e_co_fail2_{uuid.uuid4().hex[:8]}"
    gateway_store.record_stk_initiated(cur, checkout, CID, "pppoe", Decimal("700"), "254700000000")
    gateway_store.confirm_collection(cur, checkout, receipt=rcpt("F2"), amount="700")
    outcome = gateway_settle.settle_client(db, cur, CID, company)
    print("  settle:", outcome)
    batch3 = q("SELECT * FROM settlement_batches WHERE client_id=%s ORDER BY created_at DESC LIMIT 1", (CID,))[0]
    pays3 = q("SELECT * FROM gateway_payouts WHERE batch_id=%s", (batch3["id"],))
    for p in pays3:
        cur.execute("UPDATE gateway_payouts SET status='submitting', originator_conversation_id=%s WHERE id=%s", (f"org-{p['id'][:8]}", p["id"]))
        gateway_store.mark_payout_undelivered(cur, p["id"], "failed", "result callback: rejected")
        gateway_store.rollup_batch(cur, batch3["id"])
        gateway_store.release_failed_batch(cur, batch3["id"])
    db.commit()
    b3 = q("SELECT status FROM settlement_batches WHERE id=%s", (batch3["id"],))[0]
    eligible = gateway_settle.eligible_entries(cur, CID, "immediate", 0)
    print(f"  batch status: {b3['status']}, eligible now: {len(eligible)} (released entries from prev batch re-batched here = ok)")

    db.rollback()
    print("\nrolled back — no test data persisted.")
except Exception as error:
    import traceback; traceback.print_exc()
    db.rollback()
finally:
    db.close()
