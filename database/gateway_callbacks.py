"""Company-gateway Daraja callbacks — /api/daraja/<callback_secret>/<endpoint>.

Endpoints (all POST, all acked immediately):
  stk                  M-Pesa Express result for pooled STK pushes
  c2b/validation       C2B pre-check — logged and accepted
  c2b/confirmation     C2B payment notice — pooled or suspense
  b2c/result, b2c/timeout     payout results for phone destinations
  b2b/result, b2b/timeout     payout results for paybill/till destinations
  account-balance      float answer for the settlement scheduler's checks

Every handler follows the system's proof rule: the raw event is logged and
deduped first, the ack goes out immediately, and real work runs on its own
connection. Nothing here trusts a callback alone — collection crediting
still goes through stkpushquery before money or service moves.
"""

import hmac
import json
import threading
import time

import gateway_store

ENDPOINTS = {
    "stk",
    "c2b/validation",
    "c2b/confirmation",
    "b2c/result",
    "b2c/timeout",
    "b2b/result",
    "b2b/timeout",
    "account-balance",
}

ACK = {"ResultCode": 0, "ResultDesc": "Accepted"}

# How long a pooled STK prompt stays credible before the sweep fails it.
STK_STALE_MINUTES = 3
STK_EXPIRE_MINUTES = 30


def route(path):
    """/api/daraja/<secret>/<endpoint> -> (secret, endpoint) or None."""
    parts = [part for part in str(path or "").split("/") if part]
    if len(parts) < 4 or parts[:2] != ["api", "daraja"]:
        return None
    endpoint = "/".join(parts[3:])
    if endpoint not in ENDPOINTS:
        return None
    return parts[2], endpoint


def secret_ok(cursor, supplied):
    """Constant-time compare; 404-worthy misses must not reveal anything."""
    expected = gateway_store.callback_secret(cursor)
    return bool(expected and supplied and hmac.compare_digest(str(supplied), str(expected)))


def handle(cursor, endpoint, payload):
    """Log + dedupe inside the request transaction. Returns True when this
    event is new and should be processed after the ack is sent."""
    event_id = gateway_store.log_callback_event(cursor, endpoint, payload)
    return event_id


def enqueue(connect, endpoint, payload, event_id=None):
    """Process on a fresh connection after the ack — never inside the request."""
    thread = threading.Thread(
        target=_guarded, args=(connect, endpoint, payload, event_id), daemon=True, name="gateway-callback"
    )
    thread.start()


def _guarded(connect, endpoint, payload, event_id):
    try:
        process(connect, endpoint, payload)
        _mark(connect, event_id, "processed")
    except Exception as error:
        print(f"event=gateway-callback endpoint={endpoint} error={type(error).__name__}", flush=True)
        _mark(connect, event_id, "failed")


def _mark(connect, event_id, status):
    if not event_id:
        return
    try:
        with connect() as db:
            with db.cursor() as cursor:
                gateway_store.mark_event_processed(cursor, event_id, status)
                db.commit()
    except Exception:
        pass


def process(connect, endpoint, payload):
    if endpoint == "stk":
        process_stk(connect, payload)
    elif endpoint == "c2b/confirmation":
        process_c2b_confirmation(connect, payload)
    elif endpoint == "account-balance":
        process_account_balance(connect, payload)
    elif endpoint.startswith(("b2c/", "b2b/")):
        process_payout_result(connect, endpoint, payload)
    # c2b/validation is ack-only for now — the confirmation decides crediting.


# --- STK collection -----------------------------------------------------------


def _metadata(stk_callback):
    items = (stk_callback.get("CallbackMetadata") or {}).get("Item") or []
    return {item.get("Name"): item.get("Value") for item in items}


