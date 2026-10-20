"""Gateway read & ops endpoints — response shaping for the custody views.

Guards run in api.py (require_director / require_payment_client /
require_owner_client); the functions here take the already-resolved account
id and return plain data. Nothing in this module returns secrets — masked
destinations only — and nothing moves money except assign_unmatched, which
turns suspense into a confirmed collection under the same locks the rest of
the pipeline uses.
"""

import csv
import io
import json
from decimal import Decimal, InvalidOperation

import gateway_notify
import gateway_store

PAGE = 200


def _page(query):
    try:
        limit = min(500, max(1, int((query.get("limit") or [PAGE])[0])))
    except (TypeError, ValueError):
        limit = PAGE
    try:
        offset = max(0, int((query.get("offset") or [0])[0]))
    except (TypeError, ValueError):
        offset = 0
    return limit, offset


# --- director: company gateway -------------------------------------------------


def overview(cursor):
    return gateway_store.company_overview(cursor)


def clients(cursor):
    return {
        "clients": gateway_store.client_custody(cursor),
        "directory": gateway_store.client_directory(cursor),
    }


def payments(cursor, query):
    limit, offset = _page(query)
    client_id = (query.get("client") or [None])[0]
    status = (query.get("status") or [None])[0]
    return {"payments": gateway_store.custody_rows(
        cursor, client_id=client_id, status=status, limit=limit, offset=offset)}


def payouts(cursor, query):
    limit, offset = _page(query)
    client_id = (query.get("client") or [None])[0]
    status = (query.get("status") or [None])[0]
    return {"payouts": gateway_store.list_payouts(
        cursor, client_id=client_id, status=status, limit=limit, offset=offset)}


def batches(cursor, query):
    limit, offset = _page(query)
    client_id = (query.get("client") or [None])[0]
    return {"batches": gateway_store.list_batches(
        cursor, client_id=client_id, limit=limit, offset=offset)}


def ledger(cursor, query):
    limit, offset = _page(query)
    client_id = (query.get("client") or [None])[0]
    return {"entries": gateway_store.list_ledger(
        cursor, client_id, limit=limit, offset=offset)}


def suspense(cursor):
    return {"suspense": gateway_store.suspense_payments(cursor)}


def pending_changes(cursor):
    return {"pending": gateway_store.pending_destination_changes(cursor)}


def audit(cursor, query):
    limit, offset = _page(query)
    client_id = (query.get("client") or [None])[0]
    return {"audit": gateway_store.audit_rows(
        cursor, client_id=client_id, limit=limit, offset=offset)}


def notifications(cursor, query):
    limit, _ = _page(query)
    return {"notifications": gateway_notify.feed_items(cursor, "company", limit=limit)}


def settings_view(cursor):
    """The company's gateway ops knobs — secret fields never leave, only
    flags saying they exist."""
    row = gateway_store.company_gateway_row(cursor)
    if not row:
        return {"configured": False}
    return {
        "configured": True,
        "initiatorName": row.get("initiator_name") or "",
        "initiatorPasswordSet": bool(row.get("initiator_password_enc")),
        "payoutShortcode": row.get("payout_shortcode") or "",
        "status": row.get("status"),
        "killSwitch": bool(row.get("kill_switch")),
        "commissionPercent": str(row.get("commission_percent") or ""),
        "commissionFlat": str(row.get("commission_flat") or ""),
        "defaultHoldHours": row.get("default_hold_hours"),
        "minPayout": str(row.get("min_payout") or ""),
        "maxPayoutPerTx": str(row.get("max_payout_per_tx") or ""),
        "payoutFeeEstimate": str(row.get("payout_fee_estimate") or ""),
    }


