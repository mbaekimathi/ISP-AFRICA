"""Pooled settlement scheduler — turns confirmed collections into payouts.

Runs once a minute on its own daemon inside api.py, guarded by a MySQL
GET_LOCK so only one instance settles even if the process is ever doubled.
For every client on gateway_mode='company_gateway' the cycle:

  1. Locks the client's isp_payout_settings row (the per-client serializer)
     and applies a pending destination change whose cooling-off has ended.
  2. Collects confirmed, unbatched collection entries — immediately, or once
     confirmed_at + hold_hours has passed for delayed settlement.
  3. net = gross - commission - estimated payout fee. Below the minimum
     payout the money simply carries forward to the next cycle.
  4. Creates the settlement batch, links its entries, and queues the
     payouts — all in one transaction, so a crash mid-batch leaves no
     half-written state and the next run resumes cleanly. Batch and payout
     keys are deterministic, so a retried insert is a no-op.
  5. If net exceeds the max-per-transaction cap it splits into several
     payouts; each carries a destination snapshot taken at queue time.
  6. Account Balance on the payout shortcode is requested on a throttle —
     results arrive on the account-balance callback and are stored. When a
     fresh balance is known and can't cover the batch, the payouts stay
     queued and the director is alerted.
  7. Queued payouts are submitted to Daraja (B2C / BusinessPayBill /
     BusinessBuyGoods). The claim commits before the network call so a crash
     can never silently re-send; a synchronous rejection fails the payout,
     a transport unknown parks it as needs_review, and money-moving calls
     are never retried automatically. Submitted payouts whose result
     callback never arrives are reconciled via Transaction Status, whose
     answers land on the same result endpoints.
"""

import hashlib
import json
import time
import uuid
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP

import gateway_store

LOCK_NAME = "isp-gateway-settlement"
BALANCE_CHECK_SECONDS = 300
BALANCE_FRESH_SECONDS = 900
LEDGER_KINDS = ("collection", "reversal", "adjustment")


# --- reads -------------------------------------------------------------------


def company_gateway_settings(cursor):
    cursor.execute(
        """
        SELECT id, environment, account_type, short_code, consumer_key, consumer_secret,
               passkey, initiator_name, initiator_password_enc, payout_shortcode,
               certificate,
               status, kill_switch, commission_percent, commission_flat,
               default_hold_hours, min_payout, max_payout_per_tx, payout_fee_estimate,
               last_known_balance, last_balance_at, txn_fees_enabled
        FROM company_daraja_settings WHERE id = 1
        """
    )
    return cursor.fetchone()


def settlement_clients(cursor):
    cursor.execute(
        """
        SELECT client_id, settlement_mode, hold_hours, destination_type,
               destination_value, account_reference, min_payout_override,
               pending_change, pending_change_effective_at,
               settle_every_n_tx, settle_schedule, last_settled_at
        FROM isp_payout_settings WHERE gateway_mode = 'company_gateway'
        """
    )
    return list(cursor.fetchall())


def lock_client_settings(cursor, client_id):
    cursor.execute(
        """
        SELECT client_id, settlement_mode, hold_hours, destination_type,
               destination_value, account_reference, min_payout_override,
               pending_change, pending_change_effective_at,
               settle_every_n_tx, settle_schedule, last_settled_at, gateway_mode
        FROM isp_payout_settings WHERE client_id = %s FOR UPDATE
        """,
        (client_id,),
    )
    return cursor.fetchone()


def eligible_entries(cursor, client_id, settlement_mode, hold_hours):
    """Confirmed, unbatched ledger entries whose hold period has elapsed."""
    sql = """
        SELECT e.id, e.payment_id, e.type, e.amount, e.created_at, p.confirmed_at
        FROM gateway_ledger_entries e
        LEFT JOIN gateway_payments p ON p.id = e.payment_id
        LEFT JOIN settlement_batch_entries be ON be.ledger_entry_id = e.id
        WHERE e.client_id = %s AND be.ledger_entry_id IS NULL
          AND e.type IN ('collection', 'reversal', 'adjustment')
          AND (e.type <> 'collection' OR p.status = 'confirmed')
    """
    params = [client_id]
    if settlement_mode == "delayed":
        sql += " AND COALESCE(p.confirmed_at, e.created_at) <= DATE_SUB(NOW(), INTERVAL %s HOUR)"
        params.append(max(1, int(hold_hours or 24)))
    sql += " ORDER BY e.created_at, e.id"
    cursor.execute(sql, params)
    return list(cursor.fetchall())


_WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
}


def _last_occurrence(entry, now):
    """The most recent time this schedule entry fired, at or before now."""
    import datetime as _dt

    day = str((entry or {}).get("day") or "daily")
    time_text = str((entry or {}).get("time") or "")
    parts = time_text.split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return None
    hour, minute = int(parts[0]), int(parts[1])
    if hour > 23 or minute > 59:
        return None
    if day == "daily":
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return candidate if candidate <= now else candidate - _dt.timedelta(days=1)
    weekday = _WEEKDAYS.get(day)
    if weekday is None:
        return None
    candidate = (now - _dt.timedelta(days=(now.weekday() - weekday) % 7)).replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )
    if candidate > now:
        candidate -= _dt.timedelta(days=7)
    return candidate


def schedule_due(schedule_text, last_settled_at, now=None):
    """True when any period in the schedule has fired since the last settle —
    entries are [{day: daily|weekday, time: HH:MM}], multiple allowed."""
    import datetime as _dt

    now = now or _dt.datetime.now()
    try:
        entries = json.loads(schedule_text or "[]")
    except ValueError:
        entries = []
    if not isinstance(entries, list):
        return False
    for entry in entries:
        occurrence = _last_occurrence(entry, now)
        if occurrence and (last_settled_at is None or occurrence > last_settled_at):
            return True
    return False


# --- pending destination changes ------------------------------------------------


def apply_pending_change(cursor, row):
    """Cooling-off ended -> the queued destination becomes live, atomically."""
    raw = row.get("pending_change")
    if not raw:
        return None
    try:
        change = json.loads(raw)
    except (TypeError, ValueError):
        return None
    cursor.execute(
        """
        UPDATE isp_payout_settings
        SET destination_type = %s, destination_value = %s, account_reference = %s,
            pending_change = NULL, pending_change_effective_at = NULL
        WHERE client_id = %s AND pending_change_effective_at IS NOT NULL
          AND pending_change_effective_at <= NOW()
        """,
        (
            change.get("destination_type"),
            str(change.get("destination_value") or "")[:32],
            str(change.get("account_reference") or "")[:32],
            row["client_id"],
        ),
    )
    if not cursor.rowcount:
        return None
    gateway_store.audit(
        cursor, row["client_id"], "system", "gateway", "destination.applied",
        old={"pending": True}, new=change,
    )
    return change


# --- planning --------------------------------------------------------------------


