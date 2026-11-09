"""Optional ISP-owned Paybill (C2B) auto-credit.

Company gateway C2B is always on for pooled Paybills. An ISP on own_daraja
can opt in so manual Lipa na M-Pesa payments to their own shortcode renew
subscribers when the account number matches a PPPoE username. Off by default.
"""

from __future__ import annotations

import hmac
import json
import secrets
import threading
import uuid
from decimal import Decimal, InvalidOperation

import pymysql

import gateway_crypto
import gateway_store

ACK = {"ResultCode": 0, "ResultDesc": "Accepted"}

ENDPOINTS = {"c2b/validation", "c2b/confirmation"}


def ensure_schema(cursor):
    for column, definition in (
        ("c2b_enabled", "c2b_enabled TINYINT NOT NULL DEFAULT 0"),
        ("c2b_secret_enc", "c2b_secret_enc VARCHAR(512) NULL"),
        ("c2b_registered_at", "c2b_registered_at DATETIME NULL"),
        ("c2b_register_ok", "c2b_register_ok TINYINT NOT NULL DEFAULT 0"),
        ("c2b_register_detail", "c2b_register_detail VARCHAR(255) NOT NULL DEFAULT ''"),
    ):
        cursor.execute("SHOW COLUMNS FROM isp_payout_settings LIKE %s", (column,))
        if cursor.fetchone() is None:
            cursor.execute(f"ALTER TABLE isp_payout_settings ADD COLUMN {definition}")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_c2b_payments (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          subscriber_id CHAR(36) NULL,
          msisdn VARCHAR(20) NOT NULL DEFAULT '',
          amount DECIMAL(12,2) NOT NULL,
          mpesa_receipt VARCHAR(40) NULL,
          account_reference VARCHAR(40) NOT NULL DEFAULT '',
          status ENUM('confirmed', 'unmatched') NOT NULL DEFAULT 'unmatched',
          reason VARCHAR(255) NOT NULL DEFAULT '',
          raw_callback MEDIUMTEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_isp_c2b_receipt (mpesa_receipt),
          KEY idx_isp_c2b_client (client_id, created_at)
        )
        """
    )


def route(path):
    """/api/daraja/isp/<secret>/<endpoint> -> (secret, endpoint) or None."""
    parts = [part for part in str(path or "").split("/") if part]
    if len(parts) < 5 or parts[:3] != ["api", "daraja", "isp"]:
        return None
    endpoint = "/".join(parts[4:])
    if endpoint not in ENDPOINTS:
        return None
    return parts[3], endpoint


def client_for_secret(cursor, supplied):
    """Resolve an enabled ISP by callback secret — None when unknown/disabled."""
    if not supplied:
        return None
    cursor.execute(
        """
        SELECT client_id, c2b_secret_enc, c2b_enabled
        FROM isp_payout_settings
        WHERE c2b_secret_enc IS NOT NULL AND c2b_secret_enc <> ''
        """
    )
    for row in cursor.fetchall() or []:
        if not int(row.get("c2b_enabled") or 0):
            continue
        opened = gateway_crypto.open_secret(row.get("c2b_secret_enc"))
        if opened and hmac.compare_digest(str(supplied), str(opened)):
            return row["client_id"]
    return None


def ensure_secret(cursor, client_id):
    cursor.execute(
        "SELECT c2b_secret_enc FROM isp_payout_settings WHERE client_id = %s",
        (client_id,),
    )
    row = cursor.fetchone() or {}
    existing = row.get("c2b_secret_enc")
    if existing:
        opened = gateway_crypto.open_secret(existing)
        if opened:
            return opened
    token = secrets.token_urlsafe(24)
    cursor.execute(
        """
        INSERT INTO isp_payout_settings (client_id, c2b_secret_enc)
        VALUES (%s, %s)
        ON DUPLICATE KEY UPDATE c2b_secret_enc = VALUES(c2b_secret_enc)
        """,
        (client_id, gateway_crypto.seal(token)),
    )
    return token


def set_enabled(cursor, client_id, enabled):
    ensure_schema(cursor)
    cursor.execute(
        "INSERT INTO isp_payout_settings (client_id) VALUES (%s) "
        "ON DUPLICATE KEY UPDATE client_id = client_id",
        (client_id,),
    )
    secret = ensure_secret(cursor, client_id) if enabled else None
    cursor.execute(
        "UPDATE isp_payout_settings SET c2b_enabled = %s WHERE client_id = %s",
        (1 if enabled else 0, client_id),
    )
    if enabled and secret is None:
        secret = ensure_secret(cursor, client_id)
    return bool(enabled)


def resolve_subscriber(cursor, client_id, bill_reference):
    """Match BillRefNumber to a PPPoE username owned by this ISP only."""
    ref = str(bill_reference or "").strip()
    if not ref:
        return None
    cursor.execute(
        """
        SELECT id AS subscriber_id, client_id, pppoe_username, package_id
        FROM pppoe_subscribers
        WHERE client_id = %s AND deleted = 0 AND service = 'pppoe'
          AND LOWER(pppoe_username) = LOWER(%s)
        LIMIT 2
        """,
        (client_id, ref[:64]),
    )
    rows = list(cursor.fetchall() or [])
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1 or len(ref) < 3:
        return None
    cursor.execute(
        """
        SELECT id AS subscriber_id, client_id, pppoe_username, package_id
        FROM pppoe_subscribers
        WHERE client_id = %s AND deleted = 0 AND service = 'pppoe'
          AND LOWER(pppoe_username) LIKE CONCAT(LOWER(%s), '%%')
        LIMIT 2
        """,
        (client_id, ref[:64]),
    )
    rows = list(cursor.fetchall() or [])
    return rows[0] if len(rows) == 1 else None


def diagnose_ref(cursor, client_id, bill_reference):
    ref = str(bill_reference or "").strip()
    if not ref:
        return {
            "code": "missing_ref",
            "message": "No account number was entered on the Paybill payment",
        }
    matched = resolve_subscriber(cursor, client_id, ref)
    if matched:
        return {
            "code": "matched",
            "message": f"Matches PPPoE username {matched['pppoe_username']}",
            "subscriberId": matched["subscriber_id"],
            "username": matched["pppoe_username"],
        }
    if len(ref) >= 3:
        cursor.execute(
            """
            SELECT pppoe_username FROM pppoe_subscribers
            WHERE client_id = %s AND deleted = 0 AND service = 'pppoe'
              AND LOWER(pppoe_username) LIKE CONCAT(LOWER(%s), '%%')
            LIMIT 5
            """,
            (client_id, ref[:64]),
        )
        prefix = list(cursor.fetchall() or [])
        if len(prefix) > 1:
            names = ", ".join(row["pppoe_username"] for row in prefix[:3])
            return {
                "code": "ambiguous",
                "message": f"Account number matches more than one subscriber ({names})",
            }
    return {
        "code": "unknown_ref",
        "message": f"No PPPoE username matches account “{ref}”",
    }


def _amount_ok(amount):
    try:
        return Decimal(str(amount)) > 0
    except (InvalidOperation, TypeError, ValueError):
        return False


def record_payment(cursor, client_id, receipt, amount, msisdn, bill_ref, raw,
                   status, reason="", subscriber_id=None):
    payment_id = str(uuid.uuid4())
    try:
        cursor.execute(
            """
            INSERT INTO isp_c2b_payments
              (id, client_id, subscriber_id, msisdn, amount, mpesa_receipt,
               account_reference, status, reason, raw_callback)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                payment_id,
                client_id,
                subscriber_id,
                str(msisdn or "")[:20],
                amount,
                str(receipt or "")[:40],
                str(bill_ref or "")[:40],
                status,
                str(reason or "")[:255],
                raw,
            ),
        )
    except pymysql.MySQLError:
        return None
    return payment_id