def process_stk(connect, payload):
    """Verify an Express callback with stkpushquery, then credit exactly once.

    The callback itself never proves the money moved; it only tells us to go
    ask Daraja. Whoever wins the FOR UPDATE claim — this processor, a phone
    poll, or the sweep — writes the one collection ledger entry and runs the
    one subscriber credit."""
    import portal_server

    callback = ((payload or {}).get("Body") or {}).get("stkCallback") or {}
    checkout_id = callback.get("CheckoutRequestID")
    if not checkout_id:
        return
    result_code = str(callback.get("ResultCode", ""))
    meta = _metadata(callback)
    receipt = meta.get("MpesaReceiptNumber")
    amount = meta.get("Amount")
    msisdn = str(meta.get("PhoneNumber") or "")
    raw = json.dumps(payload)
    if result_code != "0":
        _fail_stk(connect, checkout_id, result_code, callback.get("ResultDesc") or "", raw)
        return
    with connect() as db:
        with db.cursor() as cursor:
            settings = portal_server.daraja_settings(cursor, _payment_client(cursor, checkout_id))
    if not settings or not settings.get("gateway_pool"):
        return
    verified = _verify_stk(settings, checkout_id)
    if verified is None:
        return  # Daraja unreachable — the sweep will try again later
    if verified != "paid":
        _fail_stk(connect, checkout_id, "query", verified, raw)
        return
    _credit_stk(connect, checkout_id, receipt, amount, msisdn, raw)


def _payment_client(cursor, checkout_id):
    cursor.execute(
        "SELECT client_id FROM gateway_payments WHERE checkout_id = %s",
        (str(checkout_id or "")[:64],),
    )
    row = cursor.fetchone()
    return (row or {}).get("client_id")


def _verify_stk(settings, checkout_id):
    """Ask Daraja for the truth. Returns 'paid', a failure string, or None
    when the query could not be made (leave it for the next attempt)."""
    import portal_server

    try:
        result, queried = portal_server.stk_query_shared(settings, checkout_id)
    except Exception:
        return None
    if result is None:
        return None
    state, reason = portal_server.stk_state(result)
    # A still-pending prompt is not a failure — leave it for the next attempt.
    if state == "pending":
        return None
    return "paid" if state == "paid" else (reason or "Payment was declined.")


def _credit_stk(connect, checkout_id, receipt, amount, msisdn, raw):
    pending = None
    vouchers = []
    with connect() as db:
        with db.cursor() as cursor:
            outcome = gateway_store.confirm_collection(
                cursor, checkout_id, receipt=receipt, amount=amount, msisdn=msisdn, raw=raw
            )
            if outcome in (None, "already"):
                db.commit()
                return
            if outcome == "unmatched":
                db.commit()
                _notify_unmatched(connect, checkout_id, "amount-mismatch")
                return
            pending, vouchers = fulfil_stk_credit(cursor, checkout_id)
            db.commit()
    if pending:
        _authorize_hotspot(connect, pending, vouchers)
    print(f"event=gateway-collection checkout={checkout_id[-6:]} state=confirmed", flush=True)