def _money(value):
    return Decimal(str(value or "0")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def split_amount(net, count):
    """net into `count` whole-cent chunks; the last one takes the remainder."""
    each = (net / count).quantize(Decimal("0.01"), rounding=ROUND_FLOOR)
    parts = [each] * count
    parts[-1] += net - each * count
    return parts


def plan_batch(entries, company, client_row, bands=None):
    """gross - commission - estimated fees - banded charges -> payout
    amounts, or None when the money carries forward to the next cycle."""
    gross = sum((_money(e["amount"]) for e in entries if e["type"] == "collection"), Decimal("0"))
    other = sum((_money(e["amount"]) for e in entries if e["type"] != "collection"), Decimal("0"))
    if gross <= 0:
        return None
    commission = _money(
        gross * Decimal(str(company["commission_percent"] or 0)) / 100
        + Decimal(str(company["commission_flat"] or 0))
    )
    base = gross + other - commission
    max_tx = _money(company["max_payout_per_tx"])
    count = max(1, int((base / max_tx).to_integral_value(rounding=ROUND_CEILING))) if max_tx > 0 else 1
    est_each = _money(company["payout_fee_estimate"])
    amounts = []
    if company.get("txn_fees_enabled") and bands:
        # Banded charges: each payout's fee comes out of the amount collected
        # for it — the balance is what Daraja actually sends.
        for share in split_amount(base, int(count)):
            send = share - est_each - gateway_store.band_fee(bands, share)
            if send > 0:
                amounts.append(send)
        net = sum(amounts, Decimal("0"))
        fee = base - net
    else:
        fee = est_each * count
        net = base - fee
    minimum = client_row.get("min_payout_override")
    minimum = _money(minimum) if minimum is not None else _money(company["min_payout"])
    if net < minimum or net <= 0:
        return None
    if not amounts:
        amounts = split_amount(net, int(count))
    return {
        "gross": gross,
        "commission": commission,
        "fee": fee,
        "net": net,
        "amounts": amounts,
        "period_from": min(e["created_at"] for e in entries),
        "period_to": max(e["created_at"] for e in entries),
    }


# --- writing the batch -------------------------------------------------------------


def create_batch(cursor, client_id, destination, entries, plan):
    """Batch + entry links + queued payouts, deterministic keys throughout.

    batch:{client}:{first-entry-id} is stable for a given eligible set, and
    payout keys append the split index — a crashed or duplicated run simply
    hits the unique keys and picks up where it stopped."""
    batch_key = f"batch:{client_id}:{entries[0]['id']}"
    batch_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO settlement_batches
          (id, client_id, batch_key, period_from, period_to, gross, commission, payout_fee, net, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'scheduled')
        ON DUPLICATE KEY UPDATE id = id
        """,
        (
            batch_id,
            client_id,
            batch_key[:80],
            plan["period_from"],
            plan["period_to"],
            plan["gross"],
            plan["commission"],
            plan["fee"],
            plan["net"],
        ),
    )
    cursor.execute("SELECT id FROM settlement_batches WHERE batch_key = %s", (batch_key[:80],))
    batch_id = cursor.fetchone()["id"]
    cursor.executemany(
        "INSERT IGNORE INTO settlement_batch_entries (batch_id, ledger_entry_id) VALUES (%s, %s)",
        [(batch_id, entry["id"]) for entry in entries],
    )
    for index, amount in enumerate(plan["amounts"]):
        # f"{batch_key}:{index}" exceeds the 80-char key column once real ids
        # are in it — hash it so the index always differentiates the key;
        # truncating silently collapsed every payout in a batch onto one key.
        idempotency_key = hashlib.sha256(f"{batch_key}:{index}".encode()).hexdigest()[:64]
        cursor.execute(
            """
            INSERT INTO gateway_payouts
              (id, batch_id, client_id, destination_type, destination_value,
               account_reference, amount, idempotency_key, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'queued')
            ON DUPLICATE KEY UPDATE id = id
            """,
            (
                str(uuid.uuid4()),
                batch_id,
                client_id,
                destination.get("destination_type"),
                str(destination.get("destination_value") or "")[:32],
                str(destination.get("account_reference") or "")[:32],
                amount,
                idempotency_key,
            ),
        )
    gateway_store.audit(
        cursor, client_id, "system", "gateway", "batch.created",
        new={"batchId": batch_id, "net": str(plan["net"]), "payouts": len(plan["amounts"])},
    )
    return batch_id


_balance_requested_at = 0.0


# --- payout execution (Phase 5) -----------------------------------------------------


def _callback_base(cursor):
    """(base, secret) for building callback URLs, or None when the gateway
    has no public HTTPS endpoint configured."""
    base = gateway_store.public_base(cursor)
    secret = gateway_store.callback_secret(cursor)
    if not base or not secret or not base.startswith("https://"):
        return None
    return base, secret


def _callback_urls(base, secret, kind):
    return (
        f"{base}/api/daraja/{secret}/{kind}/result",
        f"{base}/api/daraja/{secret}/{kind}/timeout",
    )


def execute_payouts(db, cursor, client, limit=25, notify=None):
    """Submit queued payouts to Daraja. Claim commits BEFORE the network call:
    a crash between request and response leaves the row 'submitting' — an
    orphan the next tick parks as needs_review, never an automatic re-send.
    With no public callback URL nothing is claimed at all: ResultURL is
    mandatory, so payouts simply wait until the gateway is reachable."""
    notify = notify or _default_notify
    cb = _callback_base(cursor)
    if not cb:
        return {"skipped": "no-callback-url"}
    base, secret = cb
    sent = {"submitted": 0, "failed": 0, "needs_review": 0}
    for payout in gateway_store.claim_queued_payouts(cursor, limit):
        db.commit()  # persist the claim before money can move
        kind = "b2c" if payout["destination_type"] == "phone" else "b2b"
        result_url, timeout_url = _callback_urls(base, secret, kind)
        try:
            response = _send_payout(client, payout, result_url, timeout_url)
            code = str((response or {}).get("ResponseCode", ""))
            if code == "0":
                gateway_store.mark_payout_submitted(
                    cursor, payout["id"],
                    response.get("OriginatorConversationID"),
                    response.get("ConversationID"),
                )
                sent["submitted"] += 1
            else:
                gateway_store.mark_payout_undelivered(
                    cursor, payout["id"], "failed",
                    response.get("ResponseDescription") or "Daraja rejected the payout.",
                )
                sent["failed"] += 1
        except _timeout_errors():
            gateway_store.mark_payout_undelivered(
                cursor, payout["id"], "needs_review",
                "Daraja unreachable after send — verify with Transaction Status.",
            )
            sent["needs_review"] += 1
        except Exception as error:
            gateway_store.mark_payout_undelivered(
                cursor, payout["id"], "failed", str(error)[:200]
            )
            sent["failed"] += 1
        gateway_store.rollup_batch(cursor, payout["batch_id"])
        gateway_store.release_failed_batch(cursor, payout["batch_id"])
        db.commit()
        print(
            f"event=gateway-payout-submit payout={payout['id'][:8]} kind={kind} "
            f"to={gateway_store.mask_msisdn(payout['destination_value'])}",
            flush=True,
        )
    return sent


def _send_payout(client, payout, result_url, timeout_url):
    amount = payout["amount"]
    destination = payout["destination_value"]
    remarks = str(payout.get("note") or f"ISP settlement {str(payout['id'])[:8]}")[:97]
    if payout["destination_type"] == "phone":
        return client.b2c(destination, amount, result_url, timeout_url, remarks=remarks)
    if payout["destination_type"] == "paybill":
        return client.b2b_paybill(
            destination, amount, payout.get("account_reference") or "",
            result_url, timeout_url, remarks=remarks,
        )
    return client.b2b_buygoods(destination, amount, result_url, timeout_url, remarks=remarks)


def _timeout_errors():
    import daraja_client

    return (daraja_client.DarajaTimeout, TimeoutError, ConnectionError, OSError)


def reconcile_submitted(db, cursor, client, limit=10):
    """Submitted payouts whose result callback never arrived — ask Daraja via
    Transaction Status (safe, retryable); the answer lands on the same
    b2c/b2b result endpoints and matches by inner conversation id."""
    # Anything stuck in 'submitting' is an orphan from a crashed send — the
    # outcome is unknown, so a human (or Transaction Status) resolves it.
    cursor.execute(
        "UPDATE gateway_payouts SET status = 'needs_review', "
        "last_error = 'send interrupted — verify with Transaction Status' "
        "WHERE status = 'submitting'"
    )
    parked = cursor.rowcount
    queried = 0
    cb = _callback_base(cursor)
    if not cb:
        return {"orphaned": parked, "queried": 0}
    base, secret = cb
    for payout in gateway_store.stale_submitted_payouts(cursor, limit=limit):
        kind = "b2c" if payout["destination_type"] == "phone" else "b2b"
        result_url, timeout_url = _callback_urls(base, secret, kind)
        try:
            client.transaction_status(
                transaction_id=payout.get("mpesa_receipt"),
                original_conversation_id=(
                    None if payout.get("mpesa_receipt") else payout.get("originator_conversation_id")
                ),
                result_url=result_url, timeout_url=timeout_url,
                remarks=f"Status {str(payout['id'])[:8]}",
            )
            queried += 1
        except Exception as error:
            print(
                f"event=gateway-status-query payout={payout['id'][:8]} error={type(error).__name__}",
                flush=True,
            )
    return {"orphaned": parked, "queried": queried}


def check_payout_status(cursor, payout_id, actor_id="", client=None):
    """Director-initiated Transaction Status probe for one payout. The
    answer arrives on the normal b2c/b2b result callback and finalizes the
    same way — this only sends the query."""
    cb = _callback_base(cursor)
    if not cb:
        return None, "No public callback URL is configured (ISP_GATEWAY_PUBLIC_URL, or open the director payments page through the server's public https address)."
    base, secret = cb
    company = company_gateway_settings(cursor)
    if not company:
        return None, "The company gateway is not configured."
    cursor.execute(
        "SELECT id, destination_type, status, mpesa_receipt, "
        "originator_conversation_id FROM gateway_payouts WHERE id = %s",
        (payout_id,),
    )
    payout = cursor.fetchone()
    if not payout:
        return None, "Payout not found."
    if payout["status"] not in ("submitted", "timed_out", "needs_review"):
        return None, f"This payout is {payout['status']} — nothing to check."
    if not payout.get("mpesa_receipt") and not payout.get("originator_conversation_id"):
        return None, "No transaction identifiers recorded — it never reached Daraja."
    kind = "b2c" if payout["destination_type"] == "phone" else "b2b"
    result_url, timeout_url = _callback_urls(base, secret, kind)
    client = client or company_client(company)
    client.transaction_status(
        transaction_id=payout.get("mpesa_receipt") or None,
        original_conversation_id=(
            None if payout.get("mpesa_receipt") else payout.get("originator_conversation_id")
        ),
        result_url=result_url, timeout_url=timeout_url,
        remarks=f"Status {str(payout_id)[:8]}",
    )
    gateway_store.audit(cursor, None, "employee", actor_id, "payout.status_check",
                        new={"payoutId": payout_id})
    return {"queried": payout_id}, None


def settle_client(db, cursor, client_id, company, notify=None):
    """One client's full settle pass — commits on success, caller rolls back
    on error so a broken client never stalls the rest."""
    notify = notify or _default_notify
    row = lock_client_settings(cursor, client_id)
    if not row:
        db.commit()
        return None
    applied = apply_pending_change(cursor, row)
    if applied:
        row["destination_type"] = applied.get("destination_type")
        row["destination_value"] = str(applied.get("destination_value") or "")[:32]
        row["account_reference"] = str(applied.get("account_reference") or "")[:32]
    entries = eligible_entries(
        cursor, row["client_id"], row["settlement_mode"], row["hold_hours"]
    )
    if not entries:
        db.commit()
        return None
    if not row.get("destination_type") or not row.get("destination_value"):
        db.commit()
        return {"skipped": "no-destination"}
    mode = row["settlement_mode"]
    if mode == "transactions":
        threshold = max(1, int(row.get("settle_every_n_tx") or 0))
        collected = sum(1 for entry in entries if entry["type"] == "collection")
        if collected < threshold:
            db.commit()
            return {"skipped": "below-transaction-threshold"}
    elif mode == "scheduled" and not schedule_due(
        row.get("settle_schedule"), row.get("last_settled_at")
    ):
        db.commit()
        return {"skipped": "not-due"}
    plan = plan_batch(entries, company, row, gateway_store.fee_bands(cursor))
    if not plan:
        db.commit()
        return {"carried": len(entries)}
    batch_id = create_batch(cursor, row["client_id"], row, entries, plan)
    if mode == "scheduled":
        cursor.execute(
            "UPDATE isp_payout_settings SET last_settled_at = NOW() WHERE client_id = %s",
            (row["client_id"],),
        )
    shortfall = _balance_shortfall(company, plan["net"])
    if shortfall:
        notify(
            cursor,
            "company",
            "low_float",
            "Payout float is short of a scheduled settlement",
            f"Queued KES {plan['net']} for {client_id[:8]} against a last-known float of KES {company['last_known_balance']}.",
            client_id=row["client_id"],
        )
    db.commit()
    return {"batch": batch_id, "net": plan["net"], "payouts": len(plan["amounts"]), "shortfall": shortfall}


def manual_transfer(cursor, client_id, amount, reason, actor_id, notify=None):
    """Director-initiated payout to a client's configured destination, sent
    outside the settlement schedule. The pool is debited up front with an
    'adjustment' entry — the per-client settings lock serializes this against
    settle_client, and the unbatched adjustment shrinks the next scheduled
    batch by the same amount so the money can't be paid out twice. A failed
    payout is returned by a 'reversal' entry (refund_manual_payout).

    Amounts above the max-per-transaction cap split into several queued
    payouts; the scheduler's execute_payouts submits them like any batch."""
    notify = notify or _default_notify
    company = company_gateway_settings(cursor)
    if not company:
        return None, "The company gateway is not configured."
    if company["status"] != "active" or company["kill_switch"]:
        return None, "The gateway is halted — resume it before sending transfers."
    client_id = str(client_id or "").strip()
    if not client_id:
        return None, "Choose the client to pay."
    row = lock_client_settings(cursor, client_id)
    if not row:
        return None, "That client has no payout settings."
    if row.get("gateway_mode") != "company_gateway":
        return None, "That client is not pooled on the company gateway."
    applied = apply_pending_change(cursor, row)
    if applied:
        row["destination_type"] = applied.get("destination_type")
        row["destination_value"] = str(applied.get("destination_value") or "")[:32]
        row["account_reference"] = str(applied.get("account_reference") or "")[:32]
    if not row.get("destination_type") or not row.get("destination_value"):
        return None, "Set this client's payout destination first."
    try:
        amount = _money(amount)
    except Exception:
        return None, "Enter a valid amount."
    if amount <= 0:
        return None, "Enter an amount above zero."
    balance = gateway_store._last_balance(cursor, client_id)
    if amount > balance:
        return None, f"Only KES {balance} is held for this client."
    reason = str(reason or "").strip()[:160]
    batch_key = f"manual:{client_id}:{uuid.uuid4().hex[:20]}"
    batch_id = str(uuid.uuid4())
    import datetime as _dt

    now = _dt.datetime.now()
    cursor.execute(
        """
        INSERT INTO settlement_batches
          (id, client_id, batch_key, period_from, period_to, gross, commission,
           payout_fee, net, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'processing')
        """,
        (batch_id, client_id, batch_key[:80], now, now, amount, 0, 0, amount),
    )
    max_tx = _money(company["max_payout_per_tx"])
    count = max(1, int((amount / max_tx).to_integral_value(rounding=ROUND_CEILING))) if max_tx > 0 else 1
    payout_ids = []
    for index, part in enumerate(split_amount(amount, int(count))):
        idempotency_key = hashlib.sha256(f"{batch_key}:{index}".encode()).hexdigest()[:64]
        payout_id = str(uuid.uuid4())
        payout_ids.append(payout_id)
        cursor.execute(
            """
            INSERT INTO gateway_payouts
              (id, batch_id, client_id, destination_type, destination_value,
               account_reference, amount, idempotency_key, note, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'queued')
            """,
            (
                payout_id,
                batch_id,
                client_id,
                row["destination_type"],
                str(row["destination_value"])[:32],
                str(row.get("account_reference") or "")[:32],
                part,
                idempotency_key,
                reason,
            ),
        )
    # Debit now — the unbatched adjustment flows into the next scheduled
    # plan_batch as `other`, reducing that payout by exactly this amount.
    cursor.execute(
        """
        INSERT INTO gateway_ledger_entries
          (id, client_id, payout_id, type, amount, balance_after)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (str(uuid.uuid4()), client_id, payout_ids[0], "adjustment", -amount, balance - amount),
    )
    gateway_store.audit(
        cursor, client_id, "employee", actor_id, "transfer.manual",
        new={"batchId": batch_id, "amount": str(amount), "payouts": count,
             "reason": reason or None},
    )
    destination = (
        gateway_store.mask_msisdn(row["destination_value"])
        if row["destination_type"] == "phone"
        else f"{row['destination_type']} {row['destination_value']}"
    )
    detail = f"KES {amount} sent to {destination}"
    if reason:
        detail = f"{detail} — {reason}"
    notify(
        cursor, "client", "manual_transfer", "A manual transfer was sent to you",
        detail, client_id=client_id,
    )
    shortfall = _balance_shortfall(company, amount)
    if shortfall:
        notify(
            cursor, "company", "low_float",
            "Payout float is short of a manual transfer",
            f"Queued KES {amount} for {client_id[:8]} against a last-known float of KES {company['last_known_balance']}.",
            client_id=client_id,
        )
    return {
        "ok": True,
        "batchId": batch_id,
        "amount": str(amount),
        "payouts": int(count),
        "destination": str(destination),
        "floatShort": bool(shortfall),
        "balanceAfter": str(balance - amount),
    }, None


def _held_in_window(cursor, client_id, hold_hours):
    """Confirmed collections still inside the delayed-settlement hold —
    count and the earliest release time."""
    cursor.execute(
        """
        SELECT COUNT(*) AS n,
               MIN(COALESCE(p.confirmed_at, e.created_at)) AS earliest
        FROM gateway_ledger_entries e
        LEFT JOIN gateway_payments p ON p.id = e.payment_id
        LEFT JOIN settlement_batch_entries be ON be.ledger_entry_id = e.id
        WHERE e.client_id = %s AND be.ledger_entry_id IS NULL
          AND e.type = 'collection' AND p.status = 'confirmed'
          AND COALESCE(p.confirmed_at, e.created_at) >
              DATE_SUB(NOW(), INTERVAL %s HOUR)
        """,
        (client_id, max(1, int(hold_hours or 24))),
    )
    row = cursor.fetchone() or {}
    earliest = row.get("earliest")
    releases = None
    if earliest is not None:
        import datetime as _dt

        releases = earliest + _dt.timedelta(hours=max(1, int(hold_hours or 24)))
    return int(row.get("n") or 0), releases


def _unbatched_collections(cursor, client_id):
    cursor.execute(
        """
        SELECT COUNT(*) AS n FROM gateway_ledger_entries e
        LEFT JOIN gateway_payments p ON p.id = e.payment_id
        LEFT JOIN settlement_batch_entries be ON be.ledger_entry_id = e.id
        WHERE e.client_id = %s AND be.ledger_entry_id IS NULL
          AND e.type = 'collection' AND p.status = 'confirmed'
        """,
        (client_id,),
    )
    return int((cursor.fetchone() or {}).get("n") or 0)


def _describe_schedule(schedule_text):
    try:
        entries = json.loads(schedule_text or "[]")
    except ValueError:
        entries = []
    parts = []
    for entry in entries[:4]:
        day = str((entry or {}).get("day") or "")
        label = "daily" if day == "daily" else day[:3].title()
        parts.append(f"{label} {entry.get('time') or ''}".strip())
    suffix = ", ".join(part for part in parts if part)
    return suffix or "no times set"


def held_reason(cursor, row, company, bands=None):
    """Why a pooled client's balance hasn't settled yet — mirrors the checks
    settle_client runs, in the same order. Returns {code, message} or None
    when nothing is held."""
    balance = _money(row.get("balance"))
    if balance <= 0 or row.get("gateway_mode") != "company_gateway":
        return None
    if not company:
        return {"code": "unconfigured", "message": "The company gateway is not configured."}
    if company["kill_switch"]:
        return {"code": "kill_switch", "message": "All payouts are halted by the gateway kill switch."}
    if company["status"] != "active":
        return {"code": "suspended",
                "message": f"The gateway is {company['status']} — payouts resume when it is active."}
    if not row.get("destination_type") or not row.get("destination_value"):
        return {"code": "no_destination",
                "message": "No payout destination is set — money waits for one."}
    client_id = row["client_id"]
    mode = row.get("settlement_mode")
    hold_hours = row.get("hold_hours")
    entries = eligible_entries(cursor, client_id, mode, hold_hours)
    if not entries:
        if mode == "delayed" and _unbatched_collections(cursor, client_id):
            held, releases = _held_in_window(cursor, client_id, hold_hours)
            when = releases.strftime("%Y-%m-%d %H:%M") if releases else "later"
            return {"code": "hold",
                    "message": f"Each payment is held {max(1, int(hold_hours or 24))}h after confirmation — "
                               f"{held} release{'s' if held != 1 else ''} next at ~{when}."}
        return {"code": "residual",
                "message": "No payments left to batch — release this balance with a manual transfer."}
    if mode == "transactions":
        threshold = max(1, int(row.get("settle_every_n_tx") or 0))
        collected = sum(1 for entry in entries if entry["type"] == "collection")
        if collected < threshold:
            return {"code": "threshold",
                    "message": f"Settles after {threshold} payments per batch — {collected} collected so far."}
    elif mode == "scheduled" and not schedule_due(
        row.get("settle_schedule"), row.get("last_settled_at")
    ):
        return {"code": "schedule",
                "message": f"Waits for the next scheduled settlement ({_describe_schedule(row.get('settle_schedule'))})."}
    plan = plan_batch(entries, company, row, bands or [])
    if not plan:
        minimum = row.get("min_payout_override")
        minimum = _money(minimum) if minimum is not None else _money(company["min_payout"])
        return {"code": "minimum",
                "message": f"Below the KES {minimum} minimum payout after commission and fees."}
    message = "Settles automatically on the next run."
    if mode == "delayed":
        held, releases = _held_in_window(cursor, client_id, hold_hours)
        if held:
            when = releases.strftime("%Y-%m-%d %H:%M") if releases else "later"
            message += f" {held} more payment{'s' if held != 1 else ''} still inside the hold — first releases ~{when}."
    if _balance_shortfall(company, plan["net"]):
        message += " The payout float looks short of this amount."
    return {"code": "eligible", "message": message}


def held_reasons(cursor, rows):
    """Attach the hold explanation to each client_custody row in place."""
    company = company_gateway_settings(cursor)
    bands = gateway_store.fee_bands(cursor)
    for row in rows:
        row["hold"] = held_reason(cursor, row, company, bands)
    return rows


def _balance_shortfall(company, net):
    balance = company.get("last_known_balance")
    checked = company.get("last_balance_at")
    if balance is None or not checked:
        return False
    import datetime as _dt

    fresh = (_dt.datetime.now() - checked).total_seconds() < BALANCE_FRESH_SECONDS
    return fresh and _money(balance) < _money(net)


def _default_notify(cursor, audience, kind, subject, detail, client_id=None):
    import gateway_notify

    gateway_notify.send(
        cursor,
        gateway_notify.notice(audience, kind, subject, detail, client_id=client_id),
    )


def request_balance_check(cursor, company, client):
    """Throttle Account Balance queries — the answer lands asynchronously on
    the account-balance callback, so at most one goes out per window. The
    stored balance is left untouched until a real answer arrives; a request
    that never gets its callback must not erase what we last knew."""
    global _balance_requested_at
    if time.time() - _balance_requested_at < BALANCE_CHECK_SECONDS:
        return False
    cb = _callback_base(cursor)
    if not cb:
        return False
    base, secret = cb
    url = f"{base}/api/daraja/{secret}/account-balance"
    try:
        client.account_balance(url, url)
    except Exception as error:
        print(f"event=gateway-balance error={type(error).__name__}", flush=True)
        return False
    _balance_requested_at = time.time()
    return True


def company_client(company):
    """Build the Daraja client for payout-side calls from stored settings."""
    import daraja_client
    import gateway_crypto
    import routeros_api

    def open_stored(value):
        if not value:
            return ""
        try:
            return routeros_api.open_password(value)
        except routeros_api.RouterError:
            try:
                return gateway_crypto.open_secret(value)
            except gateway_crypto.GatewayCryptoError:
                return ""

    return daraja_client.DarajaClient(
        daraja_client.DarajaConfig(
            environment=company["environment"],
            consumer_key=company["consumer_key"],
            consumer_secret=open_stored(company["consumer_secret"]),
            short_code=company["short_code"],
            passkey=open_stored(company["passkey"]),
            account_type=company["account_type"],
            initiator_name=company.get("initiator_name") or "",
            initiator_password=open_stored(company.get("initiator_password_enc")),
            payout_shortcode=company.get("payout_shortcode") or "",
            certificate=company.get("certificate") or "",
        )
    )


def settlement_tick(connect, client_factory=None, notify=None):
    """One scheduler run: the GET_LOCK makes this a no-op when another
    instance holds it — safe against overlapping timers and duplicate hosts.
    The lock lives on this one connection for the whole tick."""
    with connect() as db:
        with db.cursor() as cursor:
            try:
                cursor.execute("SELECT GET_LOCK(%s, 0) AS got", (LOCK_NAME,))
                if int((cursor.fetchone() or {}).get("got") or 0) != 1:
                    return {"skipped": "locked"}
                company = company_gateway_settings(cursor)
                if not company or company["status"] != "active" or company["kill_switch"]:
                    return {"skipped": "inactive"}
                clients = settlement_clients(cursor)
                daraja = client_factory(company) if client_factory is not None else None
                if daraja is not None:
                    request_balance_check(cursor, company, daraja)
                db.commit()
                results = {}
                for row in clients:
                    try:
                        outcome = settle_client(db, cursor, row["client_id"], company, notify=notify)
                        if outcome:
                            results[row["client_id"]] = outcome
                    except Exception as error:
                        db.rollback()
                        print(
                            f"event=gateway-settle client={row['client_id'][:8]} error={type(error).__name__}",
                            flush=True,
                        )
                if daraja is not None:
                    try:
                        results["payouts"] = execute_payouts(
                            db, cursor, daraja, notify=notify
                        )
                        results["reconcile"] = reconcile_submitted(db, cursor, daraja)
                    except Exception as error:
                        db.rollback()
                        print(
                            f"event=gateway-payout-exec error={type(error).__name__}",
                            flush=True,
                        )
                return results
            finally:
                cursor.execute("SELECT RELEASE_LOCK(%s)", (LOCK_NAME,))
                db.commit()