def fulfil_credit(cursor, client_id, subscriber_id, amount, receipt, package_id):
    import pppoe_store

    try:
        money = format(Decimal(str(amount)), ".2f")
        pppoe_store.renew(
            cursor,
            client_id,
            subscriber_id,
            {
                "amount": money,
                "mpesaReference": str(receipt or "")[:40],
                "packageId": package_id,
            },
        )
        return True, ""
    except Exception as error:
        return False, str(error)[:200]


def process_confirmation(connect, client_id, payload):
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
            ensure_schema(cursor)
            matched = resolve_subscriber(cursor, client_id, bill_ref) if _amount_ok(amount) else None
            if matched:
                payment_id = record_payment(
                    cursor,
                    client_id,
                    receipt,
                    amount,
                    msisdn,
                    bill_ref,
                    raw,
                    "confirmed",
                    "Auto-matched to subscriber",
                    matched["subscriber_id"],
                )
                if not payment_id:
                    db.commit()
                    return
                ok, err = fulfil_credit(
                    cursor,
                    client_id,
                    matched["subscriber_id"],
                    amount,
                    receipt,
                    matched.get("package_id"),
                )
                if not ok:
                    cursor.execute(
                        "UPDATE isp_c2b_payments SET reason = %s WHERE id = %s",
                        (f"Matched but renew failed: {err}"[:255], payment_id),
                    )
                db.commit()
                print(
                    f"event=isp-c2b client={client_id[:8]} receipt={str(receipt)[-6:]} "
                    f"credit={'ok' if ok else 'failed'}",
                    flush=True,
                )
                return
            diagnosis = diagnose_ref(cursor, client_id, bill_ref)
            if not _amount_ok(amount):
                reason = "Invalid or zero payment amount"
            else:
                reason = diagnosis["message"]
            payment_id = record_payment(
                cursor,
                client_id,
                receipt,
                amount or 0,
                msisdn,
                bill_ref,
                raw,
                "unmatched",
                reason,
            )
            db.commit()
            if payment_id:
                print(
                    f"event=isp-c2b client={client_id[:8]} receipt={str(receipt)[-6:]} "
                    f"status=unmatched",
                    flush=True,
                )