def save_company_gateway(cursor, payload, actor_id):
    """Validate the ops write, then delegate the whitelisted update."""
    import daraja_client

    updates = {}
    if "initiatorName" in payload:
        updates["initiator_name"] = str(payload["initiatorName"] or "")[:60]
    if payload.get("initiatorPassword"):
        import gateway_crypto

        updates["initiator_password_enc"] = gateway_crypto.seal(
            str(payload["initiatorPassword"]))
    if "payoutShortcode" in payload:
        value = str(payload["payoutShortcode"] or "").strip()
        if value:
            try:
                value = daraja_client.validate_shortcode(value, "payout")
            except daraja_client.DarajaError as error:
                return None, str(error)
        updates["payout_shortcode"] = value
    if "status" in payload:
        if payload["status"] not in ("active", "suspended"):
            return None, "status must be active or suspended."
        updates["status"] = payload["status"]
    if "killSwitch" in payload:
        updates["kill_switch"] = 1 if payload["killSwitch"] else 0
    for key, column in (
        ("commissionPercent", "commission_percent"),
        ("commissionFlat", "commission_flat"),
        ("minPayout", "min_payout"),
        ("maxPayoutPerTx", "max_payout_per_tx"),
        ("payoutFeeEstimate", "payout_fee_estimate"),
    ):
        if key not in payload:
            continue
        value = payload[key]
        if value in (None, ""):
            updates[column] = "0"
            continue
        try:
            updates[column] = Decimal(str(value))
        except InvalidOperation:
            return None, f"{key} must be a number."
    if "defaultHoldHours" in payload and payload["defaultHoldHours"] not in (None, ""):
        try:
            hours = int(payload["defaultHoldHours"])
        except (TypeError, ValueError):
            return None, "defaultHoldHours must be a number of hours."
        if not 0 <= hours <= 720:
            return None, "defaultHoldHours must be between 0 and 720."
        updates["default_hold_hours"] = hours
    result, error = gateway_store.save_company_gateway(cursor, updates, actor_id)
    if error:
        return None, error
    return {**result, "settings": settings_view(cursor)}, None


def charges_view(cursor):
    """The transaction-charge table + whether it applies. Bands are
    inclusive ranges on the amount collected per payout; a null max on the
    last band means no ceiling."""
    row = gateway_store.company_gateway_row(cursor)
    return {
        "enabled": bool((row or {}).get("txn_fees_enabled")),
        "bands": [
            {
                "id": band["id"],
                "min": str(band["min_amount"]),
                "max": None if band["max_amount"] is None else str(band["max_amount"]),
                "fee": str(band["fee"]),
            }
            for band in gateway_store.fee_bands(cursor)
        ],
    }


def save_charges(cursor, payload, actor_id):
    """Validate the band table, then swap it + flip the flag inside the
    caller's transaction."""
    bands_in = payload.get("bands")
    if not isinstance(bands_in, list):
        return None, "bands must be a list."
    if len(bands_in) > 100:
        return None, "At most 100 charge bands."
    cleaned = []
    for index, raw in enumerate(bands_in):
        raw = raw or {}
        try:
            low = Decimal(str(raw.get("min"))).quantize(Decimal("0.01"))
            high_raw = raw.get("max")
            high = (
                None
                if high_raw in (None, "")
                else Decimal(str(high_raw)).quantize(Decimal("0.01"))
            )
            fee = Decimal(str(raw.get("fee"))).quantize(Decimal("0.01"))
        except (InvalidOperation, TypeError, ValueError):
            return None, f"Band {index + 1}: start, end, and fee must be numbers."
        if low < 0 or fee < 0 or (high is not None and high < low):
            return None, f"Band {index + 1}: check the start, end, and fee."
        cleaned.append({"min": low, "max": high, "fee": fee})
    cleaned.sort(key=lambda band: band["min"])
    for previous, following in zip(cleaned, cleaned[1:]):
        if previous["max"] is None:
            return None, "Only the last band may have no end amount."
        if following["min"] <= previous["max"]:
            return None, (
                "Charge bands may not overlap — the next start must be above "
                f"{previous['max']}."
            )
    enabled = bool(payload.get("enabled"))
    row = gateway_store.company_gateway_row(cursor)
    if enabled and not row:
        return None, "Configure the company Daraja credentials first."
    gateway_store.save_fee_bands(cursor, cleaned, actor_id)
    if row:
        gateway_store.save_company_gateway(
            cursor, {"txn_fees_enabled": enabled}, actor_id)
    return {"outcome": "saved", "charges": charges_view(cursor)}, None


def check_payout(cursor, payout_id, actor_id):
    """Director-triggered Transaction Status probe — the answer arrives on
    the normal b2c/b2b result callback."""
    import gateway_settle

    return gateway_settle.check_payout_status(cursor, payout_id, actor_id)


def mark_payout_failed(cursor, payout_id, actor_id):
    return gateway_store.fail_payout_manually(cursor, payout_id, actor_id)