def fulfil_stk_credit(cursor, checkout_id):
    """Credit the subscriber for a confirmed pooled payment — the same claim
    the portal poll takes, so whichever path gets there first wins and the
    other sees status already paid. Returns (pending, vouchers) for hotspot
    purchases so the caller can authorize the router after the commit."""
    import portal_server
    import pppoe_store

    checkout_id = str(checkout_id or "")[:64]
    cursor.execute(
        "SELECT mpesa_receipt FROM gateway_payments WHERE checkout_id = %s",
        (checkout_id,),
    )
    receipt = (cursor.fetchone() or {}).get("mpesa_receipt")
    cursor.execute(
        """
        UPDATE pppoe_stk_requests SET status = 'processing'
        WHERE checkout_id = %s AND (status = 'pending' OR (status = 'failed' AND mpesa_code <> ''))
        """,
        (checkout_id,),
    )
    if cursor.rowcount:
        cursor.execute(
            """
            SELECT r.id, r.client_id, r.subscriber_id, r.package_id, r.package_price,
                   r.amount, r.checkout_id, r.mpesa_code, p.name AS package_name
            FROM pppoe_stk_requests r
            LEFT JOIN isp_packages p ON p.id = r.package_id
            WHERE r.checkout_id = %s
            """,
            (checkout_id,),
        )
        request = cursor.fetchone()
        if request:
            cursor.execute(
                "SELECT package_id FROM pppoe_subscribers WHERE id = %s",
                (request["subscriber_id"],),
            )
            current = cursor.fetchone()
            if request.get("package_id") and current and str(request["package_id"]) != str(current["package_id"]):
                cursor.execute(
                    "UPDATE pppoe_subscribers SET package_id = %s WHERE id = %s",
                    (request["package_id"], request["subscriber_id"]),
                )
                cursor.execute(
                    "UPDATE pppoe_subscriptions SET package_id = %s, price = %s WHERE subscriber_id = %s",
                    (request["package_id"], request["package_price"], request["subscriber_id"]),
                )
            pppoe_store.renew(
                cursor,
                request["client_id"],
                request["subscriber_id"],
                {
                    "amount": format(request["amount"], ".2f"),
                    "mpesaReference": (receipt or request.get("mpesa_code") or checkout_id)[:40],
                },
            )
            cursor.execute(
                """
                UPDATE pppoe_stk_requests
                SET status = 'paid', paid_at = NOW(), mpesa_code = COALESCE(%s, mpesa_code)
                WHERE checkout_id = %s
                """,
                (receipt, checkout_id),
            )
        return None, []
    cursor.execute(
        """
        UPDATE hotspot_purchases SET status = 'paid', paid_at = NOW(),
            mpesa_code = COALESCE(%s, mpesa_code)
        WHERE checkout_id = %s AND (status = 'pending' OR (status = 'failed' AND mpesa_code <> ''))
        """,
        (receipt, checkout_id),
    )
    claimed = cursor.rowcount
    row = portal_server.hotspot_pending_for(cursor, checkout_id)
    # The claim covers the normal path; the re-issue branch repairs a purchase
    # marked paid whose voucher insert never landed (crash between commits) —
    # issue_hotspot_vouchers is idempotent, so paid-with-vouchers is untouched.
    if row and (claimed or (
        row["status"] == "paid"
        and not portal_server.hotspot_voucher_list(cursor, row["purchase_id"])
    )):
        pending = portal_server.hotspot_pending_from_row(row)
        return pending, portal_server.issue_hotspot_vouchers(cursor, pending)
    return None, []


def _authorize_hotspot(connect, pending, vouchers):
    """Mirror the portal's post-commit router authorization for a hotspot
    purchase fulfilled off-poll (callback or sweep)."""
    import portal_server

    try:
        grant = portal_server.authorize_hotspot_grant(pending, vouchers[0] if vouchers else None)
    except Exception as error:
        grant = {"username": "", "password": "", "authorized": False, "error": str(error)}
    with connect() as db:
        with db.cursor() as cursor:
            if vouchers and grant.get("online"):
                cursor.execute(
                    """
                    UPDATE hotspot_vouchers
                    SET status = 'used', used_at = NOW(), redeemed_ip = %s, redeemed_mac = %s
                    WHERE id = %s AND status = 'issued'
                    """,
                    (pending["ip"], pending["mac"], vouchers[0]["id"]),
                )
            cursor.execute(
                """
                UPDATE hotspot_purchases
                SET username = %s, password = %s, authorized = %s
                WHERE id = %s
                """,
                (
                    grant["username"],
                    grant["password"],
                    1 if grant.get("authorized") else 0,
                    pending["purchase_id"],
                ),
            )
            db.commit()


def _fail_stk(connect, checkout_id, code, reason, raw):
    status = "cancelled" if code == "1032" else "failed"
    with connect() as db:
        with db.cursor() as cursor:
            # Only pooled checkouts are ours to touch — a forged or stray
            # payload naming someone else's request must never change it.
            if _payment_client(cursor, checkout_id) is None:
                db.commit()
                return
            gateway_store.fail_collection(cursor, checkout_id, status, reason, raw)
            # Mirror the portal's outcome onto the tracked requests so their
            # poll answers failed instead of pending forever.
            cursor.execute(
                "UPDATE pppoe_stk_requests SET status = 'failed', last_error = %s WHERE checkout_id = %s AND status = 'pending'",
                (str(reason or "Payment was declined.")[:255], str(checkout_id or "")[:64]),
            )
            cursor.execute(
                "UPDATE hotspot_purchases SET status = 'failed' WHERE checkout_id = %s AND status = 'pending'",
                (str(checkout_id or "")[:64],),
            )
            db.commit()


