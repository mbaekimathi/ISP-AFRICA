"""PPPoE client SMS for expiry (before/after) and STK payment-link backup."""

from datetime import date, timedelta
from decimal import Decimal

import gateway_store


def ensure_pay_token(cursor, subscriber_id):
    """Stable public token used in SMS payment links."""
    import secrets

    cursor.execute("SELECT pay_token FROM pppoe_subscribers WHERE id = %s", (subscriber_id,))
    row = cursor.fetchone() or {}
    token = str(row.get("pay_token") or "").strip()
    if token:
        return token
    token = secrets.token_urlsafe(18)[:24]
    cursor.execute(
        "UPDATE pppoe_subscribers SET pay_token = %s WHERE id = %s AND (pay_token IS NULL OR pay_token = '')",
        (token, subscriber_id),
    )
    if cursor.rowcount == 0:
        cursor.execute("SELECT pay_token FROM pppoe_subscribers WHERE id = %s", (subscriber_id,))
        token = str((cursor.fetchone() or {}).get("pay_token") or token).strip()
    return token


def payment_link(cursor, subscriber_id):
    """Absolute public pay URL, or empty when the public base is unknown."""
    base = gateway_store.public_base(cursor)
    if not base:
        return ""
    token = ensure_pay_token(cursor, subscriber_id)
    return f"{base}/api/public/pay/{token}" if token else ""


def client_pref_enabled(cursor, client_id, key):
    import api as api_mod

    cursor.execute("SELECT * FROM isp_client_notification_settings WHERE client_id = %s", (client_id,))
    prefs = api_mod.public_notification_settings(cursor.fetchone(), api_mod.ISP_CLIENT_NOTIFICATION_TOGGLES)
    return bool(prefs.get(key, True))


def resolve_client_message(cursor, client_id, key):
    import api as api_mod

    return api_mod.resolve_notification_message(
        cursor,
        api_mod.ISP_CLIENT_NOTIFICATION_DEFAULT_MESSAGES,
        key,
        client_id=client_id,
        audience="client",
    )


def subscriber_message_values(cursor, row, extra=None):
    link = payment_link(cursor, row["id"])
    name = f"{row.get('first_name') or ''} {row.get('last_name') or ''}".strip() or "customer"
    package = str(row.get("package_name") or row.get("package") or "internet package").strip()
    expiry = row.get("expiry_date")
    if hasattr(expiry, "strftime"):
        expiry_text = expiry.strftime("%d %b %Y")
    else:
        expiry_text = str(expiry or "").strip() or "soon"
    amount = row.get("amount")
    if amount is None:
        amount = row.get("price") or row.get("package_price") or ""
    try:
        amount_text = format(Decimal(amount or 0), ".2f")
    except Exception:
        amount_text = str(amount or "").strip() or "0.00"
    values = {
        "name": name,
        "package": package,
        "expiry": expiry_text,
        "amount": amount_text,
        "phone": str(row.get("phone") or "").strip(),
        "link": link or "your provider",
        "username": str(row.get("pppoe_username") or "").strip(),
        "router": str(row.get("router_name") or "").strip() or "your router",
    }
    if extra:
        values.update(extra)
    return values


def send_client_sms(cursor, client_id, phone, message):
    import api as api_mod

    _mode, sms = api_mod.load_active_sms(cursor, client_id)
    if not sms:
        return {"ok": False, "reason": "No SMS gateway is configured."}
    details = api_mod.communication_details(sms.get("details"))
    if details.get("enabled") is False:
        return {"ok": False, "reason": "The SMS channel is turned off."}
    return api_mod.send_sms(sms, phone, message)


def notify_subscriber(cursor, row, event_key, extra=None):
    """Send one client-notification SMS when the toggle is on."""
    client_id = str(row.get("client_id") or "")
    phone = str(row.get("phone") or "").strip()
    if not client_id or not phone:
        return False
    if not client_pref_enabled(cursor, client_id, event_key):
        return False
    import api as api_mod

    template = resolve_client_message(cursor, client_id, event_key)
    if not template:
        return False
    message = api_mod.fill_notification_message(template, subscriber_message_values(cursor, row, extra)).strip()
    if not message:
        return False
    result = send_client_sms(cursor, client_id, phone, message)
    return bool(result.get("ok"))