def assign_suspense(cursor, payment_id, payload, actor_id):
    """Director attributes an unmatched payment to a client. Runs inside the
    caller's transaction wrapper."""
    client_id = str(payload.get("clientId") or payload.get("client_id") or "")
    if not client_id:
        return None, "clientId is required."
    result = gateway_store.assign_unmatched(cursor, payment_id, client_id, actor_id)
    if not result:
        return None, "That payment is no longer unmatched."
    gateway_notify.send(
        cursor,
        gateway_notify.notice(
            "client", "payment_credited", "A pooled payment was credited to you",
            f"KES {result['balance']} pool balance after attribution.",
            client_id=client_id,
        ),
    )
    return {"assigned": result}, None


def export_csv(cursor, kind, query):
    """Server-side CSV for the director's records. Phones stay masked — the
    export is a ledger, not a contact list."""
    limit, _ = _page(query)
    client_id = (query.get("client") or [None])[0]
    out = io.StringIO()
    writer = csv.writer(out)
    if kind == "payments":
        writer.writerow(["id", "client_id", "source", "channel", "msisdn", "amount",
                         "mpesa_receipt", "status", "custody", "confirmed_at", "created_at"])
        for row in gateway_store.custody_rows(cursor, client_id=client_id, limit=limit):
            writer.writerow([row.get("id"), row.get("client_id"), row.get("source"),
                             row.get("channel"), row.get("msisdn"), row.get("amount"),
                             row.get("mpesa_receipt"), row.get("status"), row.get("custody"),
                             row.get("confirmed_at"), row.get("created_at")])
    elif kind == "payouts":
        writer.writerow(["id", "batch_id", "client_id", "destination_type", "destination",
                         "account_reference", "amount", "status", "mpesa_receipt",
                         "batch_status", "submitted_at", "confirmed_at"])
        for row in gateway_store.list_payouts(cursor, client_id=client_id, limit=limit):
            writer.writerow([row.get("id"), row.get("batch_id"), row.get("client_id"),
                             row.get("destination_type"), row.get("destination_value"),
                             row.get("account_reference"), row.get("amount"), row.get("status"),
                             row.get("mpesa_receipt"), row.get("batch_status"),
                             row.get("submitted_at"), row.get("confirmed_at")])
    elif kind == "batches":
        writer.writerow(["id", "client_id", "period_from", "period_to", "gross", "commission",
                         "payout_fee", "net", "status", "entries", "payouts"])
        for row in gateway_store.list_batches(cursor, client_id=client_id, limit=limit):
            writer.writerow([row.get("id"), row.get("client_id"), row.get("period_from"),
                             row.get("period_to"), row.get("gross"), row.get("commission"),
                             row.get("payout_fee"), row.get("net"), row.get("status"),
                             row.get("entries"), row.get("payouts")])
    elif kind == "ledger" and client_id:
        writer.writerow(["id", "client_id", "payment_id", "payout_id", "type", "amount",
                         "balance_after", "created_at"])
        for row in gateway_store.list_ledger(cursor, client_id, limit=limit):
            writer.writerow([row.get("id"), row.get("client_id"), row.get("payment_id"),
                             row.get("payout_id"), row.get("type"), row.get("amount"),
                             row.get("balance_after"), row.get("created_at")])
    else:
        return None, "kind must be payments, payouts, batches, or ledger (ledger needs client)."
    return {"filename": f"gateway-{kind}.csv", "csv": out.getvalue()}, None


# --- ISP: own gateway ledger -----------------------------------------------------


def isp_summary(cursor, client_id):
    return gateway_store.isp_gateway_summary(cursor, client_id)


def isp_settings(cursor, client_id):
    return {"settings": gateway_store.isp_payout_settings_row(cursor, client_id)}


def isp_payments(cursor, client_id, query):
    limit, offset = _page(query)
    status = (query.get("status") or [None])[0]
    return {"payments": gateway_store.custody_rows(
        cursor, client_id=client_id, status=status, limit=limit, offset=offset)}


def isp_payouts(cursor, client_id, query):
    limit, offset = _page(query)
    status = (query.get("status") or [None])[0]
    return {"payouts": gateway_store.list_payouts(
        cursor, client_id=client_id, status=status, limit=limit, offset=offset)}


def isp_ledger(cursor, client_id, query):
    limit, offset = _page(query)
    return {"entries": gateway_store.list_ledger(cursor, client_id, limit=limit, offset=offset)}