def _notify_unmatched(connect, checkout_id, reason):
    import gateway_notify

    with connect() as db:
        with db.cursor() as cursor:
            cursor.execute(
                "SELECT id, client_id, amount FROM gateway_payments WHERE checkout_id = %s",
                (str(checkout_id or "")[:64],),
            )
            payment = cursor.fetchone()
            if not payment:
                db.commit()
                return
            gateway_notify.send(
                cursor,
                gateway_notify.notice(
                    "company",
                    "unmatched_payment",
                    "A pooled payment needs review",
                    f"{reason}; payment {payment['id'][:8]} amount KES {payment['amount']}",
                    client_id=payment["client_id"],
                ),
            )
            db.commit()


# --- C2B ----------------------------------------------------------------------


def process_c2b_confirmation(connect, payload):
    """Unattributed C2B money goes to suspense — never auto-assigned."""
    body = payload or {}
    receipt = body.get("TransID")
    amount = body.get("TransAmount")
    msisdn = body.get("MSISDN")
    bill_ref = body.get("BillRefNumber") or body.get("BillRef")
    raw = json.dumps(payload)
    if not receipt:
        return
    with connect() as db:
        with db.cursor() as cursor:
            payment_id = gateway_store.record_c2b_unmatched(
                cursor, receipt, amount, msisdn, bill_ref, raw
            )
            if payment_id:
                import gateway_notify

                gateway_notify.send(
                    cursor,
                    gateway_notify.notice(
                        "company",
                        "unmatched_payment",
                        "Unmatched M-Pesa payment received",
                        f"Receipt {receipt} KES {amount} ref {bill_ref or '—'}",
                    ),
                )
            db.commit()


# --- Payout results -------------------------------------------------------------


def process_payout_result(connect, endpoint, payload):
    """Result or timeout for a submitted payout — status update, ledger
    finalization, batch rollup and the notifications all land in one
    transaction, so a duplicate callback is a strict no-op."""
    result = ((payload or {}).get("Result") or {})
    originator = result.get("OriginatorConversationID")
    conversation = result.get("ConversationID")
    timed_out = endpoint.endswith("/timeout")
    if timed_out:
        status, receipt, error = "timed_out", None, "Daraja reported a queue timeout."
    else:
        code = str(result.get("ResultCode", ""))
        status = "confirmed" if code == "0" else "failed"
        receipt = _result_receipt(result)
        error = result.get("ResultDesc")
    with connect() as db:
        with db.cursor() as cursor:
            payout = gateway_store.apply_payout_result(
                cursor, originator, conversation, status, receipt=receipt, error=error,
                extra_ids=_inner_conversation_ids(result),
            )
            if payout:
                # Refresh the row — apply_payout_result just rewrote it.
                cursor.execute(
                    "SELECT * FROM gateway_payouts WHERE id = %s", (payout["id"],)
                )
                payout = cursor.fetchone() or payout
                gateway_store.finalize_payout_outcome(cursor, payout, receipt=receipt)
                _notify_payout_outcome(cursor, payout, status, receipt, error)
            db.commit()
    if payout:
        print(
            f"event=gateway-payout payout={str(payout['id'])[:8]} state={status}",
            flush=True,
        )


def _inner_conversation_ids(result):
    """Transaction Status answers echo the original transaction's
    OriginatorConversationID inside ResultParameters."""
    ids = []
    for item in ((result.get("ResultParameters") or {}).get("ResultParameter") or []):
        if item.get("Key") in ("OriginatorConversationID", "OriginalConversationID"):
            ids.append(item.get("Value"))
    return ids