def notify_stk_pushed(cursor, row, amount):
    """Backup SMS with a payment link whenever an STK prompt is started."""
    import api as api_mod

    client_id = str(row.get("client_id") or "")
    phone = str(row.get("phone") or "").strip()
    if not client_id or not phone:
        return False
    extra = {"amount": format(Decimal(amount or 0), ".2f")}
    template = resolve_client_message(cursor, client_id, "stkPushed") or (
        "Hi {name}, an M-Pesa prompt of KSh {amount} was sent. "
        "If you missed it, pay here: {link}"
    )
    message = api_mod.fill_notification_message(
        template, subscriber_message_values(cursor, row, extra)
    ).strip()
    if not message:
        return False
    return bool(send_client_sms(cursor, client_id, phone, message).get("ok"))


def _subscriber_billing_row(cursor, subscriber_id):
    cursor.execute(
        """
        SELECT s.id, s.client_id, s.first_name, s.last_name, s.phone, s.pppoe_username, s.status,
               s.pay_token, sub.expiry_date, sub.price, sub.ending_notice_on, sub.expired_notice_on,
               p.name AS package_name, d.name AS router_name
        FROM pppoe_subscribers s
        LEFT JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        LEFT JOIN isp_packages p ON p.id = s.package_id
        LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
        WHERE s.id = %s AND s.deleted = 0
        """,
        (subscriber_id,),
    )
    return cursor.fetchone()


def mark_notice(cursor, subscriber_id, column, day):
    cursor.execute(
        f"UPDATE pppoe_subscriptions SET {column} = %s WHERE subscriber_id = %s",
        (day.isoformat(), subscriber_id),
    )


def notify_expiry_for_subscriber(cursor, subscriber_id, kind):
    """kind is 'ending' (day before) or 'expired' (after cut-off)."""
    row = _subscriber_billing_row(cursor, subscriber_id)
    if not row:
        return False
    today = date.today()
    if kind == "ending":
        noticed = row.get("ending_notice_on")
        if noticed and str(noticed) == today.isoformat():
            return False
        if not notify_subscriber(cursor, row, "subscriptionEnding"):
            return False
        mark_notice(cursor, subscriber_id, "ending_notice_on", today)
        return True
    if kind == "expired":
        noticed = row.get("expired_notice_on")
        expiry = row.get("expiry_date")
        if noticed and expiry and str(noticed) == str(expiry):
            return False
        if not notify_subscriber(cursor, row, "subscriptionExpired"):
            return False
        mark_notice(cursor, subscriber_id, "expired_notice_on", expiry or today)
        return True
    return False


def dispatch_expiry_notices(cursor, client_id=None):
    """Send before-expiry and after-expiry SMS with payment links."""
    today = date.today()
    tomorrow = today + timedelta(days=1)
    params = []
    client_filter = ""
    if client_id:
        client_filter = " AND s.client_id = %s"
        params.append(client_id)

    cursor.execute(
        f"""
        SELECT s.id
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        WHERE s.deleted = 0 AND s.service = 'pppoe'
          AND s.status IN ('active', 'pending_activation')
          AND sub.expiry_date = %s
          AND (sub.ending_notice_on IS NULL OR sub.ending_notice_on <> %s)
          {client_filter}
        """,
        [tomorrow.isoformat(), today.isoformat(), *params],
    )
    for row in cursor.fetchall():
        try:
            notify_expiry_for_subscriber(cursor, row["id"], "ending")
        except Exception as error:
            print(f"event=pppoe-ending-sms sub={row['id']} error={error}", flush=True)

    cursor.execute(
        f"""
        SELECT s.id
        FROM pppoe_subscribers s
        JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
        WHERE s.deleted = 0 AND s.service = 'pppoe'
          AND s.status = 'expired'
          AND sub.expiry_date IS NOT NULL
          AND sub.expiry_date <= %s
          AND (sub.expired_notice_on IS NULL OR sub.expired_notice_on <> sub.expiry_date)
          {client_filter}
        """,
        [today.isoformat(), *params],
    )
    for row in cursor.fetchall():
        try:
            notify_expiry_for_subscriber(cursor, row["id"], "expired")
        except Exception as error:
            print(f"event=pppoe-expired-sms sub={row['id']} error={error}", flush=True)