def isp_notifications(cursor, client_id, query):
    limit, _ = _page(query)
    return {"notifications": gateway_notify.feed_items(
        cursor, "client", client_id=client_id, limit=limit)}


_SCHEDULE_DAYS = {
    "daily", "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday",
}


def clean_settle_schedule(value):
    """Validate the multi-period payout schedule → JSON TEXT for the store.
    Each period is {day: daily|weekday, time: HH:MM}."""
    if value in (None, ""):
        return None, None
    if not isinstance(value, list) or not value or len(value) > 24:
        return None, "settleSchedule must be a list of 1–24 payout periods."
    cleaned = []
    for index, entry in enumerate(value):
        entry = entry or {}
        day = str(entry.get("day") or "").lower()
        if day not in _SCHEDULE_DAYS:
            return None, f"Period {index + 1}: choose a day."
        time_text = str(entry.get("time") or "")
        parts = time_text.split(":")
        if len(parts) != 2 or not all(part.isdigit() for part in parts):
            return None, f"Period {index + 1}: enter a time."
        hour, minute = int(parts[0]), int(parts[1])
        if hour > 23 or minute > 59:
            return None, f"Period {index + 1}: enter a valid time."
        period = {"day": day, "time": f"{hour:02d}:{minute:02d}"}
        if period in cleaned:
            return None, f"Period {index + 1} duplicates another period."
        cleaned.append(period)
    return json.dumps(cleaned), None


def save_isp_settings(cursor, client_id, payload, actor_id):
    """Owner-only settings write — validated here, staged in the store."""
    fields = {}
    if "gatewayMode" in payload:
        fields["gateway_mode"] = str(payload["gatewayMode"])
    if "settlementMode" in payload:
        fields["settlement_mode"] = str(payload["settlementMode"])
    if "holdHours" in payload and payload["holdHours"] not in (None, ""):
        try:
            fields["hold_hours"] = int(payload["holdHours"])
        except (TypeError, ValueError):
            return None, "holdHours must be a number of hours."
    if "settleEveryNTx" in payload:
        if payload["settleEveryNTx"] in (None, ""):
            fields["settle_every_n_tx"] = None
        else:
            try:
                fields["settle_every_n_tx"] = int(payload["settleEveryNTx"])
            except (TypeError, ValueError):
                return None, "settleEveryNTx must be a number of transactions."
    if "settleSchedule" in payload:
        schedule, error = clean_settle_schedule(payload["settleSchedule"])
        if error:
            return None, error
        fields["settle_schedule"] = schedule
    if fields.get("settlement_mode") == "transactions" and (
        fields.get("settle_every_n_tx") is None
        or int(fields["settle_every_n_tx"]) < 1
        or int(fields["settle_every_n_tx"]) > 10000
    ):
        return None, "Choose how many transactions trigger a payout (1–10000)."
    if fields.get("settlement_mode") == "scheduled" and not fields.get("settle_schedule"):
        return None, "Add at least one payout period."
    if "minPayoutOverride" in payload:
        fields["min_payout_override"] = payload["minPayoutOverride"]
    if "destination" in payload:
        destination = payload["destination"] or {}
        fields["destination_type"] = destination.get("type")
        fields["destination_value"] = destination.get("value")
        fields["account_reference"] = destination.get("accountReference")
        if fields["destination_type"] not in ("phone", "paybill", "till"):
            return None, "destination.type must be phone, paybill, or till."
        import daraja_client
        try:
            if fields["destination_type"] == "phone":
                fields["destination_value"] = daraja_client.normalize_msisdn(
                    fields["destination_value"])
            else:
                fields["destination_value"] = daraja_client.validate_shortcode(
                    fields["destination_value"], "destination")
        except daraja_client.DarajaError as error:
            return None, str(error)
        if fields["destination_type"] == "paybill" and not fields["account_reference"]:
            cursor.execute(
                "SELECT client_code FROM isp_clients WHERE id = %s", (client_id,))
            client = cursor.fetchone() or {}
            fields["account_reference"] = str(client.get("client_code") or "").strip()
            if not fields["account_reference"]:
                return None, "accountReference is required for a paybill destination."
        if fields["destination_type"] == "phone" and fields["account_reference"]:
            return None, "accountReference only applies to paybill destinations."
    outcome = gateway_store.save_payout_settings(cursor, client_id, fields, actor_id)
    return {"outcome": outcome, "settings": gateway_store.isp_payout_settings_row(cursor, client_id)}, None