def _notify_payout_outcome(cursor, payout, status, receipt, error):
    import gateway_notify

    amount = payout.get("amount")
    where = f"{payout.get('destination_type') or ''} {gateway_store.mask_msisdn(payout.get('destination_value'))}"
    if status == "confirmed":
        notice = gateway_notify.notice(
            "client", "payout_delivered", "Settlement paid",
            f"KES {amount} sent to {where.strip()} — ref {receipt or 'pending'}",
            client_id=payout.get("client_id"),
        )
    elif status == "timed_out":
        notice = gateway_notify.notice(
            "company", "payout_review", "Payout timed out — verify before action",
            f"KES {amount} to {where.strip()} queued past Daraja's timeout; run Transaction Status before retrying.",
            client_id=payout.get("client_id"),
        )
    else:
        notice = gateway_notify.notice(
            "company", "payout_failed", "Payout failed",
            f"KES {amount} to {where.strip()}: {str(error or '')[:120]}",
            client_id=payout.get("client_id"),
        )
    gateway_notify.send(cursor, notice)


def _result_receipt(result):
    for item in ((result.get("ResultParameters") or {}).get("ResultParameter") or []):
        if item.get("Key") in ("TransactionID", "ReceiptNo"):
            return item.get("Value")
    return None


# --- Account Balance ------------------------------------------------------------


def process_account_balance(connect, payload):
    """Store the async Account Balance answer — the scheduler reads
    last_known_balance when deciding whether a batch can be covered. A
    failed or unparseable result never overwrites the last good figure."""
    result = ((payload or {}).get("Result") or {})
    if int(result.get("ResultCode") or -1) != 0:
        return
    balance = parse_account_balance(result)
    if balance is None:
        return
    with connect() as db:
        with db.cursor() as cursor:
            gateway_store.record_balance_check(cursor, balance)
            db.commit()


def parse_account_balance(result):
    """Daraja returns accounts as "Name|Currency|min|current|available|reserved|uncleared"
    blocks joined by '&'. Take the sum of available balances; None when the
    body can't be understood (never guess a float)."""
    from decimal import Decimal, InvalidOperation

    for item in ((result.get("ResultParameters") or {}).get("ResultParameter") or []):
        if item.get("Key") != "AccountBalance":
            continue
        total = Decimal("0")
        found = False
        for block in str(item.get("Value") or "").split("&"):
            fields = block.split("|")
            if len(fields) >= 5:
                try:
                    total += Decimal(fields[4].strip() or "0")
                    found = True
                except InvalidOperation:
                    continue
        return total if found else None
    return None


# --- Stale-payment sweep --------------------------------------------------------


def sweep(connect):
    """Resolve pooled STK rows the phone stopped polling. Verified payments
    still credit; expired prompts fail so the ops views stay honest."""
    import portal_server

    with connect() as db:
        with db.cursor() as cursor:
            stale = gateway_store.stale_initiated_payments(cursor, STK_STALE_MINUTES)
            clients = {row["client_id"] for row in stale if row.get("client_id")}
            settings_by_client = {}
            for client_id in clients:
                settings_by_client[client_id] = portal_server.daraja_settings(cursor, client_id)
    for row in stale:
        try:
            checkout_id = row["checkout_id"]
            settings = settings_by_client.get(row.get("client_id"))
            if not settings or not settings.get("gateway_pool"):
                continue
            age_ok = (time.time() - row["created_at"].timestamp()) < STK_EXPIRE_MINUTES * 60
            verified = _verify_stk(settings, checkout_id)
            if verified is None:
                continue
            if verified == "paid":
                _credit_stk(connect, checkout_id, None, None, "", None)
            elif not age_ok:
                _fail_stk(connect, checkout_id, "expired", "The prompt expired before it was paid.", None)
        except Exception as error:
            print(f"event=gateway-sweep checkout={str(row.get('checkout_id'))[-6:]} error={type(error).__name__}", flush=True)