def enqueue(connect, client_id, endpoint, payload):
    if endpoint != "c2b/confirmation":
        return
    thread = threading.Thread(
        target=_guarded,
        args=(connect, client_id, payload),
        daemon=True,
        name="isp-c2b-callback",
    )
    thread.start()


def _guarded(connect, client_id, payload):
    try:
        process_confirmation(connect, client_id, payload)
    except Exception as error:
        print(f"event=isp-c2b error={type(error).__name__}", flush=True)


def mark_registered(cursor, client_id, ok, detail=""):
    cursor.execute(
        """
        UPDATE isp_payout_settings
        SET c2b_registered_at = NOW(),
            c2b_register_ok = %s,
            c2b_register_detail = %s
        WHERE client_id = %s
        """,
        (1 if ok else 0, str(detail or "")[:255], client_id),
    )


def recent_activity(cursor, client_id, limit=25):
    cursor.execute(
        """
        SELECT id, subscriber_id, msisdn, amount, mpesa_receipt, account_reference,
               status, reason, created_at
        FROM isp_c2b_payments
        WHERE client_id = %s
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (client_id, int(limit)),
    )
    rows = []
    for row in cursor.fetchall() or []:
        rows.append(
            {
                "id": row["id"],
                "receipt": row.get("mpesa_receipt"),
                "accountReference": row.get("account_reference") or "",
                "amount": str(row.get("amount") or "0"),
                "msisdn": gateway_store.mask_msisdn(row.get("msisdn")),
                "status": row.get("status"),
                "reason": row.get("reason") or "",
                "subscriberId": row.get("subscriber_id"),
                "createdAt": row.get("created_at"),
            }
        )
    return rows


def health(cursor, client_id, payment_row=None):
    ensure_schema(cursor)
    base = gateway_store.public_base(cursor)
    cursor.execute(
        """
        SELECT gateway_mode, c2b_enabled, c2b_secret_enc, c2b_registered_at,
               c2b_register_ok, c2b_register_detail
        FROM isp_payout_settings WHERE client_id = %s
        """,
        (client_id,),
    )
    settings = cursor.fetchone() or {}
    enabled = bool(int(settings.get("c2b_enabled") or 0))
    secret = ""
    if settings.get("c2b_secret_enc"):
        secret = gateway_crypto.open_secret(settings["c2b_secret_enc"]) or ""
    if enabled and not secret:
        secret = ensure_secret(cursor, client_id)
    payment = payment_row or {}
    account_type = payment.get("account_type") or ""
    short_code = payment.get("short_code") or ""
    confirmation = (
        f"{base}/api/daraja/isp/{secret}/c2b/confirmation" if base and secret else ""
    )
    validation = (
        f"{base}/api/daraja/isp/{secret}/c2b/validation" if base and secret else ""
    )
    mode = settings.get("gateway_mode") or "none"
    checks = [
        {
            "key": "ownDaraja",
            "label": "Using your own Daraja / Paybill",
            "ok": mode == "own_daraja",
            "detail": (
                "Manual Paybill recognition on your shortcode needs own Daraja mode"
                if mode != "own_daraja"
                else f"Shortcode {short_code or '—'}"
            ),
        },
        {
            "key": "enabled",
            "label": "Optional auto-credit is turned on",
            "ok": enabled,
            "detail": "Off by default — enable below when you want manual Paybill payments to renew lines",
        },
        {
            "key": "callbackBase",
            "label": "Public HTTPS callback address",
            "ok": bool(base),
            "detail": base
            or "Ask the platform operator to set ISP_GATEWAY_PUBLIC_URL, or open company payments on the public https domain",
        },
        {
            "key": "paybill",
            "label": "Account type is Paybill",
            "ok": account_type == "paybill",
            "detail": (
                f"Paybill {short_code}"
                if account_type == "paybill"
                else "Till numbers cannot carry an account reference for matching"
            ),
        },
        {
            "key": "registered",
            "label": "C2B URLs registered with Safaricom",
            "ok": bool(int(settings.get("c2b_register_ok") or 0)),
            "detail": (
                settings.get("c2b_register_detail")
                or (
                    f"Last registered {settings.get('c2b_registered_at')}"
                    if settings.get("c2b_registered_at")
                    else "Not registered yet"
                )
            ),
        },
    ]
    cursor.execute(
        """
        SELECT
          SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS matched,
          SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched
        FROM isp_c2b_payments WHERE client_id = %s
        """,
        (client_id,),
    )
    counts = cursor.fetchone() or {}
    return {
        "optional": True,
        "enabled": enabled,
        "ready": all(item["ok"] for item in checks),
        "checks": checks,
        "confirmationUrl": confirmation if enabled else "",
        "validationUrl": validation if enabled else "",
        "registration": {
            "registeredAt": settings.get("c2b_registered_at"),
            "ok": bool(int(settings.get("c2b_register_ok") or 0)),
            "detail": settings.get("c2b_register_detail") or "",
            "accountType": account_type,
            "shortCode": short_code,
        },
        "counts": {
            "matched": int(counts.get("matched") or 0),
            "unmatched": int(counts.get("unmatched") or 0),
        },
        "recent": recent_activity(cursor, client_id) if enabled else [],
    }


def _explain_register_error(message, environment=""):
    text = str(message or "").strip()
    lower = text.lower()
    if "invalid access token" in lower or "401" in lower or "403" in lower:
        env = environment or "live/sandbox"
        return (
            f"{text} — Daraja rejected the token for C2B Register URL. On the M-Pesa "
            f"portal, open this {env} app and enable “Customer to Business Register URL” "
            f"(and C2B) for shortcode matching your Paybill, then re-save the consumer "
            f"key/secret here and try again. STK-only apps cannot register C2B URLs."
        )[:255]
    if "invalid" in lower and ("credential" in lower or "consumer" in lower):
        return (
            f"{text} — Check that the environment (sandbox/live) matches these consumer "
            f"key/secret values, then save and retry."
        )[:255]
    return text[:255] or "Daraja rejected the C2B registration."


def register(cursor, client_id, payment_row, open_secret_fn):
    """Register validation/confirmation URLs on the ISP's own shortcode."""
    import daraja_client

    health_body = health(cursor, client_id, payment_row)
    if not health_body.get("enabled"):
        return None, "Turn on optional manual Paybill recognition before registering URLs."
    if not health_body.get("confirmationUrl") or not health_body.get("validationUrl"):
        return None, "A public HTTPS callback address is required before registering C2B URLs."
    if not str(health_body["confirmationUrl"]).startswith("https://"):
        return None, "Daraja only accepts https callback URLs for C2B registration."
    if (payment_row or {}).get("account_type") != "paybill":
        return None, "Switch your account type to Paybill — Till numbers cannot carry an account reference."
    consumer_key = str((payment_row or {}).get("consumer_key") or "").strip()
    consumer_secret = str(open_secret_fn((payment_row or {}).get("consumer_secret")) or "").strip()
    passkey = str(open_secret_fn((payment_row or {}).get("passkey")) or "").strip()
    environment = str((payment_row or {}).get("environment") or "").strip()
    if not consumer_key or not consumer_secret:
        return None, "Saved consumer key/secret could not be read — paste them again under My Daraja API and save."
    try:
        client = daraja_client.DarajaClient(
            daraja_client.DarajaConfig(
                environment=environment,
                consumer_key=consumer_key,
                consumer_secret=consumer_secret,
                short_code=payment_row["short_code"],
                passkey=passkey,
                account_type=payment_row["account_type"],
            )
        )
        # Always mint a fresh token for Register URL — a cached STK token can
        # mask bad secrets and Daraja still answers "Invalid Access Token".
        client._drop_token()
        client.token()
        result = client.c2b_register(
            health_body["confirmationUrl"],
            health_body["validationUrl"],
            response_type="Completed",
        )
    except Exception as error:
        detail = _explain_register_error(error, environment)
        mark_registered(cursor, client_id, False, detail)
        return None, detail
    # Daraja sometimes returns HTTP 200 with an error payload.
    result_code = str((result or {}).get("ResponseCode") or (result or {}).get("errorCode") or "0")
    if result_code not in ("0", "00000000", ""):
        detail = _explain_register_error(
            (result or {}).get("ResponseDescription")
            or (result or {}).get("errorMessage")
            or result_code,
            environment,
        )
        mark_registered(cursor, client_id, False, detail)
        return None, detail
    detail = (
        (result or {}).get("ResponseDescription")
        or (result or {}).get("ConversationID")
        or "C2B URLs registered"
    )
    mark_registered(cursor, client_id, True, str(detail)[:255])
    # Keep the saved confirmation/validation fields in sync with generated URLs.
    cursor.execute(
        """
        UPDATE isp_payment_settings
        SET confirmation_url = %s, validation_url = %s
        WHERE client_id = %s AND scope = 'own'
        """,
        (health_body["confirmationUrl"], health_body["validationUrl"], client_id),
    )
    return {"c2b": health(cursor, client_id, payment_row), "result": result}, None
