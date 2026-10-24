import base64
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import socket
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import envfile

envfile.load()

import gateway_api
import gateway_callbacks
import gateway_crypto
import gateway_notify
import gateway_settle
import gateway_store
import pppoe_service
import pppoe_store
import portal_server
import radius_server
import router_jobs
import routeros_api
import webpush

import pymysql
from pymysql.cursors import DictCursor

HOST = os.environ.get("ISP_API_HOST", "127.0.0.1")
PORT = int(os.environ.get("ISP_API_PORT", "8765"))
DB_NAME = os.environ.get("ISP_DB_NAME", "ISP-DB")
WEB_ROOT = Path(
    os.environ.get("ISP_WEB_ROOT", "").strip()
    or Path(__file__).resolve().parent.parent / "frontend" / "dist"
)
ITERATIONS = 210_000
MAX_BODY = 300_000
SESSION_SECONDS = 12 * 60 * 60
LOCK_SECONDS = 15 * 60
MAX_FAILURES = 5
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROLES = {
    "director",
    "supervisor",
    "customer-care",
    "technician",
    "it-support",
    "dispatcher",
    "sales",
}
LOCKS = {}
RATE_HITS = {}
RATE_LOCK = threading.Lock()
TRUSTED_PROXIES = {"127.0.0.1", "::1"}
# Public DNS names only — at least one dot, valid labels, no port. Learned
# callback bases never come from IPs, localhost, or intranet names.
PUBLIC_HOSTNAME = re.compile(
    r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+"
)
RATE_RULES = {
    "auth": (30, 60),
    "api": (240, 60),
    "callback": (120, 60),
    "router-read": (60, 60),
}
AUTH_PATHS = {
    "/api/client/login",
    "/api/employee/login",
    "/api/client/register",
    "/api/employee/register",
}


def rate_ok(key, limit, window):
    now = time.time()
    cutoff = now - window
    with RATE_LOCK:
        hits = RATE_HITS.setdefault(key, [])
        while hits and hits[0] <= cutoff:
            hits.pop(0)
        if len(hits) >= limit:
            return False
        hits.append(now)
        if len(RATE_HITS) > 20000:
            for stale_key, stale_hits in list(RATE_HITS.items()):
                if not stale_hits or stale_hits[-1] <= cutoff:
                    del RATE_HITS[stale_key]
        return True


def request_ip(handler):
    peer = handler.client_address[0]
    if peer in TRUSTED_PROXIES:
        forwarded = (
            (handler.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
            or (handler.headers.get("X-Real-IP") or "").strip()
        )
        if forwarded:
            return forwarded[:45]
    return peer


def clean_package_fields(payload):
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 80 or any(ord(character) < 32 for character in name):
        raise ApiError(400, "Enter a package name.")
    try:
        price = Decimal(str(payload.get("price", "")).strip())
    except InvalidOperation as error:
        raise ApiError(400, "Enter the price in KSh.") from error
    if price < 0 or price > Decimal("99999999.99") or price.as_tuple().exponent < -2:
        raise ApiError(400, "Enter the price in KSh with up to two decimal places.")
    service_type = package_choice(payload.get("serviceType"), SERVICE_TYPES, "Choose PPPoE or Hotspot.")
    devices = 1
    extra_device = None
    extra_period = None
    if service_type == "hotspot":
        device_mode = str(payload.get("deviceMode") or "").strip()
        if device_mode == "one":
            devices = 1
        elif device_mode == "multiple":
            devices = 0
            extra_device = package_money(
                payload.get("extraDevicePrice"), "Enter the amount charged for each extra device."
            )
            extra_period = package_money(
                payload.get("extraPeriodPrice"), "Enter the amount charged for each extra period."
            )
        else:
            raise ApiError(400, "Choose whether the hotspot package is for one device or multiple devices.")
    else:
        raw_devices = payload.get("simultaneousDevices", payload.get("devices"))
        if raw_devices in (None, ""):
            devices = 0
        else:
            try:
                devices = int(raw_devices)
            except (TypeError, ValueError):
                devices = -1
            if not 0 <= devices <= 50 or (isinstance(raw_devices, float) and devices != raw_devices):
                raise ApiError(400, "Enter a device limit from 1 to 50, or leave devices unlimited.")
    validity_amount, validity_unit = optional_duration(
        payload.get("validityAmount"),
        payload.get("validityUnit"),
        "Enter how long the package stays valid, and choose hours, days, weeks, or months.",
    )
    if validity_amount is None:
        raise ApiError(400, "Enter how long the package stays valid, and choose hours, days, weeks, or months.")
    if devices == 0:
        validity_amount = 1
    download = package_speed(payload.get("downloadMbps"), "download")
    upload = package_speed(payload.get("uploadMbps"), "upload")
    data_amount, data_unit = optional_data_amount(
        payload.get("dataAllowanceAmount"),
        payload.get("dataAllowanceUnit"),
        "Enter the data allowance and choose MB or GB, or leave both empty.",
    )
    data_action, data_down, data_up = limit_reaction(
        data_amount,
        payload.get("dataAllowanceAction"),
        payload.get("dataThrottleDownloadMbps"),
        payload.get("dataThrottleUploadMbps"),
        download,
        upload,
        "data allowance",
    )
    data_reset_amount, data_reset_unit = limit_reset(
        data_amount,
        payload.get("dataResetAmount"),
        payload.get("dataResetUnit"),
        "data allowance",
    )
    fair_amount, fair_unit = optional_data_amount(
        payload.get("fairUseAmount"),
        payload.get("fairUseUnit"),
        "Enter the fair-use threshold and choose MB or GB.",
    )
    fair_action, fair_down, fair_up = limit_reaction(
        fair_amount,
        payload.get("fairUseAction"),
        payload.get("fairThrottleDownloadMbps"),
        payload.get("fairThrottleUploadMbps"),
        download,
        upload,
        "fair-use threshold",
    )
    fair_reset_amount, fair_reset_unit = limit_reset(
        fair_amount,
        payload.get("fairResetAmount"),
        payload.get("fairResetUnit"),
        "fair-use threshold",
    )
    if fair_action == "throttle":
        policy = f"Throttle to {fair_down}/{fair_up} Mbps"
    elif fair_action == "disconnect":
        policy = "Disconnect"
    else:
        policy = ""
    grace_amount, grace_unit = optional_duration(
        payload.get("graceAmount"),
        payload.get("graceUnit"),
        "Enter the grace period and choose hours, days, weeks, or months, or leave both empty.",
    )
    return {
        "name": name,
        "service_type": service_type,
        "price": format(price, ".2f"),
        "billing_model": package_choice(
            payload.get("billingModel"),
            BILLING_MODELS,
            "Choose recurring, prepaid, voucher, or usage-based billing.",
        ),
        "download": download,
        "upload": upload,
        "validity_amount": validity_amount,
        "validity_unit": validity_unit,
        "data_amount": data_amount,
        "data_unit": data_unit,
        "data_action": data_action,
        "data_down": data_down,
        "data_up": data_up,
        "data_reset_amount": data_reset_amount,
        "data_reset_unit": data_reset_unit,
        "fair_amount": fair_amount,
        "fair_unit": fair_unit,
        "fair_policy": policy,
        "fair_action": fair_action or None,
        "fair_down": fair_down,
        "fair_up": fair_up,
        "fair_reset_amount": fair_reset_amount,
        "fair_reset_unit": fair_reset_unit,
        "devices": devices,
        "extra_device": extra_device,
        "extra_period": extra_period,
        "grace_amount": grace_amount,
        "grace_unit": grace_unit,
        "status": package_choice(
            payload.get("status"),
            PACKAGE_STATUSES,
            "Choose draft, active, or archived.",
        ),
    }


def limit_reaction(amount, action_value, download, upload, cap_down, cap_up, label):
    action = str(action_value or "").strip()
    if amount:
        if action not in {"throttle", "disconnect"}:
            raise ApiError(400, f"Choose whether to throttle speeds or disconnect the user when they hit the {label}.")
    elif action:
        raise ApiError(400, f"Enter the {label}, or leave what happens empty.")
    else:
        action = ""
    download_speed, upload_speed = throttle_pair(
        download,
        upload,
        cap_down,
        cap_up,
        action == "throttle",
        f"Enter the download and upload speeds to throttle to when the user hits the {label}."
        if action == "throttle"
        else f"Leave the throttle speeds empty unless the {label} throttles the user.",
    )
    return (action or None), download_speed, upload_speed


def throttle_pair(download, upload, cap_down, cap_up, required, message):
    download_text = "" if download is None else str(download).strip()
    upload_text = "" if upload is None else str(upload).strip()
    if not download_text and not upload_text:
        if required:
            raise ApiError(400, message)
        return None, None
    if not required:
        raise ApiError(400, message)
    download_speed = package_speed(download, "throttle download")
    upload_speed = package_speed(upload, "throttle upload")
    if download_speed > cap_down or upload_speed > cap_up:
        raise ApiError(400, "Enter throttle speeds that are no faster than the package speeds.")
    return download_speed, upload_speed


def clean_package_image(value):
    image = str(value or "")
    if not image.startswith("data:image/jpeg") or ";base64," not in image or len(image) > 200_000:
        raise ApiError(400, "Upload a package image.")
    return image


def optional_package_image(value):
    image = str(value or "").strip()
    if not image:
        return ""
    return clean_package_image(image)


def package_speed(value, label):
    if isinstance(value, bool):
        raise ApiError(400, f"Enter the {label} speed in Mbps.")
    if isinstance(value, float):
        if not value.is_integer():
            raise ApiError(400, f"Enter the {label} speed in Mbps.")
        value = int(value)
    text = str(value).strip()
    if not text.isdigit():
        raise ApiError(400, f"Enter the {label} speed in Mbps.")
    speed = int(text)
    if speed < 1 or speed > 100000:
        raise ApiError(400, f"Enter the {label} speed in Mbps.")
    return speed


def masked_secret(value):
    if not value:
        return ""
    if len(value) <= 4:
        return "••••"
    return "••••" + value[-4:]


def saved_flag(value):
    """Write-only secrets are never returned — only a truthy "Saved" marker."""
    return "••••" if value else ""


def seal_secret(value):
    """New writes use the versioned AES-GCM envelope; older legacy-sealed
    rows keep reading through open_secret below."""
    if not value:
        return value
    return gateway_crypto.seal(str(value))


def open_secret(value):
    """Dual-read for stored secrets: gcm1 envelope → legacy seal → raw.
    A gcm1 blob that fails its integrity check returns "" — never the
    ciphertext — so a tampered value fails loudly instead of authenticating."""
    if not value:
        return value
    if gateway_crypto.is_sealed(value):
        try:
            return gateway_crypto.open_secret(str(value))
        except gateway_crypto.GatewayCryptoError:
            return ""
    try:
        return routeros_api.open_password(str(value))
    except routeros_api.RouterError:
        return str(value)


def stamp(value):
    if value is None:
        return None
    return value.isoformat(sep=" ") if hasattr(value, "isoformat") else str(value)


def keep_or_clean(value, existing, message, minimum, maximum):
    text = str(value or "").strip()
    if not text or text.startswith("••••"):
        if existing:
            return existing
        raise ApiError(400, message)
    if any(ord(character) < 32 for character in text) or len(text) < minimum or len(text) > maximum:
        raise ApiError(400, message)
    return text


def keep_optional_secret(value, existing, message, minimum, maximum):
    text = str(value or "").strip()
    if not text or text.startswith("••••"):
        return existing or ""
    if any(ord(character) < 32 for character in text) or len(text) < minimum or len(text) > maximum:
        raise ApiError(400, message)
    return text


def optional_url(value, message):
    text = str(value or "").strip()
    if not text:
        return ""
    if (
        len(text) > 255
        or any(ord(character) < 32 or character.isspace() for character in text)
        or not (text.startswith("https://") or text.startswith("http://"))
    ):
        raise ApiError(400, message)
    return text


def optional_text(value, message, maximum=128):
    text = str(value or "").strip()
    if len(text) > maximum or any(ord(character) < 32 for character in text):
        raise ApiError(400, message)
    return text


def clean_daraja(payload, existing):
    environment = str(payload.get("environment", "")).strip()
    account_type = str(payload.get("accountType", "")).strip()
    if environment not in {"sandbox", "live"}:
        raise ApiError(400, "Choose the Daraja environment.")
    if account_type not in {"paybill", "till"}:
        raise ApiError(400, "Choose a Paybill or Till number.")
    short_code = str(payload.get("shortCode", "")).strip()
    if not short_code.isdigit() or not 5 <= len(short_code) <= 10:
        raise ApiError(400, "Enter the business short code.")
    previous = existing or {}
    return {
        "environment": environment,
        "account_type": account_type,
        "short_code": short_code,
        "consumer_key": keep_or_clean(
            payload.get("consumerKey"),
            previous.get("consumer_key"),
            "Enter the Daraja consumer key.",
            8,
            128,
        ),
        "consumer_secret": keep_or_clean(
            payload.get("consumerSecret"),
            previous.get("consumer_secret"),
            "Enter the Daraja consumer secret.",
            8,
            128,
        ),
        "passkey": keep_or_clean(
            payload.get("passkey"),
            previous.get("passkey"),
            "Enter the Daraja passkey.",
            8,
            255,
        ),
        "callback_url": optional_url(
            payload.get("callbackUrl"), "Enter a callback URL that starts with http:// or https://."
        ),
        "confirmation_url": optional_url(
            payload.get("confirmationUrl"), "Enter a confirmation URL that starts with http:// or https://."
        ),
        "validation_url": optional_url(
            payload.get("validationUrl"), "Enter a validation URL that starts with http:// or https://."
        ),
        "initiator_name": optional_text(payload.get("initiatorName"), "Enter the Daraja initiator name."),
        "security_credential": keep_optional_secret(
            payload.get("securityCredential"),
            previous.get("security_credential"),
            "Enter the Daraja security credential.",
            8,
            2048,
        ),
    }


def clean_endpoint(value):
    text = str(value or "").strip()
    if (
        len(text) < 12
        or len(text) > 255
        or any(ord(character) < 32 or character.isspace() for character in text)
        or not (text.startswith("https://") or text.startswith("http://"))
    ):
        raise ApiError(400, "Enter an API endpoint that starts with http:// or https://.")
    return text


def daraja_oauth_probe(environment, consumer_key, consumer_secret):
    """Cheapest proof Daraja credentials work — one OAuth round-trip."""
    import base64
    import http.client
    import urllib.error
    import urllib.request

    host = "https://api.safaricom.co.ke" if environment == "live" else "https://sandbox.safaricom.co.ke"
    request = urllib.request.Request(
        f"{host}/oauth/v1/generate?grant_type=client_credentials",
        headers={"Authorization": "Basic " + base64.b64encode(f"{consumer_key}:{consumer_secret}".encode()).decode()},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            body = json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = str(json.loads(error.read().decode() or "{}").get("errorMessage") or "").strip()
        except (ValueError, OSError, http.client.HTTPException):
            detail = ""
        suffix = f": {detail}" if detail else ""
        if error.code in (400, 401, 403):
            return {"connected": False, "reason": f"Daraja rejected the credentials ({error.code}{suffix}). Check the consumer key, secret, and environment."}
        return {"connected": False, "reason": f"Daraja answered with an error ({error.code}{suffix}). Try again shortly."}
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as error:
        return {"connected": False, "reason": f"Daraja could not be reached: {getattr(error, 'reason', error)}."}
    if body.get("access_token"):
        return {"connected": True, "reason": ""}
    return {"connected": False, "reason": "Daraja answered but returned no access token."}


def gateway_precheck(cursor):
    """Client-facing preflight before opting into the company gateway —
    booleans and plain-language reasons only, never secrets."""
    cursor.execute(
        """
        SELECT environment, consumer_key, consumer_secret, passkey,
               initiator_name, initiator_password_enc, kill_switch
        FROM company_daraja_settings WHERE id = 1
        """
    )
    row = cursor.fetchone() or {}
    checks = []

    configured = bool(row.get("consumer_key") and row.get("consumer_secret"))
    checks.append({
        "key": "credentials",
        "ok": configured,
        "detail": "Company M-Pesa credentials are saved."
        if configured else "The company has not saved its M-Pesa credentials yet.",
    })

    if configured:
        probe = daraja_oauth_probe(
            row.get("environment") or "sandbox",
            row["consumer_key"],
            open_secret(row["consumer_secret"]),
        )
        checks.append({
            "key": "daraja",
            "ok": probe["connected"],
            "detail": "Daraja accepts the company credentials." if probe["connected"] else probe["reason"],
        })
    else:
        checks.append({"key": "daraja", "ok": False, "detail": "Skipped — no credentials to test."})

    callbacks_ready = bool(
        gateway_store.public_base(cursor)
        and gateway_store.callback_secret(cursor)
    )
    checks.append({
        "key": "callbacks",
        "ok": callbacks_ready,
        "detail": "Payment callbacks are registered."
        if callbacks_ready else "The callback address is not configured on the server yet.",
    })

    payouts_ready = bool(row.get("initiator_name") and row.get("initiator_password_enc"))
    checks.append({
        "key": "payouts",
        "ok": payouts_ready,
        "detail": "Payout credentials are set — money can be disbursed to you."
        if payouts_ready else "The company has not set up payout credentials (initiator) yet.",
    })

    checks.append({
        "key": "gateway",
        "ok": not row.get("kill_switch"),
        "detail": "The gateway is accepting payments."
        if not row.get("kill_switch") else "The company gateway is paused — try again later.",
    })

    return {"ok": all(check["ok"] for check in checks), "checks": checks}


def clean_communication_sender(channel, value):
    text = str(value or "").strip()
    if channel == "sms":
        if not 3 <= len(text) <= 11 or not all(character.isalnum() or character == "-" for character in text):
            raise ApiError(400, "Enter an SMS sender ID.")
        return text
    if channel == "whatsapp":
        if not text.isdigit() or not 6 <= len(text) <= 32:
            raise ApiError(400, "Enter the WhatsApp phone number ID.")
        return text
    if len(text) > 120 or any(character.isspace() or ord(character) < 32 for character in text):
        raise ApiError(400, "Enter the from email address.")
    local, separator, domain = text.partition("@")
    if not separator or not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ApiError(400, "Enter the from email address.")
    return text


def clean_smtp_host(value):
    text = str(value or "").strip().lower()
    if (
        not text
        or len(text) > 253
        or "." not in text
        or any(ord(character) < 32 or character.isspace() for character in text)
        or not all(character.isalnum() or character in ".-_" for character in text)
    ):
        raise ApiError(400, "Enter the SMTP host, e.g. mail.example.com.")
    return text


def clean_smtp_port(value, fallback):
    text = str(value or "").strip()
    if not text:
        return fallback or 587
    if not text.isdigit() or not 1 <= int(text) <= 65535:
        raise ApiError(400, "Enter the SMTP port — 587 for TLS or 465 for SSL.")
    return int(text)


def clean_optional_digits(value, message):
    text = str(value or "").strip()
    if text and (not text.isdigit() or not 6 <= len(text) <= 32):
        raise ApiError(400, message)
    return text


def communication_details(raw):
    try:
        parsed = json.loads(raw or "")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def clean_communication(payload, existing):
    channel = str(payload.get("channel", "")).strip()
    if channel not in {"sms", "whatsapp", "email"}:
        raise ApiError(400, "Choose the SMS, WhatsApp, or email API.")
    previous = existing or {}
    previous_details = communication_details(previous.get("details"))
    secret_label = {
        "sms": "Enter the SMS API key.",
        "whatsapp": "Enter the WhatsApp access token.",
        "email": "Enter the SMTP password.",
    }[channel]
    fields = {
        "channel": channel,
        "api_key": keep_or_clean(payload.get("apiKey"), previous.get("api_key"), secret_label, 8, 255),
    }
    details = {"enabled": bool(payload.get("enabled", previous_details.get("enabled", True)))}
    if channel == "email":
        fields["endpoint"] = clean_smtp_host(payload.get("endpoint"))
        details["port"] = clean_smtp_port(payload.get("port"), previous_details.get("port"))
        details["username"] = optional_text(payload.get("username"), "Enter the SMTP username.", 160)
        details["fromName"] = optional_text(payload.get("fromName"), "Enter the from name.", 80)
        details["useTls"] = bool(payload.get("useTls", previous_details.get("useTls", True)))
        fields["sender"] = clean_communication_sender(channel, payload.get("sender") or details["username"])
    elif channel == "whatsapp":
        fields["endpoint"] = clean_endpoint(payload.get("endpoint"))
        fields["sender"] = clean_communication_sender(channel, payload.get("sender"))
        details["apiVersion"] = optional_text(payload.get("apiVersion"), "Enter the WhatsApp API version.", 20)
        details["businessAccountId"] = clean_optional_digits(
            payload.get("businessAccountId"), "Enter the WhatsApp business account ID."
        )
    else:
        fields["endpoint"] = clean_endpoint(payload.get("endpoint"))
        fields["sender"] = clean_communication_sender(channel, payload.get("sender"))
        details["username"] = optional_text(
            payload.get("username"), "Enter the SMS API username or account ID.", 120
        )
    fields["details"] = json.dumps(details)
    return fields


def public_communication(row):
    if not row:
        return None
    details = communication_details(row.get("details"))
    return {
        "enabled": bool(details.get("enabled", True)),
        "endpoint": row["endpoint"],
        "sender": row["sender"],
        "apiKey": masked_secret(row["api_key"]),
        "username": details.get("username") or "",
        "port": details.get("port") or "",
        "fromName": details.get("fromName") or "",
        "useTls": bool(details.get("useTls", True)),
        "apiVersion": details.get("apiVersion") or "",
        "businessAccountId": details.get("businessAccountId") or "",
    }


def probe_endpoint(endpoint, headers=None, reject_codes=()):
    import ipaddress
    import urllib.error
    import urllib.request

    text = str(endpoint or "").strip()
    if not text:
        return {"connected": False, "reason": "Save the API endpoint first."}
    host = urlparse(text).hostname or ""
    try:
        address = ipaddress.ip_address(socket.gethostbyname(host))
    except (OSError, ValueError):
        return {"connected": False, "reason": "The API endpoint host could not be resolved."}
    if address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified:
        return {"connected": False, "reason": "The API endpoint must be a public or LAN host."}
    request = urllib.request.Request(
        text,
        headers={"User-Agent": "isp-centric-connectivity-check/1.0", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            code = response.status
    except urllib.error.HTTPError as error:
        if error.code in reject_codes:
            return {
                "connected": False,
                "reason": f"The API rejected the saved credentials or sender ID (HTTP {error.code}).",
            }
        return {"connected": True, "reason": f"The API endpoint answered with HTTP {error.code}."}
    except (urllib.error.URLError, OSError, ValueError) as error:
        return {"connected": False, "reason": f"The API endpoint could not be reached: {getattr(error, 'reason', error)}."}
    return {"connected": True, "reason": f"The API endpoint answered with HTTP {code}."}


def probe_smtp(host, port, username, password, use_tls):
    import ipaddress
    import smtplib

    host = str(host or "").strip()
    if not host:
        return {"connected": False, "reason": "Save the SMTP host first."}
    try:
        address = ipaddress.ip_address(socket.gethostbyname(host))
    except (OSError, ValueError):
        return {"connected": False, "reason": "The SMTP host could not be resolved."}
    if address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified:
        return {"connected": False, "reason": "The SMTP host must be a public or LAN host."}
    port = int(port or 465)
    try:
        if port == 465:
            server = smtplib.SMTP_SSL(host, port, timeout=8)
        else:
            server = smtplib.SMTP(host, port, timeout=8)
    except (OSError, smtplib.SMTPException) as error:
        return {"connected": False, "reason": f"The SMTP server could not be reached: {error}."}
    try:
        server.ehlo()
        if use_tls and port != 465:
            try:
                server.starttls()
                server.ehlo()
            except (OSError, smtplib.SMTPException) as error:
                return {"connected": False, "reason": f"The SMTP server refused STARTTLS: {error}."}
        if not username and not password:
            return {"connected": True, "reason": "The SMTP server answered."}
        try:
            server.login(username or "", password or "")
        except smtplib.SMTPAuthenticationError:
            return {"connected": False, "reason": "The SMTP server rejected the username or password."}
        except smtplib.SMTPException as error:
            return {"connected": False, "reason": f"SMTP login failed: {error}."}
        return {"connected": True, "reason": "SMTP login succeeded."}
    finally:
        try:
            server.quit()
        except (OSError, smtplib.SMTPException):
            pass


def probe_communication(channel, row):
    row = row or {}
    details = communication_details(row.get("details"))
    if channel == "email":
        return probe_smtp(
            row.get("endpoint"),
            details.get("port"),
            details.get("username") or row.get("sender") or "",
            open_secret(row.get("api_key") or ""),
            bool(details.get("useTls", True)),
        )
    if channel == "whatsapp":
        endpoint = str(row.get("endpoint") or "").strip()
        token = open_secret(row.get("api_key") or "")
        version = str(details.get("apiVersion") or "").strip()
        sender = str(row.get("sender") or "").strip()
        if version and sender and endpoint:
            target = f"{endpoint.rstrip('/')}/{version}/{sender}"
            return probe_endpoint(
                target,
                headers={"Authorization": f"Bearer {token}"} if token else None,
                reject_codes=(400, 401, 403),
            )
        return probe_endpoint(endpoint)
    return probe_endpoint(row.get("endpoint"))


def vapid_keys(cursor):
    """The company's Web Push identity — generated once, then reused so
    subscriptions keep working across restarts."""
    cursor.execute("SELECT vapid_public, vapid_private FROM company_push_settings WHERE id = 1")
    row = cursor.fetchone() or {}
    private = open_secret(row.get("vapid_private") or "")
    if row.get("vapid_public") and private:
        return row["vapid_public"], private
    public, private = webpush.generate_vapid_keys()
    cursor.execute(
        """
        INSERT INTO company_push_settings (id, vapid_public, vapid_private)
        VALUES (1, %s, %s)
        ON DUPLICATE KEY UPDATE
          vapid_public = VALUES(vapid_public),
          vapid_private = VALUES(vapid_private)
        """,
        (public, seal_secret(private)),
    )
    return public, private


def push_contact(cursor):
    contact = (os.environ.get("ISP_PUSH_CONTACT") or "").strip()
    if contact:
        return contact
    cursor.execute("SELECT email FROM company_profile_settings WHERE id = 1")
    email = str((cursor.fetchone() or {}).get("email") or "").strip()
    return f"mailto:{email}" if "@" in email else "mailto:alerts@localhost"


NOTIFICATION_TOGGLES = {
    "serverUnreachable": "server_unreachable",
    "mikrotikUnreachable": "mikrotik_unreachable",
    "mikrotikAdded": "mikrotik_added",
    "ispRegistered": "isp_registered",
    "communicationsFailed": "communications_failed",
    "paymentsFailed": "payments_failed",
}


ISP_NOTIFICATION_TOGGLES = {
    "mikrotikOnboarded": "mikrotik_onboarded",
    "mikrotikUnreachable": "mikrotik_unreachable",
    "mikrotikNoInternet": "mikrotik_no_internet",
    "clientCannotSurf": "client_cannot_surf",
    "subscriptionEnding": "subscription_ending",
    "communicationsFailed": "communications_failed",
    "paymentsFailed": "payments_failed",
    "serverUnreachable": "server_unreachable",
}


def public_notification_settings(row, toggles):
    return {key: bool(row[column]) if row else True for key, column in toggles.items()}


def clean_company(payload):
    name = str(payload.get("name", "")).strip()
    email = str(payload.get("email", "")).strip()
    phone = str(payload.get("phone", "")).strip()
    website = str(payload.get("website", "")).strip()
    address = str(payload.get("address", "")).strip()
    logo = str(payload.get("logoDataUrl", "") or "")
    if not name or len(name) > 120:
        raise ApiError(400, "Enter the company name.")
    if email and (len(email) > 120 or "@" not in email):
        raise ApiError(400, "Enter a valid company email address.")
    if phone and not 7 <= len(digits(phone)) <= 15:
        raise ApiError(400, "Enter a company phone number with 7 to 15 digits.")
    if len(website) > 160:
        raise ApiError(400, "Enter a shorter company website.")
    if len(address) > 200:
        raise ApiError(400, "Enter a shorter company address.")
    if logo and (not logo.startswith("data:image/") or len(logo) > 200_000):
        raise ApiError(400, "The company logo could not be accepted.")
    return {
        "name": name,
        "email": email,
        "phone": phone,
        "website": website,
        "address": address,
        "logo": logo or None,
    }


def public_company(row):
    if not row:
        return None
    return {
        "name": row["company_name"],
        "email": row["email"],
        "phone": row["phone"],
        "website": row["website"],
        "address": row["address"],
        "logoDataUrl": row.get("logo_data_url") or "",
        "updatedAt": stamp(row["updated_at"]) or str(row["updated_at"]),
    }


def clean_other_gateway(payload, existing):
    provider = str(payload.get("provider", "")).strip()
    if not provider or len(provider) > 80 or any(ord(character) < 32 for character in provider):
        raise ApiError(400, "Enter the payment gateway name.")
    environment = str(payload.get("environment", "")).strip()
    if environment not in {"sandbox", "live"}:
        raise ApiError(400, "Choose the payment gateway environment.")
    previous = existing or {}
    return {
        "provider": provider,
        "environment": environment,
        "endpoint": clean_endpoint(payload.get("endpoint")),
        "public_key": keep_or_clean(
            payload.get("publicKey"),
            previous.get("public_key"),
            "Enter the payment gateway public key.",
            8,
            255,
        ),
        "secret_key": keep_or_clean(
            payload.get("secretKey"),
            previous.get("secret_key"),
            "Enter the payment gateway secret key.",
            8,
            255,
        ),
    }


def public_other_gateway(row):
    if not row:
        return None
    return {
        "provider": row["provider"],
        "environment": row["environment"],
        "endpoint": row["endpoint"],
        "publicKey": masked_secret(row["public_key"]),
        "secretKey": masked_secret(row["secret_key"]),
    }


def public_payment(row):
    if not row:
        return None
    return {
        "environment": row["environment"],
        "accountType": row["account_type"],
        "shortCode": row["short_code"],
        "consumerKey": saved_flag(row["consumer_key"]),
        "consumerSecret": saved_flag(row["consumer_secret"]),
        "passkey": saved_flag(row["passkey"]),
        "callbackUrl": row.get("callback_url") or "",
        "confirmationUrl": row.get("confirmation_url") or "",
        "validationUrl": row.get("validation_url") or "",
        "initiatorName": row.get("initiator_name") or "",
        "securityCredential": saved_flag(row.get("security_credential") or ""),
        "initiatorPassword": saved_flag(row.get("initiator_password_enc") or ""),
        "payoutShortcode": row.get("payout_shortcode") or "",
        "updatedAt": stamp(row["updated_at"]) or str(row["updated_at"]),
    }


def public_package(row):
    data_amount = row.get("data_allowance_amount")
    fair_amount = row.get("fair_use_amount")
    return {
        "id": row["id"],
        "name": row["name"],
        "serviceType": row.get("service_type") or "pppoe",
        "price": format(Decimal(row["price"]), ".2f"),
        "billingModel": row.get("billing_model") or "recurring",
        "downloadMbps": int(row["download_mbps"]),
        "uploadMbps": int(row["upload_mbps"]),
        "validityAmount": int(row.get("validity_amount") or 1),
        "validityUnit": row.get("validity_unit") or "months",
        "dataAllowanceAmount": None if data_amount is None else format(Decimal(data_amount), ".2f"),
        "dataAllowanceUnit": row.get("data_allowance_unit"),
        "dataAllowanceAction": row.get("data_allowance_action"),
        "dataThrottleDownloadMbps": None if row.get("data_throttle_download") is None else int(row["data_throttle_download"]),
        "dataThrottleUploadMbps": None if row.get("data_throttle_upload") is None else int(row["data_throttle_upload"]),
        "dataResetAmount": None if row.get("data_reset_amount") is None else int(row["data_reset_amount"]),
        "dataResetUnit": row.get("data_reset_unit"),
        "fairUseAmount": None if fair_amount is None else format(Decimal(fair_amount), ".2f"),
        "fairUseUnit": row.get("fair_use_unit"),
        "fairUsePolicy": row.get("fair_use_policy") or "",
        "fairUseAction": row.get("fair_use_action"),
        "fairThrottleDownloadMbps": None if row.get("fair_throttle_download") is None else int(row["fair_throttle_download"]),
        "fairThrottleUploadMbps": None if row.get("fair_throttle_upload") is None else int(row["fair_throttle_upload"]),
        "fairResetAmount": None if row.get("fair_reset_amount") is None else int(row["fair_reset_amount"]),
        "fairResetUnit": row.get("fair_reset_unit"),
        "simultaneousDevices": int(row["simultaneous_devices"]) if row.get("simultaneous_devices") is not None else 1,
        "extraDevicePrice": None if row.get("extra_device_price") is None else format(Decimal(row["extra_device_price"]), ".2f"),
        "extraPeriodPrice": None if row.get("extra_period_price") is None else format(Decimal(row["extra_period_price"]), ".2f"),
        "graceAmount": None if row.get("grace_amount") is None else int(row["grace_amount"]),
        "graceUnit": row.get("grace_unit"),
        "status": row["status"],
        "routers": load_offer_names(row.get("availability_routers")),
        "defaultPackage": bool(row.get("company_package_id")) and not int(row.get("customized") or 0),
        "imageDataUrl": row.get("image_data_url") or "",
    }


SERVICE_TYPES = {"pppoe", "hotspot"}
BILLING_MODELS = {"recurring", "prepaid", "voucher", "usage"}
TIME_UNITS = {"hours", "days", "weeks", "months"}
DATA_UNITS = {"MB", "GB"}
PACKAGE_STATUSES = {"draft", "active", "archived", "suspended"}
COMPANY_PACKAGE_COLUMNS = """
  id, name, service_type, price, billing_model, download_mbps, upload_mbps,
  validity_amount, validity_unit, data_allowance_amount, data_allowance_unit,
  fair_use_amount, fair_use_unit, fair_use_policy, fair_use_action,
  fair_throttle_download, fair_throttle_upload, data_allowance_action,
  data_throttle_download, data_throttle_upload,
  data_reset_amount, data_reset_unit, fair_reset_amount, fair_reset_unit,
  simultaneous_devices, extra_device_price, extra_period_price,
  grace_amount, grace_unit, status, availability_routers, availability_locations,
  availability_service_areas, availability_clients, applies_to_all, image_data_url
"""
ISP_PACKAGE_COLUMNS = """
  id, client_id, name, service_type, price, billing_model, download_mbps, upload_mbps,
  validity_amount, validity_unit, data_allowance_amount, data_allowance_unit,
  data_allowance_action, data_throttle_download, data_throttle_upload,
  data_reset_amount, data_reset_unit,
  fair_use_amount, fair_use_unit, fair_use_policy, fair_use_action,
  fair_throttle_download, fair_throttle_upload, fair_reset_amount, fair_reset_unit,
  simultaneous_devices, extra_device_price, extra_period_price,
  grace_amount, grace_unit, status, availability_routers,
  company_package_id, customized, image_data_url
"""


def package_choice(value, allowed, message):
    choice = str(value or "").strip()
    if choice not in allowed:
        raise ApiError(400, message)
    return choice


def package_money(value, message):
    if isinstance(value, bool):
        raise ApiError(400, message)
    try:
        amount = Decimal(str("" if value is None else value).strip())
    except InvalidOperation as error:
        raise ApiError(400, message) from error
    if amount < 0 or amount > Decimal("99999999.99") or amount.as_tuple().exponent < -2:
        raise ApiError(400, message)
    return format(amount, ".2f")


def package_count(value, message, maximum):
    if isinstance(value, bool):
        raise ApiError(400, message)
    if isinstance(value, float):
        if not value.is_integer():
            raise ApiError(400, message)
        value = int(value)
    text = str(value).strip()
    if not text.isdigit():
        raise ApiError(400, message)
    count = int(text)
    if count < 1 or count > maximum:
        raise ApiError(400, message)
    return count


def limit_reset(limit_amount, amount, unit, label):
    period_amount, period_unit = optional_duration(
        amount,
        unit,
        f"Enter how long the {label} runs before it resets, and choose hours, days, weeks, or months.",
    )
    if limit_amount and period_amount is None:
        raise ApiError(400, f"Enter how long the {label} runs before it resets.")
    if period_amount is not None and not limit_amount:
        raise ApiError(400, f"Enter the {label}, or leave the reset period empty.")
    return period_amount, period_unit


def optional_duration(amount, unit, message):
    amount_text = "" if amount is None else str(amount).strip()
    unit_text = "" if unit is None else str(unit).strip()
    if not amount_text and not unit_text:
        return None, None
    if not amount_text or unit_text not in TIME_UNITS:
        raise ApiError(400, message)
    return package_count(amount_text, message, 10000), unit_text


def optional_data_amount(amount, unit, message):
    amount_text = "" if amount is None else str(amount).strip()
    unit_text = "" if unit is None else str(unit).strip()
    if not amount_text and not unit_text:
        return None, None
    if not amount_text or unit_text not in DATA_UNITS:
        raise ApiError(400, message)
    try:
        quantity = Decimal(amount_text)
    except InvalidOperation as error:
        raise ApiError(400, message) from error
    if quantity <= 0 or quantity > Decimal("99999999.99") or quantity.as_tuple().exponent < -2:
        raise ApiError(400, message)
    return format(quantity, ".2f"), unit_text


def clean_router_ids(value, allowed, message):
    if value is None or value == "":
        return []
    if isinstance(value, str):
        parts = [item.strip() for item in value.replace("\n", ",").split(",")]
    elif isinstance(value, list):
        parts = [str(item).strip() for item in value]
    else:
        raise ApiError(400, message)
    chosen = []
    for router_id in parts:
        if not router_id:
            continue
        if router_id not in allowed:
            raise ApiError(400, message)
        if router_id not in chosen:
            chosen.append(router_id)
    if len(chosen) > 40:
        raise ApiError(400, "Select up to 40 routers.")
    return chosen


def load_offer_names(value):
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return [part.strip() for part in str(value).split(",") if part.strip()]
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed]


def clean_company_package(payload, allowed_client_ids):
    fields = clean_package_fields(payload)
    clients = clean_router_ids(
        payload.get("clients"),
        allowed_client_ids,
        "Select ISP clients that should receive this package.",
    )
    if allowed_client_ids and not clients:
        raise ApiError(400, "Select at least one ISP client.")
    fields.update(
        {
            "clients": clients,
            "applies_to_all": 1 if set(clients) == set(allowed_client_ids) else 0,
            "image": clean_package_image(payload.get("imageDataUrl")),
            "locations": "[]",
            "service_areas": "[]",
        }
    )
    return fields


def public_company_package(row):
    data_amount = row["data_allowance_amount"]
    fair_amount = row["fair_use_amount"]
    return {
        "id": row["id"],
        "name": row["name"],
        "serviceType": row["service_type"],
        "price": format(Decimal(row["price"]), ".2f"),
        "billingModel": row["billing_model"],
        "downloadMbps": int(row["download_mbps"]),
        "uploadMbps": int(row["upload_mbps"]),
        "validityAmount": int(row["validity_amount"]),
        "validityUnit": row["validity_unit"],
        "dataAllowanceAmount": None if data_amount is None else format(Decimal(data_amount), ".2f"),
        "dataAllowanceUnit": row["data_allowance_unit"],
        "dataAllowanceAction": row["data_allowance_action"],
        "dataThrottleDownloadMbps": None if row["data_throttle_download"] is None else int(row["data_throttle_download"]),
        "dataThrottleUploadMbps": None if row["data_throttle_upload"] is None else int(row["data_throttle_upload"]),
        "dataResetAmount": None if row["data_reset_amount"] is None else int(row["data_reset_amount"]),
        "dataResetUnit": row["data_reset_unit"],
        "fairUseAmount": None if fair_amount is None else format(Decimal(fair_amount), ".2f"),
        "fairUseUnit": row["fair_use_unit"],
        "fairUsePolicy": row["fair_use_policy"] or "",
        "fairUseAction": row["fair_use_action"],
        "fairThrottleDownloadMbps": None if row["fair_throttle_download"] is None else int(row["fair_throttle_download"]),
        "fairThrottleUploadMbps": None if row["fair_throttle_upload"] is None else int(row["fair_throttle_upload"]),
        "fairResetAmount": None if row["fair_reset_amount"] is None else int(row["fair_reset_amount"]),
        "fairResetUnit": row["fair_reset_unit"],
        "simultaneousDevices": int(row["simultaneous_devices"]) if row.get("simultaneous_devices") is not None else 1,
        "extraDevicePrice": None if row.get("extra_device_price") is None else format(Decimal(row["extra_device_price"]), ".2f"),
        "extraPeriodPrice": None if row.get("extra_period_price") is None else format(Decimal(row["extra_period_price"]), ".2f"),
        "graceAmount": None if row["grace_amount"] is None else int(row["grace_amount"]),
        "graceUnit": row["grace_unit"],
        "status": row["status"],
        "clients": load_offer_names(row.get("availability_clients")),
        "appliesToAll": bool(int(row.get("applies_to_all") or 0)),
        "imageDataUrl": row.get("image_data_url") or "",
    }


class ApiError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


def open_db(password, database=DB_NAME):
    return pymysql.connect(
        host=os.environ.get("ISP_DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("ISP_DB_PORT", "3306")),
        user=os.environ.get("ISP_DB_USER", "root"),
        password=password,
        database=database,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=DictCursor,
    )


_DB_POOL = queue.LifoQueue(maxsize=max(2, int(os.environ.get("ISP_DB_POOL") or 16)))


class _PooledDb:
    """Proxy that returns its connection to the idle pool on close() instead
    of disconnecting — every caller's existing with/close() pattern is kept.
    Releasing also restores a clean session state (rollback + autocommit) so
    no transaction or session flag ever leaks into the next user."""

    __slots__ = ("_conn", "_closed")

    def __init__(self, conn):
        self._conn = conn
        self._closed = False

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self):
        if self._closed:
            return
        self._closed = True
        conn = self._conn
        try:
            conn.rollback()
            conn.autocommit(True)
        except pymysql.MySQLError:
            conn.close()
            return
        try:
            _DB_POOL.put_nowait(conn)
        except queue.Full:
            conn.close()


def _pool_acquire(password):
    # Idle connections are pinged before reuse; dead ones are discarded and a
    # fresh connection is opened instead.
    for _ in range(4):
        try:
            conn = _DB_POOL.get_nowait()
        except queue.Empty:
            return _PooledDb(open_db(password))
        try:
            conn.ping(reconnect=False)
            return _PooledDb(conn)
        except pymysql.MySQLError:
            conn.close()
    return _PooledDb(open_db(password))


def connect():
    password = os.environ.get("ISP_DB_PASSWORD", "")
    try:
        return _pool_acquire(password)
    except pymysql.err.OperationalError as error:
        if password and error.args and error.args[0] == 1045:
            print("ISP_DB_PASSWORD was rejected by MySQL. Fix the configured password.", flush=True)
        raise


def ensure_database():
    """Create the database and its base account tables on a fresh server."""
    import seed

    password = os.environ.get("ISP_DB_PASSWORD", "")
    try:
        server = open_db(password, database=None)
    except pymysql.err.OperationalError as error:
        if password and error.args and error.args[0] == 1045:
            print("ISP_DB_PASSWORD was rejected by MySQL. Fix the configured password.", flush=True)
        raise
    try:
        with server.cursor() as cursor:
            cursor.execute(
                f"CREATE DATABASE IF NOT EXISTS `{DB_NAME.replace('`', '``')}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    finally:
        server.close()
    db = connect()
    try:
        with db.cursor() as cursor:
            for statement in seed.SCHEMA.split(";"):
                sql = statement.strip()
                if sql:
                    cursor.execute(sql)
    finally:
        db.close()


def ensure_schema():
    ensure_database()
    db = connect()
    try:
        with db.cursor() as cursor:
            for table in ("isp_clients", "isp_employees"):
                cursor.execute(f"SHOW COLUMNS FROM {table} LIKE 'photo_data_url'")
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE {table} ADD COLUMN photo_data_url MEDIUMTEXT NULL")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_sessions (
                  token CHAR(64) NOT NULL PRIMARY KEY,
                  account_kind ENUM('client', 'employee') NOT NULL,
                  account_id CHAR(36) NOT NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute("SHOW COLUMNS FROM isp_sessions LIKE 'opened_by'")
            if cursor.fetchone() is None:
                cursor.execute("ALTER TABLE isp_sessions ADD COLUMN opened_by CHAR(36) NULL")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_mikrotik_devices (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  name VARCHAR(80) NOT NULL,
                  site VARCHAR(80) NOT NULL,
                  role VARCHAR(40) NOT NULL,
                  routeros_version VARCHAR(20) NULL,
                  tunnel_ip VARCHAR(15) NOT NULL,
                  public_key CHAR(44) NOT NULL,
                  status ENUM('identity', 'waiting', 'active') NOT NULL DEFAULT 'identity',
                  backup_reference VARCHAR(160) NULL,
                  authorized_at DATETIME NULL,
                  recovery_confirmed_at DATETIME NULL,
                  stage_tested_at DATETIME NULL,
                  last_seen_at DATETIME NULL,
                  last_api_at DATETIME NULL,
                  tunnel_status ENUM('unknown', 'down', 'up') NOT NULL DEFAULT 'unknown',
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE KEY uq_mikrotik_tunnel_ip (tunnel_ip),
                  UNIQUE KEY uq_mikrotik_public_key (public_key),
                  UNIQUE KEY uq_mikrotik_client_name (client_id, name)
                )
                """
            )
            for column, definition in (
                ("backup_reference", "backup_reference VARCHAR(160) NULL"),
                ("authorized_at", "authorized_at DATETIME NULL"),
                ("recovery_confirmed_at", "recovery_confirmed_at DATETIME NULL"),
                ("stage_tested_at", "stage_tested_at DATETIME NULL"),
                ("last_seen_at", "last_seen_at DATETIME NULL"),
                ("last_api_at", "last_api_at DATETIME NULL"),
                ("tunnel_status", "tunnel_status ENUM('unknown', 'down', 'up') NOT NULL DEFAULT 'unknown'"),
                ("api_secret", "api_secret VARCHAR(512) NULL"),
                ("pppoe_enforced", "pppoe_enforced TINYINT NOT NULL DEFAULT 0"),
                ("hotspot_enabled", "hotspot_enabled TINYINT NOT NULL DEFAULT 0"),
                ("hotspot_block_sharing", "hotspot_block_sharing TINYINT NOT NULL DEFAULT 0"),
                ("wg_private", "wg_private VARCHAR(512) NULL"),
                ("port_plan", "port_plan TEXT NULL"),
            ):
                cursor.execute("SHOW COLUMNS FROM isp_mikrotik_devices LIKE %s", (column,))
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE isp_mikrotik_devices ADD COLUMN {definition}")
            cursor.execute(
                """
                ALTER TABLE isp_mikrotik_devices
                MODIFY status ENUM('identity', 'waiting', 'active', 'suspended') NOT NULL DEFAULT 'identity'
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_mikrotik_health_events (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  device_id CHAR(36) NOT NULL,
                  subject VARCHAR(80) NOT NULL,
                  reason VARCHAR(160) NOT NULL,
                  started_at DATETIME NOT NULL,
                  ended_at DATETIME NULL,
                  KEY idx_health_device (client_id, device_id, started_at)
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_wan_settings (
                  device_id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  mode ENUM('load-balance', 'failover', 'hybrid', 'manual-single') NOT NULL DEFAULT 'manual-single'
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_wan_uplinks (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  device_id CHAR(36) NOT NULL,
                  interface_name VARCHAR(32) NOT NULL,
                  provider VARCHAR(40) NOT NULL,
                  method ENUM('dhcp', 'pppoe', 'static') NOT NULL,
                  gateway VARCHAR(15) NOT NULL DEFAULT '',
                  download_mbps INT NOT NULL,
                  upload_mbps INT NOT NULL,
                  active TINYINT NOT NULL DEFAULT 0,
                  account_number VARCHAR(64) NOT NULL DEFAULT '',
                  UNIQUE KEY uq_wan_uplink (device_id, interface_name)
                )
                """
            )
            cursor.execute("SHOW COLUMNS FROM isp_wan_uplinks LIKE 'account_number'")
            if cursor.fetchone() is None:
                cursor.execute(
                    "ALTER TABLE isp_wan_uplinks ADD COLUMN account_number VARCHAR(64) NOT NULL DEFAULT ''"
                )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_wan_audit (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  device_id CHAR(36) NOT NULL,
                  job_id CHAR(36) NULL,
                  previous_uplink VARCHAR(32) NOT NULL DEFAULT '',
                  requested_uplink VARCHAR(32) NOT NULL DEFAULT '',
                  outcome VARCHAR(20) NOT NULL,
                  detail_text TEXT NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  KEY idx_wan_audit_device (client_id, device_id, created_at)
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_packages (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  name VARCHAR(80) NOT NULL,
                  price DECIMAL(10,2) NOT NULL,
                  download_mbps INT NOT NULL,
                  upload_mbps INT NOT NULL,
                  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  availability_routers TEXT NULL,
                  UNIQUE KEY uq_package_client_name (client_id, name)
                )
                """
            )
            cursor.execute("SHOW COLUMNS FROM isp_packages LIKE 'availability_routers'")
            if cursor.fetchone() is None:
                cursor.execute("ALTER TABLE isp_packages ADD COLUMN availability_routers TEXT NULL")
            cursor.execute("SHOW COLUMNS FROM isp_packages LIKE 'company_package_id'")
            if cursor.fetchone() is None:
                cursor.execute("ALTER TABLE isp_packages ADD COLUMN company_package_id CHAR(36) NULL")
            cursor.execute("SHOW COLUMNS FROM isp_packages LIKE 'customized'")
            if cursor.fetchone() is None:
                cursor.execute("ALTER TABLE isp_packages ADD COLUMN customized TINYINT NOT NULL DEFAULT 0")
            cursor.execute("SHOW COLUMNS FROM isp_packages LIKE 'image_data_url'")
            if cursor.fetchone() is None:
                cursor.execute("ALTER TABLE isp_packages ADD COLUMN image_data_url MEDIUMTEXT NULL")
            cursor.execute(
                """
                ALTER TABLE isp_packages
                MODIFY status ENUM('draft', 'active', 'archived', 'suspended') NOT NULL DEFAULT 'active'
                """
            )
            for column, definition in (
                ("service_type", "service_type ENUM('pppoe', 'hotspot') NOT NULL DEFAULT 'pppoe'"),
                ("billing_model", "billing_model ENUM('recurring', 'prepaid', 'voucher', 'usage') NOT NULL DEFAULT 'recurring'"),
                ("validity_amount", "validity_amount INT NOT NULL DEFAULT 1"),
                ("validity_unit", "validity_unit ENUM('hours', 'days', 'weeks', 'months') NOT NULL DEFAULT 'months'"),
                ("data_allowance_amount", "data_allowance_amount DECIMAL(12,2) NULL"),
                ("data_allowance_unit", "data_allowance_unit ENUM('MB', 'GB') NULL"),
                ("data_allowance_action", "data_allowance_action ENUM('throttle', 'disconnect') NULL"),
                ("data_throttle_download", "data_throttle_download INT NULL"),
                ("data_throttle_upload", "data_throttle_upload INT NULL"),
                ("data_reset_amount", "data_reset_amount INT NULL"),
                ("data_reset_unit", "data_reset_unit ENUM('hours', 'days', 'weeks', 'months') NULL"),
                ("fair_use_amount", "fair_use_amount DECIMAL(12,2) NULL"),
                ("fair_use_unit", "fair_use_unit ENUM('MB', 'GB') NULL"),
                ("fair_use_policy", "fair_use_policy VARCHAR(240) NULL"),
                ("fair_use_action", "fair_use_action ENUM('throttle', 'disconnect') NULL"),
                ("fair_throttle_download", "fair_throttle_download INT NULL"),
                ("fair_throttle_upload", "fair_throttle_upload INT NULL"),
                ("fair_reset_amount", "fair_reset_amount INT NULL"),
                ("fair_reset_unit", "fair_reset_unit ENUM('hours', 'days', 'weeks', 'months') NULL"),
                ("simultaneous_devices", "simultaneous_devices INT NOT NULL DEFAULT 1"),
                ("extra_device_price", "extra_device_price DECIMAL(10,2) NULL"),
                ("extra_period_price", "extra_period_price DECIMAL(10,2) NULL"),
                ("grace_amount", "grace_amount INT NULL"),
                ("grace_unit", "grace_unit ENUM('hours', 'days', 'weeks', 'months') NULL"),
            ):
                cursor.execute("SHOW COLUMNS FROM isp_packages LIKE %s", (column,))
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE isp_packages ADD COLUMN {definition}")
            cursor.execute(
                """
                SELECT COUNT(*) AS total FROM information_schema.statistics
                WHERE table_schema = DATABASE() AND table_name = 'isp_packages' AND index_name = 'uq_isp_package_company'
                """
            )
            if int(cursor.fetchone()["total"]) == 0:
                cursor.execute(
                    "ALTER TABLE isp_packages ADD UNIQUE KEY uq_isp_package_company (client_id, company_package_id)"
                )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_packages (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  name VARCHAR(80) NOT NULL,
                  service_type ENUM('pppoe', 'hotspot') NOT NULL DEFAULT 'pppoe',
                  price DECIMAL(10,2) NOT NULL,
                  billing_model ENUM('recurring', 'prepaid', 'voucher', 'usage') NOT NULL DEFAULT 'recurring',
                  download_mbps INT NOT NULL,
                  upload_mbps INT NOT NULL,
                  validity_amount INT NOT NULL DEFAULT 1,
                  validity_unit ENUM('hours', 'days', 'weeks', 'months') NOT NULL DEFAULT 'months',
                  data_allowance_amount DECIMAL(12,2) NULL,
                  data_allowance_unit ENUM('MB', 'GB') NULL,
                  fair_use_amount DECIMAL(12,2) NULL,
                  fair_use_unit ENUM('MB', 'GB') NULL,
                  fair_use_policy VARCHAR(240) NULL,
                  simultaneous_devices INT NOT NULL DEFAULT 1,
                  grace_amount INT NULL,
                  grace_unit ENUM('hours', 'days', 'weeks', 'months') NULL,
                  status ENUM('draft', 'active', 'archived', 'suspended') NOT NULL DEFAULT 'draft',
                  availability_routers TEXT NULL,
                  availability_locations TEXT NULL,
                  availability_service_areas TEXT NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE KEY uq_company_package_name (name)
                )
                """
            )
            cursor.execute(
                """
                ALTER TABLE company_packages
                MODIFY status ENUM('draft', 'active', 'archived', 'suspended') NOT NULL DEFAULT 'active'
                """
            )
            for column, definition in (
                ("service_type", "service_type ENUM('pppoe', 'hotspot') NOT NULL DEFAULT 'pppoe'"),
                ("billing_model", "billing_model ENUM('recurring', 'prepaid', 'voucher', 'usage') NOT NULL DEFAULT 'recurring'"),
                ("validity_amount", "validity_amount INT NOT NULL DEFAULT 1"),
                ("validity_unit", "validity_unit ENUM('hours', 'days', 'weeks', 'months') NOT NULL DEFAULT 'months'"),
                ("data_allowance_amount", "data_allowance_amount DECIMAL(12,2) NULL"),
                ("data_allowance_unit", "data_allowance_unit ENUM('MB', 'GB') NULL"),
                ("fair_use_amount", "fair_use_amount DECIMAL(12,2) NULL"),
                ("fair_use_unit", "fair_use_unit ENUM('MB', 'GB') NULL"),
                ("fair_use_policy", "fair_use_policy VARCHAR(240) NULL"),
                ("fair_use_action", "fair_use_action ENUM('throttle', 'disconnect') NULL"),
                ("fair_throttle_download", "fair_throttle_download INT NULL"),
                ("fair_throttle_upload", "fair_throttle_upload INT NULL"),
                ("data_allowance_action", "data_allowance_action ENUM('throttle', 'disconnect') NULL"),
                ("data_throttle_download", "data_throttle_download INT NULL"),
                ("data_throttle_upload", "data_throttle_upload INT NULL"),
                ("data_reset_amount", "data_reset_amount INT NULL"),
                ("data_reset_unit", "data_reset_unit ENUM('hours', 'days', 'weeks', 'months') NULL"),
                ("fair_reset_amount", "fair_reset_amount INT NULL"),
                ("fair_reset_unit", "fair_reset_unit ENUM('hours', 'days', 'weeks', 'months') NULL"),
                ("simultaneous_devices", "simultaneous_devices INT NOT NULL DEFAULT 1"),
                ("extra_device_price", "extra_device_price DECIMAL(10,2) NULL"),
                ("extra_period_price", "extra_period_price DECIMAL(10,2) NULL"),
                ("grace_amount", "grace_amount INT NULL"),
                ("grace_unit", "grace_unit ENUM('hours', 'days', 'weeks', 'months') NULL"),
                ("availability_routers", "availability_routers TEXT NULL"),
                ("availability_locations", "availability_locations TEXT NULL"),
                ("availability_service_areas", "availability_service_areas TEXT NULL"),
                ("availability_clients", "availability_clients TEXT NULL"),
                ("applies_to_all", "applies_to_all TINYINT NOT NULL DEFAULT 1"),
                ("image_data_url", "image_data_url MEDIUMTEXT NULL"),
            ):
                cursor.execute("SHOW COLUMNS FROM company_packages LIKE %s", (column,))
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE company_packages ADD COLUMN {definition}")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_daraja_settings (
                  id TINYINT NOT NULL PRIMARY KEY,
                  environment ENUM('sandbox', 'live') NOT NULL,
                  account_type ENUM('paybill', 'till') NOT NULL,
                  short_code VARCHAR(10) NOT NULL,
                  consumer_key VARCHAR(128) NOT NULL,
                  consumer_secret VARCHAR(128) NOT NULL,
                  passkey VARCHAR(255) NOT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_other_gateway (
                  id TINYINT NOT NULL PRIMARY KEY,
                  provider VARCHAR(80) NOT NULL,
                  environment ENUM('sandbox', 'live') NOT NULL,
                  endpoint VARCHAR(255) NOT NULL,
                  public_key VARCHAR(255) NOT NULL,
                  secret_key VARCHAR(255) NOT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_communication_settings (
                  channel ENUM('sms', 'whatsapp', 'email') NOT NULL PRIMARY KEY,
                  endpoint VARCHAR(255) NOT NULL,
                  sender VARCHAR(120) NOT NULL,
                  api_key VARCHAR(255) NOT NULL,
                  details TEXT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_profile_settings (
                  id TINYINT NOT NULL PRIMARY KEY,
                  company_name VARCHAR(120) NOT NULL,
                  email VARCHAR(120) NOT NULL DEFAULT '',
                  phone VARCHAR(20) NOT NULL DEFAULT '',
                  website VARCHAR(160) NOT NULL DEFAULT '',
                  address VARCHAR(200) NOT NULL DEFAULT '',
                  logo_data_url MEDIUMTEXT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_notification_settings (
                  id TINYINT NOT NULL PRIMARY KEY,
                  server_unreachable TINYINT NOT NULL DEFAULT 1,
                  mikrotik_unreachable TINYINT NOT NULL DEFAULT 1,
                  mikrotik_added TINYINT NOT NULL DEFAULT 1,
                  isp_registered TINYINT NOT NULL DEFAULT 1,
                  communications_failed TINYINT NOT NULL DEFAULT 1,
                  payments_failed TINYINT NOT NULL DEFAULT 1,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_push_settings (
                  id TINYINT NOT NULL PRIMARY KEY,
                  vapid_public VARCHAR(255) NOT NULL,
                  vapid_private VARCHAR(512) NOT NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS employee_push_subscriptions (
                  endpoint VARCHAR(500) NOT NULL PRIMARY KEY,
                  employee_id CHAR(36) NOT NULL,
                  p256dh VARCHAR(255) NOT NULL,
                  auth VARCHAR(64) NOT NULL,
                  user_agent VARCHAR(255) NOT NULL DEFAULT '',
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS company_push_dispatches (
                  item_id VARCHAR(96) NOT NULL PRIMARY KEY,
                  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS employee_notification_reads (
                  employee_id CHAR(36) NOT NULL,
                  item_id VARCHAR(96) NOT NULL,
                  read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (employee_id, item_id)
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_payment_settings (
                  client_id CHAR(36) NOT NULL,
                  scope ENUM('own', 'company') NOT NULL,
                  environment ENUM('sandbox', 'live') NOT NULL,
                  account_type ENUM('paybill', 'till') NOT NULL,
                  short_code VARCHAR(10) NOT NULL,
                  consumer_key VARCHAR(128) NOT NULL,
                  consumer_secret VARCHAR(128) NOT NULL,
                  passkey VARCHAR(255) NOT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (client_id, scope)
                )
                """
            )
            for column, definition in (
                ("callback_url", "callback_url VARCHAR(255) NOT NULL DEFAULT ''"),
                ("confirmation_url", "confirmation_url VARCHAR(255) NOT NULL DEFAULT ''"),
                ("validation_url", "validation_url VARCHAR(255) NOT NULL DEFAULT ''"),
                ("initiator_name", "initiator_name VARCHAR(128) NOT NULL DEFAULT ''"),
                ("security_credential", "security_credential TEXT NULL"),
            ):
                cursor.execute("SHOW COLUMNS FROM isp_payment_settings LIKE %s", (column,))
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE isp_payment_settings ADD COLUMN {definition}")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_payment_preferences (
                  client_id CHAR(36) NOT NULL PRIMARY KEY,
                  mode ENUM('own', 'company') NOT NULL
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS hotspot_purchases (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  device_id CHAR(36) NOT NULL,
                  package_id CHAR(36) NOT NULL,
                  phone VARCHAR(20) NOT NULL,
                  amount DECIMAL(10,2) NOT NULL,
                  checkout_id VARCHAR(64) NOT NULL,
                  mac VARCHAR(20) NOT NULL DEFAULT '',
                  ip VARCHAR(45) NOT NULL DEFAULT '',
                  devices INT NOT NULL DEFAULT 1,
                  periods INT NOT NULL DEFAULT 1,
                  login_url VARCHAR(255) NOT NULL DEFAULT '',
                  orig_url VARCHAR(255) NOT NULL DEFAULT '',
                  username VARCHAR(40) NOT NULL DEFAULT '',
                  password VARCHAR(40) NOT NULL DEFAULT '',
                  status ENUM('pending', 'paid', 'failed') NOT NULL DEFAULT 'pending',
                  authorized TINYINT NOT NULL DEFAULT 0,
                  paid_at TIMESTAMP NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE KEY uq_hotspot_checkout (checkout_id),
                  KEY idx_hotspot_client (client_id, created_at)
                )
                """
            )
            for column, definition in (
                ("devices", "devices INT NOT NULL DEFAULT 1"),
                ("periods", "periods INT NOT NULL DEFAULT 1"),
                ("login_url", "login_url VARCHAR(255) NOT NULL DEFAULT ''"),
                ("orig_url", "orig_url VARCHAR(255) NOT NULL DEFAULT ''"),
                ("mpesa_code", "mpesa_code VARCHAR(20) NOT NULL DEFAULT ''"),
                ("deleted", "deleted TINYINT NOT NULL DEFAULT 0"),
                ("ended_at", "ended_at TIMESTAMP NULL"),
            ):
                cursor.execute("SHOW COLUMNS FROM hotspot_purchases LIKE %s", (column,))
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE hotspot_purchases ADD COLUMN {definition}")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS hotspot_vouchers (
                  id CHAR(36) NOT NULL PRIMARY KEY,
                  client_id CHAR(36) NOT NULL,
                  purchase_id CHAR(36) NOT NULL,
                  device_id CHAR(36) NOT NULL,
                  package_id CHAR(36) NOT NULL,
                  code VARCHAR(20) NOT NULL,
                  username VARCHAR(40) NOT NULL DEFAULT '',
                  password VARCHAR(40) NOT NULL DEFAULT '',
                  seconds INT NOT NULL DEFAULT 0,
                  status ENUM('issued','used','void') NOT NULL DEFAULT 'issued',
                  redeemed_ip VARCHAR(45) NOT NULL DEFAULT '',
                  redeemed_mac VARCHAR(20) NOT NULL DEFAULT '',
                  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  used_at TIMESTAMP NULL,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  UNIQUE KEY uq_hs_voucher_code (code),
                  KEY idx_hs_voucher_purchase (purchase_id),
                  KEY idx_hs_voucher_username (username)
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_communication_settings (
                  client_id CHAR(36) NOT NULL,
                  channel ENUM('sms', 'whatsapp', 'email') NOT NULL,
                  endpoint VARCHAR(255) NOT NULL,
                  sender VARCHAR(120) NOT NULL,
                  api_key VARCHAR(255) NOT NULL,
                  details TEXT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (client_id, channel)
                )
                """
            )
            # Secret columns are sealed at rest — widen them to hold the
            # sealed (nonce + mac + ciphertext) form of the longest value.
            for statement in (
                "ALTER TABLE company_daraja_settings MODIFY COLUMN consumer_secret VARCHAR(512) NOT NULL",
                "ALTER TABLE company_daraja_settings MODIFY COLUMN passkey VARCHAR(512) NOT NULL",
                "ALTER TABLE company_other_gateway MODIFY COLUMN secret_key VARCHAR(512) NOT NULL",
                "ALTER TABLE company_communication_settings MODIFY COLUMN api_key VARCHAR(512) NOT NULL",
                "ALTER TABLE isp_payment_settings MODIFY COLUMN consumer_secret VARCHAR(512) NOT NULL",
                "ALTER TABLE isp_payment_settings MODIFY COLUMN passkey VARCHAR(512) NOT NULL",
                "ALTER TABLE isp_communication_settings MODIFY COLUMN api_key VARCHAR(512) NOT NULL",
            ):
                cursor.execute(statement)
            for table in ("company_communication_settings", "isp_communication_settings"):
                cursor.execute(f"SHOW COLUMNS FROM {table} LIKE 'details'")
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE {table} ADD COLUMN details TEXT NULL")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_communication_preferences (
                  client_id CHAR(36) NOT NULL,
                  channel ENUM('sms', 'whatsapp', 'email') NOT NULL,
                  mode ENUM('own', 'company') NOT NULL,
                  PRIMARY KEY (client_id, channel)
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_notification_settings (
                  client_id CHAR(36) NOT NULL PRIMARY KEY,
                  mikrotik_onboarded TINYINT NOT NULL DEFAULT 1,
                  mikrotik_unreachable TINYINT NOT NULL DEFAULT 1,
                  mikrotik_no_internet TINYINT NOT NULL DEFAULT 1,
                  client_cannot_surf TINYINT NOT NULL DEFAULT 1,
                  subscription_ending TINYINT NOT NULL DEFAULT 1,
                  communications_failed TINYINT NOT NULL DEFAULT 1,
                  payments_failed TINYINT NOT NULL DEFAULT 1,
                  server_unreachable TINYINT NOT NULL DEFAULT 1,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_company_settings (
                  client_id CHAR(36) NOT NULL PRIMARY KEY,
                  company_name VARCHAR(120) NOT NULL,
                  email VARCHAR(120) NOT NULL DEFAULT '',
                  phone VARCHAR(20) NOT NULL DEFAULT '',
                  website VARCHAR(160) NOT NULL DEFAULT '',
                  address VARCHAR(200) NOT NULL DEFAULT '',
                  logo_data_url MEDIUMTEXT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
                """
            )
            router_jobs.ensure_tables(cursor)
            pppoe_store.ensure_schema(cursor)
            gateway_store.ensure_schema(cursor)
            gateway_store.backfill_gateway_modes(cursor)
    finally:
        db.close()


STATIC_TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".txt": "text/plain",
    ".webmanifest": "application/manifest+json",
}


def web_root():
    try:
        root = WEB_ROOT.resolve()
    except OSError:
        return None
    return root if root.is_dir() else None


def verify_password(password, salt_hex, stored_hash):
    if stored_hash.startswith("pbkdf2$"):
        _, iteration_text, digest = stored_hash.split("$", 2)
        iterations = int(iteration_text)
        computed = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), iterations).hex()
        return hmac.compare_digest(computed, digest)
    legacy = hashlib.sha256(f"{salt_hex}:{password}".encode()).hexdigest()
    return hmac.compare_digest(legacy, stored_hash)


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
    return salt, f"pbkdf2${ITERATIONS}${digest}"


def digits(value):
    return "".join(character for character in value if character.isdigit())


def stored_router_key(sealed):
    if not sealed:
        return None
    try:
        key = routeros_api.open_password(sealed)
    except routeros_api.RouterError:
        return None
    if len(key) != 44 or not key.endswith("="):
        return None
    return key


def publish_tunnel_peers(cursor):
    import wg_host

    if not wg_host.local_server():
        return
    cursor.execute("SELECT public_key, tunnel_ip FROM isp_mikrotik_devices")
    try:
        wg_host.sync_peers(cursor.fetchall())
    except OSError as error:
        print(f"event=wireguard error={error}", flush=True)


def wireguard_keypair():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    except ImportError as error:
        raise ApiError(500, "The server cannot generate a device key pair.") from error
    private = X25519PrivateKey.generate()
    private_raw = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public_raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(private_raw).decode(), base64.b64encode(public_raw).decode()


def next_tunnel_ip(cursor):
    cursor.execute("SELECT tunnel_ip FROM isp_mikrotik_devices")
    used = {row["tunnel_ip"] for row in cursor.fetchall()}
    for number in range(2, 254):
        address = f"10.88.0.{number}"
        if address not in used:
            return address
    raise ApiError(409, "No free tunnel addresses are left in 10.88.0.0/24.")


def assert_login_allowed(portal, code):
    entry = LOCKS.get((portal, code))
    if entry and entry["until"] > time.time():
        raise ApiError(429, "Too many sign-in attempts. Try again in 15 minutes.")


def record_failure(portal, code):
    if len(LOCKS) > 50000:
        now = time.time()
        for key, entry in list(LOCKS.items()):
            if not entry["until"] or entry["until"] <= now:
                del LOCKS[key]
    entry = LOCKS.setdefault((portal, code), {"fails": 0, "until": 0})
    if entry["until"] and entry["until"] <= time.time():
        entry["fails"] = 0
        entry["until"] = 0
    entry["fails"] += 1
    if entry["fails"] >= MAX_FAILURES:
        entry["until"] = time.time() + LOCK_SECONDS


def clear_failure(portal, code):
    LOCKS.pop((portal, code), None)


def new_code(prefix, used):
    while True:
        code = prefix + "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        if code not in used:
            return code


def display_account_code(client_code):
    if not client_code:
        return None
    secret = os.environ.get("ISP_ACCOUNT_CODE_SECRET", "isp-centric-account-code")
    digest = hmac.new(secret.encode(), str(client_code).encode(), hashlib.sha256).digest()
    value = int.from_bytes(digest[:8], "big")
    chars = []
    for _ in range(8):
        chars.append(CODE_ALPHABET[value % len(CODE_ALPHABET)])
        value //= len(CODE_ALPHABET)
    return "".join(chars)


def public_client(row):
    return {
        "id": row["id"],
        "firstName": row["first_name"],
        "lastName": row["last_name"],
        "username": row["username"],
        "email": row["email"],
        "phone": row["phone"],
        "loginCode": row["login_code"],
        "photoDataUrl": row.get("photo_data_url") or "",
        "status": row["status"],
        "clientCode": row["client_code"],
        "dashboardCode": display_account_code(row["client_code"]),
    }


def public_employee(row):
    return {
        "id": row["id"],
        "firstName": row["first_name"],
        "lastName": row["last_name"],
        "username": row["username"],
        "email": row["email"],
        "phone": row["phone"],
        "loginCode": row["login_code"],
        "photoDataUrl": row.get("photo_data_url") or "",
        "status": row["status"],
        "employeeCode": row["employee_code"],
        "dashboardCode": display_account_code(row["employee_code"]),
        "role": row["role"],
    }


def clean_registration(payload):
    first = str(payload.get("firstName", "")).strip()
    last = str(payload.get("lastName", "")).strip()
    username = str(payload.get("username", "")).strip()
    email = str(payload.get("email", "")).strip()
    phone = str(payload.get("phone", "")).strip()
    login_code = str(payload.get("loginCode", "")).strip()
    password = str(payload.get("password", "")).strip()
    photo = str(payload.get("photoDataUrl", ""))
    if not first or not last or len(first) > 60 or len(last) > 60:
        raise ApiError(400, "Enter a first and last name.")
    if len(username) < 3 or len(username) > 24 or not all(character.isalnum() or character == "_" for character in username):
        raise ApiError(400, "Use 3 to 24 letters, numbers, or underscores.")
    if not email or len(email) > 120 or "@" not in email:
        raise ApiError(400, "Enter a valid email address.")
    phone_digits = digits(phone)
    if len(phone_digits) < 10 or len(phone_digits) > 15:
        raise ApiError(400, "Enter a phone number with 10 to 15 digits.")
    if len(login_code) != 6 or not login_code.isdigit() or len(password) != 6 or not password.isdigit():
        raise ApiError(400, "The login code and password must each be 6 digits.")
    if not photo.startswith("data:image/jpeg") or len(photo) > 200_000:
        raise ApiError(400, "The profile photo could not be accepted.")
    return {
        "first": first,
        "last": last,
        "username": username,
        "email": email,
        "phone": phone,
        "phone_digits": phone_digits,
        "login_code": login_code,
        "password": password,
        "photo": photo,
    }


def other_table(kind):
    return "isp_employees" if kind == "client" else "isp_clients"


def other_label(kind):
    return "employee" if kind == "client" else "ISP client"


def clean_profile(payload, existing):
    data = {
        "firstName": payload.get("firstName", ""),
        "lastName": payload.get("lastName", ""),
        "username": payload.get("username", ""),
        "email": payload.get("email", ""),
        "phone": payload.get("phone", ""),
        "loginCode": str(payload.get("loginCode", "")).strip() or existing["login_code"],
        "password": str(payload.get("password", "")).strip() or "000000",
        "photoDataUrl": str(payload.get("photoDataUrl", "")) or existing["photo_data_url"] or "data:image/jpeg;base64,",
    }
    return clean_registration(data)


def phone_pattern(phone_digits):
    return "^[^0-9]*" + "[^0-9]*".join(phone_digits) + "[^0-9]*$"


def unique_taken(cursor, table, column, value, exclude_id):
    extra = " AND id <> %s" if exclude_id else ""
    params = (value, exclude_id) if exclude_id else (value,)
    cursor.execute(f"SELECT id FROM {table} WHERE {column} = %s{extra} LIMIT 1", params)
    return cursor.fetchone() is not None


def unique_phone_taken(cursor, table, phone_digits, exclude_id):
    extra = " AND id <> %s" if exclude_id else ""
    params = (phone_pattern(phone_digits), exclude_id) if exclude_id else (phone_pattern(phone_digits),)
    cursor.execute(f"SELECT id FROM {table} WHERE phone REGEXP %s{extra} LIMIT 1", params)
    return cursor.fetchone() is not None


def assert_unique(cursor, kind, fields, exclude_id=None):
    table = "isp_clients" if kind == "client" else "isp_employees"
    label = other_label(kind)
    checks = (
        (table, "username", fields["username"], "That username is already in use."),
        (table, "email", fields["email"], "That email is already registered."),
        (other_table(kind), "username", fields["username"], f"That username is already used by an {label} account."),
        (other_table(kind), "email", fields["email"], f"That email is already used by an {label} account."),
    )
    for target, column, value, message in checks:
        if unique_taken(cursor, target, column, value, exclude_id):
            raise ApiError(409, message)
    if unique_phone_taken(cursor, table, fields["phone_digits"], exclude_id):
        raise ApiError(409, "That phone number is already registered.")
    if unique_phone_taken(cursor, other_table(kind), fields["phone_digits"], None):
        raise ApiError(409, f"That phone number is already used by an {label} account.")
    if unique_taken(cursor, table, "login_code", fields["login_code"], exclude_id) or unique_taken(
        cursor, other_table(kind), "login_code", fields["login_code"], None
    ):
        raise ApiError(409, "Those sign-in details are not available.")


def session_account_id(cursor, token, kind):
    if not token:
        return None
    cursor.execute(
        "SELECT account_id FROM isp_sessions WHERE token = %s AND account_kind = %s AND created_at >= DATE_SUB(NOW(), INTERVAL %s SECOND)",
        (token, kind, SESSION_SECONDS),
    )
    row = cursor.fetchone()
    return row["account_id"] if row else None


def approved_account(cursor, table, account_id):
    cursor.execute(f"SELECT status FROM {table} WHERE id = %s", (account_id,))
    row = cursor.fetchone()
    return row if row and row["status"] == "approved" else None


def reviewer_access(cursor, employee_id):
    cursor.execute("SELECT id FROM isp_employees WHERE status = 'approved' AND role = 'director'")
    directors = {row["id"] for row in cursor.fetchall()}
    if not directors:
        return "bootstrap"
    if employee_id in directors:
        return "allowed"
    return "denied"


def require_reviewer(cursor, employee_token):
    employee_id = session_account_id(cursor, employee_token, "employee")
    if not employee_id:
        raise ApiError(401, "Sign in to an employee account before reviewing accounts.")
    if not approved_account(cursor, "isp_employees", employee_id):
        raise ApiError(403, "An approved employee account is required to review accounts.")
    if reviewer_access(cursor, employee_id) == "denied":
        raise ApiError(403, "Only a signed-in Director can review accounts.")


def require_director(cursor, employee_token, subject="the company gateway"):
    """Director-only gate for the pooled-collection gateway. Other company
    settings may be read by any approved employee; money movement may not."""
    employee_id = session_account_id(cursor, employee_token, "employee")
    if not employee_id:
        raise ApiError(401, f"Sign in to the employee account before managing {subject}.")
    cursor.execute("SELECT status, role FROM isp_employees WHERE id = %s", (employee_id,))
    employee = cursor.fetchone()
    if not employee or employee["status"] != "approved":
        raise ApiError(403, f"An approved employee account is required to manage {subject}.")
    if (employee["role"] or "") != "director":
        raise ApiError(403, f"Only a signed-in Director can manage {subject}.")
    return employee_id


def session_opened_by(cursor, token):
    """Employee id when this client session was opened by staff via the
    director's "enter client portal" action — such sessions are read-only."""
    if not token:
        return None
    cursor.execute(
        "SELECT opened_by FROM isp_sessions WHERE token = %s AND account_kind = 'client'",
        (token,),
    )
    row = cursor.fetchone()
    return (row or {}).get("opened_by")


def require_owner_client(cursor, token, subject="payment settings"):
    """The ISP owner's own session — staff-opened sessions may read but
    never change destination, timing, or gateway mode."""
    client_id = session_account_id(cursor, token, "client")
    if not client_id:
        raise ApiError(401, f"Sign in to the ISP client account before managing {subject}.")
    if not approved_account(cursor, "isp_clients", client_id):
        raise ApiError(403, "That account is still waiting for approval.")
    if session_opened_by(cursor, token):
        raise ApiError(403, f"Only the account owner can change {subject}.")
    return client_id


HOTSPOT_PREVIEW_TOKENS = {
    "ip": "10.5.50.23",
    "mac": "8A:4F:7D:2C:91:B6",
    "mac-esc": "8A%3A4F%3A7D%3A2C%3A91%3AB6",
    "link-login": "http://10.5.50.1/login",
    "link-login-only": "http://10.5.50.1/login",
    "link-status": "http://10.5.50.1/status",
    "link-orig": "http://example.com/",
    "link-orig-esc": "http%3A%2F%2Fexample.com%2F",
    "error": "Your session ended — pay again to get back online.",
    "username": "hs-1a2b3c4d",
    "uptime": "0h42m",
    "session-time-left": "23h18m",
    "bytes-in-nice": "84 MB",
    "bytes-out-nice": "412 MB",
    "identity": "HotSpot",
    "hostname": "guest-phone",
}

def hotspot_preview_html(body):
    """Fill the RouterOS $(...) tokens with samples and drop the meta refresh
    so the preview stays on the page instead of forwarding to the portal."""
    html = body.decode("utf-8")
    html = re.sub(
        r"\$\(([\w-]+)\)",
        lambda match: HOTSPOT_PREVIEW_TOKENS.get(match.group(1), match.group(0)),
        html,
    )
    return re.sub(r'<meta[^>]*http-equiv="refresh"[^>]*>', "", html, flags=re.IGNORECASE)


# Fallback pay settings so the interactive preview still shows the full
# M-Pesa flow when the account has not saved Daraja details yet. Display-only:
# the simulated payment never calls Daraja, so nothing is ever charged.
PORTAL_PREVIEW_PAYMENT = {
    "account_type": "paybill",
    "short_code": "522001",
}

PREVIEW_BANNER = (
    '<div class=card><div style="margin:-6px 0 14px;padding:6px 10px;background:#fef3c7;color:#92400e;'
    "font-size:11px;font-weight:700;letter-spacing:.06em;text-align:center;border-radius:8px;"
    'text-transform:uppercase">Preview — nothing here is charged or saved</div>'
)

# Answers the pay pages' fetch calls with a scripted M-Pesa flow so the whole
# journey — pick a package, "pay", wait for the PIN, then land on a dummy
# speed test — runs end-to-end without touching Daraja, the database,
# or the router. Once the page sends a pay request a small panel asks the
# person previewing to approve or decline the simulated M-Pesa prompt;
# declining makes the status poll answer "failed" so the page itself shows
# the reason and asks the customer to try again.
PREVIEW_STUB = """
<script>
(function(){
var SIG=__SIG__;
var polls=0,onl=0,devices=1,outcome=null;
var codes=['K7F2-9XPL-4QWD','M3TB-8RHZ-6CJV','P8QA-2NWL-7XRT','D5HC-9BJK-3MVS','T6ZR-4FDM-8QKX','W2YN-7CPL-5RGH','J9VK-3XNB-6TQD','R4GD-8KWM-2PVJ','N7SX-5QTC-9DLB','F3MH-6JRD-4WZK'];
var realFetch=window.fetch;
function js(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}));}
function simPanel(){
 var old=document.getElementById('pv-sim');if(old)old.remove();
 var d=document.createElement('div');
 d.id='pv-sim';
 d.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#0b1220;color:#e2e8f0;border-radius:12px;padding:12px 14px;box-shadow:0 10px 32px rgba(2,6,23,.45);font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif';
 d.innerHTML='<div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#fbbf24;margin-bottom:4px">Preview simulation</div>'
  +'<div style="margin-bottom:10px;color:#cbd5e1">The M-Pesa prompt is on the phone. Pick what the customer does:</div>'
  +'<button type=button id=pv-ok style="border:0;border-radius:9px;padding:9px 14px;font-weight:700;font-size:13px;background:#22c55e;color:#052e16;cursor:pointer;margin-right:8px">Approve payment</button>'
  +'<button type=button id=pv-no style="border:0;border-radius:9px;padding:9px 14px;font-weight:700;font-size:13px;background:#ef4444;color:#fff;cursor:pointer">Decline payment</button>';
 document.body.appendChild(d);
 d.querySelector('#pv-ok').onclick=function(){outcome='paid';d.remove();};
 d.querySelector('#pv-no').onclick=function(){outcome='failed';d.remove();};
}
window.fetch=function(u,o){
 var p=String(u);
 if(p==='/hotspot/pay'){try{devices=Math.min(50,Math.max(1,parseInt(JSON.parse(o.body).devices,10)||1));}catch(e){}polls=0;outcome=null;simPanel();return js({checkoutId:'demo-'+Date.now()});}
 if(p.indexOf('/hotspot/status')===0){polls+=1;if(outcome==='failed')return js({state:'failed',reason:'The M-Pesa prompt was declined on the phone.'});if(outcome!=='paid'||polls<3)return js({state:'pending'});var vs=[];for(var i=0;i<devices;i++)vs.push({code:codes[i%codes.length],status:i===0?'used':'issued'});return js({state:'paid',purchase:'demo-purchase',username:'hs-demo1a2b',password:'demo1a2b',vouchers:vs});}
 if(p.indexOf('/hotspot/offers')===0)return js({state:'sale',sig:SIG});
 if(p==='/hotspot/redeem')return js({state:'connected',purchase:'demo-purchase'});
 if(p==='/pay'){polls=0;onl=0;outcome=null;simPanel();return js({checkoutId:'demo-'+Date.now()});}
 if(p.indexOf('/pay/status')===0){polls+=1;if(outcome==='failed')return js({state:'failed',reason:'The M-Pesa prompt was declined on the phone.'});if(outcome!=='paid'||polls<3)return js({state:'pending'});return js({state:'paid',voucher:codes[0]});}
 if(p.indexOf('/pay/online')===0){onl+=1;if(onl<3)return js({state:'connecting'});return js({state:'online'});}
 if(p.indexOf('/pay/offers')===0)return js({state:'sale',sig:SIG});
 return realFetch.apply(this,arguments);
};
})();
</script>
"""


# Landing page shown when the preview's "Done — continue" is pressed. The
# sandboxed preview frame cannot send the session cookie, so this page is
# fully self-contained and needs no account data — it stands in for the
# customer's own destination once they are online.
SPEEDTEST_HTML = """<!doctype html>
<html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Internet speed test</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1100px 700px at 50% -10%,#16233f,#0b1220);color:#e2e8f0;font:15px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif}
.box{width:320px;background:rgba(17,28,51,.92);border:1px solid #22345c;border-radius:20px;padding:26px 26px 18px;box-shadow:0 24px 60px rgba(0,0,0,.5);text-align:center}
.brand{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#38bdf8}
.num{font-size:56px;font-weight:800;color:#fff;font-variant-numeric:tabular-nums;line-height:1;margin:16px 0 2px}
.unit{font-size:14px;color:#94a3b8;font-weight:600}
.row{display:flex;justify-content:space-between;margin-top:14px;font-size:13px;color:#94a3b8}
.row b{color:#e2e8f0;font-variant-numeric:tabular-nums}
.note{margin-top:18px;font-size:11px;color:#64748b;border-top:1px dashed #334155;padding-top:12px}
</style></head><body>
<div class=box>
<div class=brand>Speed test</div>
<div class=num id=n>0.0</div><div class=unit id=u>connecting…</div>
<div class=row><span>Ping</span><b id=pg>— ms</b></div>
<div class=row><span>Download</span><b id=dl>— Mbps</b></div>
<div class=row><span>Upload</span><b id=ul>— Mbps</b></div>
<div class=note>You are online — this speed test is simulated for the preview.</div>
</div>
<script>
(function(){
var n=document.getElementById('n'),u=document.getElementById('u');
var pg=document.getElementById('pg'),dl=document.getElementById('dl'),ul=document.getElementById('ul');
var ping=6+Math.floor(Math.random()*14),down=18+Math.random()*40,up=6+Math.random()*20;
pg.textContent=ping+' ms';
function run(target,label,done){
 u.textContent='Mbps '+label;var t0=null;
 function step(ts){if(!t0)t0=ts;var k=Math.min(1,(ts-t0)/1800);var e=1-Math.pow(1-k,3);n.textContent=(target*e).toFixed(1);if(k<1)requestAnimationFrame(step);else if(done)done();}
 requestAnimationFrame(step);
}
setTimeout(function(){run(down,'download',function(){dl.textContent=down.toFixed(1)+' Mbps';setTimeout(function(){run(up,'upload',function(){ul.textContent=up.toFixed(1)+' Mbps';});},500);});},600);
})();
</script></body></html>"""


def portal_preview_html(body, sig="", interactive=False, images=None):
    html = hotspot_preview_html(body)
    html = html.replace("'/thank-you", "'/api/portal-preview/speedtest")
    # Live pages fetch package art from the portal's /pkg-img endpoint; the
    # preview has no portal origin, so the stored data URLs are swapped back
    # in — preview weight does not matter the way the captive pages' does.
    for package_id, data_url in (images or {}).items():
        if data_url:
            html = html.replace(f'src="/pkg-img?id={package_id}"', f'src="{data_url}"')
    if interactive:
        stub = PREVIEW_STUB.replace("__SIG__", json.dumps(sig))
        html = html.replace("<div class=card>", PREVIEW_BANNER, 1).replace("</body>", stub + "</body>")
    return html


class PreviewPage:
    __slots__ = ("html",)

    def __init__(self, html):
        self.html = html


def gateway_feed_items(cursor, audience, client_id=None):
    """Gateway notices merged into the existing feeds — same item shape."""
    items = []
    for row in gateway_notify.feed_items(cursor, audience, client_id=client_id, limit=50):
        items.append(
            {
                "id": f"gateway-{row['id']}",
                "kind": "gateway",
                "subject": row["subject"],
                "detail": row["detail"],
                "at": stamp(row["created_at"]),
                "open": False,
            }
        )
    return items


def company_notification_items(cursor):
    """The company feed as data — shared by the notifications page and the
    push dispatcher, which diffs it to find genuinely new events."""
    cursor.execute("SELECT * FROM company_notification_settings WHERE id = 1")
    prefs = public_notification_settings(cursor.fetchone(), NOTIFICATION_TOGGLES)
    items = []
    if prefs["ispRegistered"]:
        cursor.execute(
            """
            SELECT id, first_name, last_name, status, created_at
            FROM isp_clients
            ORDER BY created_at DESC
            LIMIT 20
            """
        )
        for row in cursor.fetchall():
            name = f"{row['first_name']} {row['last_name']}".strip()
            items.append(
                {
                    "id": f"client-{row['id']}",
                    "kind": "ispRegistered",
                    "subject": "New ISP registered",
                    "detail": f"{name} signed up — status {row['status']}.",
                    "at": stamp(row["created_at"]),
                    "open": row["status"] == "pending",
                }
            )
    if prefs["mikrotikAdded"]:
        cursor.execute(
            """
            SELECT d.id, d.name, d.created_at, c.first_name, c.last_name
            FROM isp_mikrotik_devices d
            JOIN isp_clients c ON c.id = d.client_id
            ORDER BY d.created_at DESC
            LIMIT 20
            """
        )
        for row in cursor.fetchall():
            owner = f"{row['first_name']} {row['last_name']}".strip()
            items.append(
                {
                    "id": f"device-{row['id']}",
                    "kind": "mikrotikAdded",
                    "subject": "New MikroTik added",
                    "detail": f"{row['name']} was added by {owner}.",
                    "at": stamp(row["created_at"]),
                    "open": False,
                }
            )
    if prefs["mikrotikUnreachable"]:
        cursor.execute(
            """
            SELECT e.id, e.subject, e.reason, e.started_at, e.ended_at,
                   d.name AS device_name, c.first_name, c.last_name
            FROM isp_mikrotik_health_events e
            JOIN isp_mikrotik_devices d ON d.id = e.device_id
            JOIN isp_clients c ON c.id = e.client_id
            ORDER BY e.started_at DESC
            LIMIT 30
            """
        )
        for row in cursor.fetchall():
            ended = row["ended_at"] is not None
            owner = f"{row['first_name']} {row['last_name']}".strip()
            items.append(
                {
                    "id": f"health-{row['id']}",
                    "kind": "mikrotikUnreachable",
                    "subject": row["subject"],
                    "detail": f"{row['device_name']} ({owner}): {row['reason']}" + ("" if ended else " — still down."),
                    "at": stamp(row["started_at"]),
                    "open": not ended,
                }
            )
    items += gateway_feed_items(cursor, "company")
    items.sort(key=lambda item: item["at"] or "", reverse=True)
    return items


class ApiServer(ThreadingHTTPServer):
    """Refuses to share its port: without SO_EXCLUSIVEADDRUSE a second
    api.py instance can bind the same TCP port on Windows and silently
    split the service (one owns HTTP, the other owns RADIUS). On POSIX,
    SO_REUSEADDR is safe — it only permits rebinding over TIME_WAIT
    connections, never a second live listener — so restarts under load
    do not hit EADDRINUSE."""

    allow_reuse_address = os.name != "nt"
    daemon_threads = True
    request_queue_size = 128
    max_workers = int(os.environ.get("ISP_HTTP_WORKERS") or 64)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._slots = threading.BoundedSemaphore(self.max_workers)

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, client_address):
        self._slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 keep-alive: one TCP connection + thread serves many requests,
    # so a page load stops paying a handshake and thread spawn per asset.
    # Idle keep-alive slots are bounded so parked browsers cannot starve the
    # 64-worker pool.
    protocol_version = "HTTP/1.1"
    keepalive_seconds = max(2, int(os.environ.get("ISP_HTTP_KEEPALIVE") or 10))

    def log_message(self, fmt, *args):
        return

    def setup(self):
        super().setup()
        self.connection.settimeout(45)

    def handle(self):
        self.close_connection = True
        try:
            self.handle_one_request()
            self.connection.settimeout(self.keepalive_seconds)
            while not self.close_connection:
                self.handle_one_request()
        except OSError:
            pass

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        started = time.perf_counter()
        status = 500
        path = urlparse(self.path).path
        try:
            if method == "GET" and not path.startswith("/api/"):
                status = self.serve_static(path)
                return
            bucket = "callback" if path.startswith("/api/daraja/") else ("auth" if path in AUTH_PATHS else "api")
            if not rate_ok((bucket, request_ip(self)), *RATE_RULES[bucket]):
                raise ApiError(429, "Too many requests. Wait a moment and try again.")
            payload = self.read_json() if method == "POST" else {}
            token = self.cookies()
            query = parse_qs(urlparse(self.path).query)
            # A pooled connection can die between its ping and the query —
            # retry reads once on a fresh connection so a blip is not a 500.
            for attempt in range(2 if method == "GET" else 1):
                try:
                    with connect() as db:
                        with db.cursor() as cursor:
                            body, cookie = self.dispatch(cursor, method, path, payload, token, query)
                    break
                except pymysql.err.OperationalError:
                    if attempt:
                        raise
            status = 200
            if isinstance(body, PreviewPage):
                self.send_html(200, body.html.encode("utf-8"))
                return
            self.send_json(status, body, cookie)
        except ApiError as error:
            status = error.status
            body = {"error": str(error)}
            if error.details:
                body.update(error.details)
            self.send_json(status, body)
        except pppoe_store.PppoeError as error:
            status = error.status
            body = {"error": str(error)}
            if error.details:
                body.update(error.details)
            self.send_json(status, body)
        except pymysql.MySQLError as error:
            print(f"event=db-error method={method} path={path} error={error}", flush=True)
            self.send_json(status, {"error": "The account database could not be reached."})
        except gateway_crypto.GatewayCryptoError as error:
            status = 503
            print(f"event=gateway-crypto path={path} error={error}", flush=True)
            self.send_json(status, {"error": str(error)})
        except Exception:
            traceback.print_exc()
            self.send_json(status, {"error": "The account service could not complete that request."})
        finally:
            elapsed = int((time.perf_counter() - started) * 1000)
            print(f"event=request method={method} path={path} status={status} ms={elapsed}", flush=True)

    def dispatch(self, cursor, method, path, payload, token, query):
        handled = pppoe_store.dispatch(cursor, method, path, payload, token, query)
        if handled is not None:
            return handled
        if method == "GET" and path == "/api/client/session":
            return {"account": self.client_by_session(cursor, token.get("isp_client_session"))}, None
        if method == "GET" and path == "/api/employee/session":
            return {"employee": self.employee_by_session(cursor, token.get("isp_employee_session"))}, None
        if method == "GET" and path == "/api/employee/access":
            employee_id = session_account_id(cursor, token.get("isp_employee_session"), "employee")
            return {"access": reviewer_access(cursor, employee_id)}, None
        if method == "GET" and path == "/api/client/reviews":
            require_reviewer(cursor, token.get("isp_employee_session"))
            cursor.execute("SELECT * FROM isp_clients ORDER BY first_name, last_name")
            return {"accounts": [public_client(row) for row in cursor.fetchall()]}, None
        if method == "GET" and path == "/api/employee/reviews":
            require_reviewer(cursor, token.get("isp_employee_session"))
            cursor.execute("SELECT * FROM isp_employees ORDER BY first_name, last_name")
            return {"employees": [public_employee(row) for row in cursor.fetchall()]}, None
        if method == "POST" and path == "/api/client/login":
            return self.login(cursor, "client", payload)
        if method == "POST" and path == "/api/employee/login":
            return self.login(cursor, "employee", payload)
        if method == "POST" and path == "/api/client/logout":
            self.clear_session(cursor, token.get("isp_client_session"), "client")
            return {"ok": True}, ("isp_client_session", "", 0)
        if method == "POST" and path == "/api/employee/logout":
            self.clear_session(cursor, token.get("isp_employee_session"), "employee")
            return {"ok": True}, ("isp_employee_session", "", 0)
        if method == "POST" and path == "/api/client/register":
            return {"account": self.register(cursor, "client", payload)}, None
        if method == "POST" and path == "/api/employee/register":
            return {"employee": self.register(cursor, "employee", payload)}, None
        if method == "POST" and path == "/api/client/profile":
            return self.update_profile(cursor, "client", payload, token.get("isp_client_session"))
        if method == "POST" and path == "/api/employee/profile":
            return self.update_profile(cursor, "employee", payload, token.get("isp_employee_session"))
        if method == "GET" and path == "/api/employee/company/packages":
            employee_token = token.get("isp_employee_session")
            return {
                "packages": self.list_company_packages(cursor, employee_token),
                "clients": self.public_package_clients(cursor),
            }, None
        if method == "POST" and path == "/api/employee/company/packages":
            return {"package": self.create_company_package(cursor, payload, token.get("isp_employee_session"))}, None
        if method == "POST" and path.startswith("/api/employee/company/packages/"):
            return self.change_company_package(
                cursor,
                path.removeprefix("/api/employee/company/packages/").strip("/"),
                payload,
                token.get("isp_employee_session"),
            )
        if method == "GET" and path == "/api/employee/company/payments":
            return self.read_company_payments(cursor, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/payments":
            return self.save_company_payments(cursor, payload, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/payments/test":
            return {"test": self.test_company_payments(cursor, payload, token.get("isp_employee_session"))}, None
        if path.startswith("/api/employee/company/gateway"):
            return self.company_gateway(cursor, method, path, payload, query, token), None
        if method == "GET" and path == "/api/employee/company/communications":
            return self.read_company_communications(cursor, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/communications":
            return self.save_company_communication(cursor, payload, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/communications/test":
            return {"test": self.test_company_communication(cursor, payload, token.get("isp_employee_session"))}, None
        if method == "GET" and path == "/api/employee/company/profile":
            return self.read_company_profile(cursor, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/profile":
            return self.save_company_profile(cursor, payload, token.get("isp_employee_session")), None
        if method == "GET" and path == "/api/employee/company/notifications":
            return self.read_company_notifications(cursor, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/notifications":
            return self.save_company_notifications(cursor, payload, token.get("isp_employee_session")), None
        if method == "GET" and path == "/api/employee/company/notifications/feed":
            return self.company_notification_feed(cursor, token.get("isp_employee_session")), None
        if method == "GET" and path == "/api/employee/company/notifications/push":
            return self.read_company_push(cursor, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/notifications/push/subscribe":
            return self.save_company_push_subscription(cursor, payload, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/notifications/push/unsubscribe":
            return self.delete_company_push_subscription(cursor, payload, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/notifications/push/test":
            return self.test_company_push(cursor, payload, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/notifications/read":
            return self.mark_company_notifications_read(cursor, payload, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/director/clients/enter":
            require_reviewer(cursor, token.get("isp_employee_session"))
            employee_id = session_account_id(cursor, token.get("isp_employee_session"), "employee")
            return self.enter_client_portal(cursor, str(payload.get("id", "")), employee_id)
        if method == "POST" and path == "/api/client/approve":
            require_reviewer(cursor, token.get("isp_employee_session"))
            return {"account": self.approve_client(cursor, str(payload.get("id", "")))}, None
        if method == "POST" and path == "/api/employee/approve":
            require_reviewer(cursor, token.get("isp_employee_session"))
            return {"employee": self.approve_employee(cursor, str(payload.get("id", "")))}, None
        if method == "POST" and path == "/api/daraja/callback":
            expected = os.environ.get("ISP_DARAJA_CALLBACK_TOKEN", "").strip()
            if expected:
                supplied = str((query.get("key") or [""])[0])
                if not supplied or not hmac.compare_digest(supplied, expected):
                    raise ApiError(403, "That callback was not recognised.")
            return {"callback": pppoe_store.record_daraja_callback(cursor, payload)}, None
        routed = gateway_callbacks.route(path) if method == "POST" else None
        if routed:
            # /api/daraja/<callback_secret>/<endpoint> — an unknown secret or
            # endpoint is indistinguishable from a nonexistent path.
            secret, endpoint = routed
            if not gateway_callbacks.secret_ok(cursor, secret):
                raise ApiError(404, "Not found.")
            event_id = gateway_callbacks.handle(cursor, endpoint, payload)
            if event_id:
                gateway_callbacks.enqueue(connect, endpoint, payload, event_id)
            return gateway_callbacks.ACK, None
        if method == "GET" and path == "/api/health":
            return self.health(cursor), None
        if method == "GET" and path == "/api/dashboard/summary":
            return {"summary": self.dashboard_summary(cursor, token.get("isp_client_session"))}, None
        if method == "POST" and path == "/api/mikrotiks":
            return {"device": self.create_mikrotik(cursor, payload, token.get("isp_client_session"))}, None
        if method == "GET" and path == "/api/mikrotiks":
            return self.list_mikrotiks(cursor, token.get("isp_client_session"), query), None
        if method == "GET" and path.startswith("/api/jobs/"):
            return {"job": self.read_job(cursor, path.removeprefix("/api/jobs/").strip("/"), token.get("isp_client_session"))}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/jobs"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/jobs").strip("/")
            return {"job": self.enqueue_job(cursor, device_id, token.get("isp_client_session"), payload)}, None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/health"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/health").strip("/")
            selected = query.get("range", ["live"])[0]
            return {"trend": self.router_health_trend(cursor, device_id, token.get("isp_client_session"), selected)}, None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/live"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/live").strip("/")
            return {"live": self.live_mikrotik(cursor, device_id, token.get("isp_client_session"))}, None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/setup"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/setup").strip("/")
            return {"setup": self.setup_mikrotik(cursor, device_id, token.get("isp_client_session"))}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/details"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/details").strip("/")
            return {"device": self.save_mikrotik_details(cursor, device_id, token.get("isp_client_session"), payload)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/access"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/access").strip("/")
            return {"device": self.save_mikrotik_access(cursor, device_id, token.get("isp_client_session"), payload)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/pppoe"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/pppoe").strip("/")
            return self.save_pppoe_enforcement(cursor, device_id, token.get("isp_client_session"), payload), None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/ports"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/ports").strip("/")
            return self.save_port_uses(cursor, device_id, token.get("isp_client_session"), payload), None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/hotspot"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/hotspot").strip("/")
            return self.save_hotspot_access(cursor, device_id, token.get("isp_client_session"), payload), None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/hotspot/pages"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/hotspot/pages").strip("/")
            return {"pages": self.hotspot_page_previews(cursor, device_id, token.get("isp_client_session"))}, None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/pppoe/pages"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/pppoe/pages").strip("/")
            return {"pages": self.pppoe_page_previews(cursor, device_id, token.get("isp_client_session"))}, None
        if method == "GET" and path == "/api/portal-preview/thank-you":
            return self.preview_thank_you(cursor, token.get("isp_client_session"), query), None
        if method == "GET" and path == "/api/portal-preview/speedtest":
            return PreviewPage(SPEEDTEST_HTML), None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/apply"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/apply").strip("/")
            return self.apply_selection(cursor, device_id, token.get("isp_client_session"), payload), None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/wan/reachability"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/wan/reachability").strip("/")
            return {"health": self.wan_reachability(cursor, device_id, token.get("isp_client_session"))}, None
        if method == "GET" and path.startswith("/api/mikrotiks/") and path.endswith("/wan"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/wan").strip("/")
            return self.read_wan(cursor, device_id, token.get("isp_client_session")), None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/wan/switch"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/wan/switch").strip("/")
            return {"job": self.request_wan_switch(cursor, device_id, token.get("isp_client_session"), payload)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/wan/active"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/wan/active").strip("/")
            return self.record_wan_active(cursor, device_id, token.get("isp_client_session"), payload), None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/wan"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/wan").strip("/")
            return self.save_wan(cursor, device_id, token.get("isp_client_session"), payload), None
        if method == "POST" and path.startswith("/api/jobs/") and path.endswith("/cancel"):
            job_id = path.removeprefix("/api/jobs/").removesuffix("/cancel").strip("/")
            return {"job": self.cancel_router_job(cursor, job_id, token.get("isp_client_session"))}, None
        if method == "GET" and path.startswith("/api/mikrotiks/"):
            return {"device": self.read_mikrotik(cursor, path.removeprefix("/api/mikrotiks/"), token.get("isp_client_session"))}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/waiting"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/waiting").strip("/")
            return {"device": self.mark_mikrotik_waiting(cursor, device_id, token.get("isp_client_session"), payload)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/stage-test"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/stage-test").strip("/")
            return {"device": self.record_stage_test(cursor, device_id, token.get("isp_client_session"), payload)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/delete"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/delete").strip("/")
            return self.delete_mikrotik(cursor, device_id, token.get("isp_client_session")), None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/suspend"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/suspend").strip("/")
            return {"device": self.set_mikrotik_suspended(cursor, device_id, token.get("isp_client_session"), True)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/unsuspend"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/unsuspend").strip("/")
            return {"device": self.set_mikrotik_suspended(cursor, device_id, token.get("isp_client_session"), False)}, None
        if method == "POST" and path.startswith("/api/mikrotiks/") and path.endswith("/reboot"):
            device_id = path.removeprefix("/api/mikrotiks/").removesuffix("/reboot").strip("/")
            return self.reboot_mikrotik(cursor, device_id, token.get("isp_client_session")), None
        if method == "GET" and path == "/api/packages":
            client_token = token.get("isp_client_session")
            return {
                "packages": self.list_packages(cursor, client_token),
                "routers": self.public_package_routers(cursor, self.require_package_client(cursor, client_token)),
            }, None
        if method == "POST" and path == "/api/packages":
            return {"package": self.create_package(cursor, payload, token.get("isp_client_session"))}, None
        if method == "POST" and path.startswith("/api/packages/"):
            return self.change_package(cursor, path.removeprefix("/api/packages/").strip("/"), payload, token.get("isp_client_session"))
        if method == "GET" and path == "/api/company":
            return self.read_company(cursor, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/company":
            return self.save_company(cursor, payload, token.get("isp_client_session")), None
        if method == "GET" and path == "/api/payments":
            return self.read_payments(cursor, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/payments":
            return self.save_payments(cursor, payload, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/payments/test":
            return {"test": self.test_payments(cursor, payload, token.get("isp_client_session"))}, None
        if path.startswith("/api/gateway"):
            return self.isp_gateway(cursor, method, path, payload, query, token), None
        if method == "GET" and path == "/api/communications":
            return self.read_communications(cursor, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/communications":
            return self.save_communication(cursor, payload, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/communications/test":
            return {"test": self.test_communication(cursor, payload, token.get("isp_client_session"))}, None
        if method == "GET" and path == "/api/notifications":
            return self.read_notifications(cursor, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/notifications":
            return self.save_notifications(cursor, payload, token.get("isp_client_session")), None
        if method == "GET" and path == "/api/notifications/feed":
            return self.notification_feed(cursor, token.get("isp_client_session")), None
        raise ApiError(404, "That account request was not found.")

    def login(self, cursor, kind, payload):
        code = str(payload.get("loginCode", "")).strip()
        password = str(payload.get("password", ""))
        if len(code) != 6 or not code.isdigit() or len(password) != 6 or not password.isdigit():
            raise ApiError(400, "Enter the 6-digit login code and password.")
        assert_login_allowed(kind, code)
        table = "isp_clients" if kind == "client" else "isp_employees"
        cursor.execute(f"SELECT * FROM {table} WHERE login_code = %s", (code,))
        account = cursor.fetchone()
        salt = account["password_salt"] if account else "00" * 16
        stored = account["password_hash"] if account else f"pbkdf2${ITERATIONS}${'00' * 32}"
        valid = verify_password(password, salt, stored)
        if not account or not valid:
            record_failure(kind, code)
            raise ApiError(401, "The login code or password is incorrect.")
        clear_failure(kind, code)
        session = secrets.token_hex(32)
        cursor.execute(
            "INSERT INTO isp_sessions (token, account_kind, account_id) VALUES (%s, %s, %s)",
            (session, kind, account["id"]),
        )
        cookie_name = "isp_client_session" if kind == "client" else "isp_employee_session"
        public = public_client(account) if kind == "client" else public_employee(account)
        key = "account" if kind == "client" else "employee"
        return {key: public}, (cookie_name, session, SESSION_SECONDS)

    def register(self, cursor, kind, payload):
        fields = clean_registration(payload)
        assert_unique(cursor, kind, fields)
        salt, password_hash = hash_password(fields["password"])
        account_id = str(uuid.uuid4())
        if kind == "client":
            cursor.execute(
                """
                INSERT INTO isp_clients (
                  id, first_name, last_name, username, email, phone, login_code,
                  password_salt, password_hash, photo_data_url, status, client_code
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending', NULL)
                """,
                (
                    account_id,
                    fields["first"],
                    fields["last"],
                    fields["username"],
                    fields["email"],
                    fields["phone"],
                    fields["login_code"],
                    salt,
                    password_hash,
                    fields["photo"],
                ),
            )
            notify_push_now()
            cursor.execute("SELECT * FROM isp_clients WHERE id = %s", (account_id,))
            return public_client(cursor.fetchone())
        cursor.execute(
            """
            INSERT INTO isp_employees (
              id, first_name, last_name, username, email, phone, login_code,
              password_salt, password_hash, photo_data_url, status, employee_code, role
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending', NULL, NULL)
            """,
            (
                account_id,
                fields["first"],
                fields["last"],
                fields["username"],
                fields["email"],
                fields["phone"],
                fields["login_code"],
                salt,
                password_hash,
                fields["photo"],
            ),
        )
        cursor.execute("SELECT * FROM isp_employees WHERE id = %s", (account_id,))
        return public_employee(cursor.fetchone())

    def update_profile(self, cursor, kind, payload, token):
        account_id = session_account_id(cursor, token, kind)
        if not account_id:
            raise ApiError(401, "Sign in before editing the profile.")
        table = "isp_clients" if kind == "client" else "isp_employees"
        cursor.execute(f"SELECT * FROM {table} WHERE id = %s", (account_id,))
        existing = cursor.fetchone()
        if not existing:
            raise ApiError(404, "That account was not found.")
        fields = clean_profile(payload, existing)
        assert_unique(cursor, kind, fields, exclude_id=account_id)
        columns = "first_name = %s, last_name = %s, username = %s, email = %s, phone = %s, login_code = %s, photo_data_url = %s"
        values = [
            fields["first"],
            fields["last"],
            fields["username"],
            fields["email"],
            fields["phone"],
            fields["login_code"],
            fields["photo"],
        ]
        password_changed = bool(str(payload.get("password", "")).strip())
        if password_changed:
            salt, password_hash = hash_password(fields["password"])
            columns += ", password_salt = %s, password_hash = %s"
            values += [salt, password_hash]
        values.append(account_id)
        cursor.execute(f"UPDATE {table} SET {columns} WHERE id = %s", tuple(values))
        if password_changed:
            cursor.execute(
                "DELETE FROM isp_sessions WHERE account_id = %s AND account_kind = %s AND token <> %s",
                (account_id, kind, token or ""),
            )
        cursor.execute(f"SELECT * FROM {table} WHERE id = %s", (account_id,))
        row = cursor.fetchone()
        if kind == "client":
            return {"account": public_client(row)}, None
        return {"employee": public_employee(row)}, None

    def enter_client_portal(self, cursor, account_id, employee_id=None):
        cursor.execute("SELECT * FROM isp_clients WHERE id = %s", (account_id,))
        account = cursor.fetchone()
        if not account:
            raise ApiError(404, "That ISP client was not found.")
        session = secrets.token_hex(32)
        cursor.execute(
            "INSERT INTO isp_sessions (token, account_kind, account_id, opened_by) VALUES (%s, %s, %s, %s)",
            (session, "client", account["id"], employee_id),
        )
        return {"account": public_client(account)}, ("isp_client_session", session, SESSION_SECONDS)

    def approve_client(self, cursor, account_id):
        cursor.execute("SELECT * FROM isp_clients WHERE id = %s", (account_id,))
        account = cursor.fetchone()
        if not account:
            raise ApiError(404, "That account was not found.")
        code = account["client_code"]
        if not code:
            cursor.execute("SELECT client_code FROM isp_clients WHERE client_code IS NOT NULL")
            code = new_code("IC-", {row["client_code"] for row in cursor.fetchall()})
        cursor.execute(
            "UPDATE isp_clients SET status = 'approved', client_code = %s WHERE id = %s",
            (code, account_id),
        )
        self.copy_default_packages_to_client(cursor, account_id)
        cursor.execute("SELECT * FROM isp_clients WHERE id = %s", (account_id,))
        return public_client(cursor.fetchone())

    def approve_employee(self, cursor, account_id):
        cursor.execute("SELECT * FROM isp_employees WHERE id = %s", (account_id,))
        employee = cursor.fetchone()
        if not employee:
            raise ApiError(404, "That employee was not found.")
        code = employee["employee_code"]
        if not code:
            cursor.execute("SELECT employee_code FROM isp_employees WHERE employee_code IS NOT NULL")
            code = new_code("EM-", {row["employee_code"] for row in cursor.fetchall()})
        cursor.execute(
            "UPDATE isp_employees SET status = 'approved', employee_code = %s WHERE id = %s",
            (code, account_id),
        )
        cursor.execute("SELECT * FROM isp_employees WHERE id = %s", (account_id,))
        return public_employee(cursor.fetchone())

    def allocate_role(self, cursor, account_id, role):
        if role not in ROLES:
            raise ApiError(400, "Choose a valid role.")
        cursor.execute("SELECT status FROM isp_employees WHERE id = %s", (account_id,))
        employee = cursor.fetchone()
        if not employee:
            raise ApiError(404, "That employee was not found.")
        if employee["status"] != "approved":
            raise ApiError(400, "Approve the employee before allocating a role.")
        cursor.execute("UPDATE isp_employees SET role = %s WHERE id = %s", (role, account_id))
        cursor.execute("SELECT * FROM isp_employees WHERE id = %s", (account_id,))
        return public_employee(cursor.fetchone())

    def client_by_session(self, cursor, token):
        account_id = session_account_id(cursor, token, "client")
        if not account_id:
            return None
        cursor.execute("SELECT * FROM isp_clients WHERE id = %s", (account_id,))
        row = cursor.fetchone()
        return public_client(row) if row else None

    def employee_by_session(self, cursor, token):
        account_id = session_account_id(cursor, token, "employee")
        if not account_id:
            return None
        cursor.execute("SELECT * FROM isp_employees WHERE id = %s", (account_id,))
        row = cursor.fetchone()
        return public_employee(row) if row else None

    def clear_session(self, cursor, token, kind):
        if token:
            cursor.execute("DELETE FROM isp_sessions WHERE token = %s AND account_kind = %s", (token, kind))

    def require_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before onboarding a router.")
        if not approved_account(cursor, "isp_clients", client_id):
            raise ApiError(403, "That account is still waiting for approval.")
        return client_id

    def health(self, cursor):
        cursor.execute("SELECT 1 AS ok")
        cursor.fetchone()
        import wg_host

        radius = {f"udp/{port}": state for port, state in sorted(radius_server.STATUS.items())}
        if not radius:
            radius = {"state": "starting"}
        if wg_host.local_server():
            wireguard = "running" if wg_host.tunnel_running_cached() else "stopped"
        else:
            wireguard = "external" if os.environ.get("ISP_WG_PUBLIC_KEY", "").strip() else "pending"
        return {
            "database": "ok",
            "queue": "database",
            "workers": "in-process",
            "routerLink": "not-configured",
            "redis": "not-configured",
            "celery": "not-configured",
            "components": {
                "radius": radius,
                "portal": portal_server.STATUS.get("portal", "pending"),
                "wireguard": wireguard,
                "web": "serving" if web_root() else "not-built",
            },
        }

    def dashboard_summary(self, cursor, token):
        client_id = self.require_client(cursor, token)
        cursor.execute(
            """
            SELECT
              COUNT(*) AS total,
              SUM(status = 'active') AS active_count,
              SUM(status = 'waiting') AS waiting_count,
              SUM(status = 'identity') AS identity_count,
              SUM(tunnel_status = 'up') AS tunnel_up,
              SUM(tunnel_status = 'down') AS tunnel_down,
              SUM(tunnel_status = 'unknown') AS tunnel_unknown
            FROM isp_mikrotik_devices
            WHERE client_id = %s
            """,
            (client_id,),
        )
        row = cursor.fetchone()
        total = int(row["total"] or 0)
        online = int(row["tunnel_up"] or 0)
        offline = int(row["tunnel_down"] or 0) + int(row["tunnel_unknown"] or 0)
        cursor.execute(
            """
            SELECT COUNT(*) AS unhealthy
            FROM (
                SELECT device_id FROM isp_mikrotik_health_events
                WHERE client_id = %s AND ended_at IS NULL
                UNION
                SELECT id FROM isp_mikrotik_devices
                WHERE client_id = %s AND tunnel_status = 'down'
            ) flagged
            """,
            (client_id, client_id),
        )
        unhealthy = int(cursor.fetchone()["unhealthy"] or 0)
        cursor.execute(
            """
            SELECT s.service, s.status, sub.expiry_date, d.tunnel_status,
                   (SELECT COUNT(*) FROM radacct a
                    WHERE a.username = s.pppoe_username AND a.acctstoptime IS NULL) AS open_sessions,
                   (SELECT COUNT(*) FROM radacct a
                    WHERE a.username = s.pppoe_username) AS any_sessions,
                   (SELECT e.action FROM pppoe_events e
                    WHERE e.subscriber_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS last_action
            FROM pppoe_subscribers s
            LEFT JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
            LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
            WHERE s.client_id = %s AND s.deleted = 0 AND s.service = 'pppoe'
            """,
            (client_id,),
        )
        clients = []
        for item in cursor.fetchall():
            clients.append(
                {
                    "service": item["service"],
                    "status": item["status"],
                    "expiry_date": pppoe_store.as_day(item["expiry_date"]),
                    "open_sessions": item["open_sessions"],
                    "any_sessions": item["any_sessions"],
                    "last_action": item["last_action"] or "",
                    "tunnel_status": item["tunnel_status"] or "unknown",
                }
            )
        now = datetime.now()
        client_analysis = pppoe_service.tally_client_analysis(clients, now.date())
        cursor.execute(
            """
            SELECT h.status,
                   (SELECT COUNT(*) FROM hotspot_vouchers v
                    WHERE v.purchase_id = h.id AND v.status = 'used') AS used_vouchers,
                   (SELECT MAX(TIMESTAMPADD(SECOND, v.seconds, v.used_at)) FROM hotspot_vouchers v
                    WHERE v.purchase_id = h.id AND v.status = 'used' AND v.used_at IS NOT NULL) AS surf_until
            FROM hotspot_purchases h
            WHERE h.client_id = %s AND h.deleted = 0
            """,
            (client_id,),
        )
        client_analysis["hotspot"] = pppoe_service.tally_hotspot_analysis(cursor.fetchall(), now)
        # radacct usernames that belong to hotspot guests — the paying device
        # surfs under h.username and each redeemed voucher under v.username.
        hotspot_ids = """
            SELECT h.client_id, h.device_id, v.username
            FROM hotspot_vouchers v
            JOIN hotspot_purchases h ON h.id = v.purchase_id
            WHERE h.deleted = 0
            UNION ALL
            SELECT h.client_id, h.device_id, h.username
            FROM hotspot_purchases h
            WHERE h.deleted = 0 AND h.username IS NOT NULL AND h.username <> ''
        """
        cursor.execute(
            """
            SELECT COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
                   COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
            FROM pppoe_subscribers s
            LEFT JOIN radacct a ON a.username = s.pppoe_username AND a.acctstarttime >= CURDATE()
            WHERE s.client_id = %s AND s.deleted = 0 AND s.service = 'pppoe'
            """,
            (client_id,),
        )
        pppoe_today = cursor.fetchone()
        usage = {
            "pppoe": {"bytesIn": int(pppoe_today["bytes_in"] or 0), "bytesOut": int(pppoe_today["bytes_out"] or 0)},
            "hotspot": {"bytesIn": 0, "bytesOut": 0},
        }
        cursor.execute(
            f"""
            SELECT COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
                   COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
            FROM ({hotspot_ids}) ids
            JOIN radacct a ON a.username = ids.username AND a.acctstarttime >= CURDATE()
            WHERE ids.client_id = %s
            """,
            (client_id,),
        )
        hotspot_today = cursor.fetchone()
        usage["hotspot"]["bytesIn"] += int(hotspot_today["bytes_in"] or 0)
        usage["hotspot"]["bytesOut"] += int(hotspot_today["bytes_out"] or 0)
        cursor.execute(
            """
            SELECT d.id, d.name, d.site, d.tunnel_status,
                   COUNT(DISTINCT s.id) AS subscribers,
                   COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
                   COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
            FROM isp_mikrotik_devices d
            LEFT JOIN pppoe_subscribers s ON s.router_id = d.id AND s.client_id = d.client_id
                AND s.deleted = 0 AND s.service = 'pppoe'
            LEFT JOIN radacct a ON a.username = s.pppoe_username AND a.acctstarttime >= CURDATE()
            WHERE d.client_id = %s
            GROUP BY d.id, d.name, d.site, d.tunnel_status
            """,
            (client_id,),
        )
        usage_by_router = {}
        for item in cursor.fetchall():
            entry = usage_by_router.setdefault(
                item["id"],
                {
                    "id": item["id"],
                    "name": item["name"],
                    "site": item["site"] or "",
                    "tunnelStatus": item["tunnel_status"] or "unknown",
                    "subscribers": 0,
                    "openSessions": 0,
                    "hotspotGuests": 0,
                    "hotspotSessions": 0,
                    "pppoe": {"bytesIn": 0, "bytesOut": 0},
                    "hotspot": {"bytesIn": 0, "bytesOut": 0},
                },
            )
            entry["subscribers"] = int(item["subscribers"] or 0)
            entry["pppoe"] = {"bytesIn": int(item["bytes_in"] or 0), "bytesOut": int(item["bytes_out"] or 0)}
        cursor.execute(
            """
            SELECT s.router_id, COUNT(*) AS open_sessions
            FROM pppoe_subscribers s
            JOIN radacct a ON a.username = s.pppoe_username AND a.acctstoptime IS NULL
            WHERE s.client_id = %s AND s.deleted = 0 AND s.service = 'pppoe'
            GROUP BY s.router_id
            """,
            (client_id,),
        )
        for item in cursor.fetchall():
            entry = usage_by_router.get(item["router_id"])
            if entry is not None:
                entry["openSessions"] = int(item["open_sessions"] or 0)
        cursor.execute(
            f"""
            SELECT ids.device_id,
                   COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
                   COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
            FROM ({hotspot_ids}) ids
            JOIN radacct a ON a.username = ids.username AND a.acctstarttime >= CURDATE()
            WHERE ids.client_id = %s
            GROUP BY ids.device_id
            """,
            (client_id,),
        )
        for item in cursor.fetchall():
            entry = usage_by_router.get(item["device_id"])
            if entry is not None:
                entry["hotspot"]["bytesIn"] += int(item["bytes_in"] or 0)
                entry["hotspot"]["bytesOut"] += int(item["bytes_out"] or 0)
        cursor.execute(
            f"""
            SELECT ids.device_id, COUNT(*) AS open_sessions
            FROM ({hotspot_ids}) ids
            JOIN radacct a ON a.username = ids.username AND a.acctstoptime IS NULL
            WHERE ids.client_id = %s
            GROUP BY ids.device_id
            """,
            (client_id,),
        )
        for item in cursor.fetchall():
            entry = usage_by_router.get(item["device_id"])
            if entry is not None:
                entry["hotspotSessions"] = int(item["open_sessions"] or 0)
        cursor.execute(
            """
            SELECT h.device_id, COUNT(*) AS guests
            FROM hotspot_purchases h
            WHERE h.client_id = %s AND h.deleted = 0
            GROUP BY h.device_id
            """,
            (client_id,),
        )
        for item in cursor.fetchall():
            entry = usage_by_router.get(item["device_id"])
            if entry is not None:
                entry["hotspotGuests"] = int(item["guests"] or 0)
        routers_usage = list(usage_by_router.values())
        for entry in routers_usage:
            entry["bytesIn"] = entry["pppoe"]["bytesIn"] + entry["hotspot"]["bytesIn"]
            entry["bytesOut"] = entry["pppoe"]["bytesOut"] + entry["hotspot"]["bytesOut"]
        routers_usage.sort(key=lambda item: item["bytesIn"] + item["bytesOut"], reverse=True)
        return {
            "generatedAt": datetime.now().isoformat(sep=" ", timespec="seconds"),
            "source": "database",
            "routers": {
                "total": total,
                "active": int(row["active_count"] or 0),
                "waiting": int(row["waiting_count"] or 0),
                "identity": int(row["identity_count"] or 0),
                "tunnelUp": online,
                "tunnelDown": int(row["tunnel_down"] or 0),
                "tunnelUnknown": int(row["tunnel_unknown"] or 0),
                "online": online,
                "offline": offline,
                "healthy": max(0, total - unhealthy),
                "unhealthy": unhealthy,
            },
            "clients": client_analysis,
            "usageToday": usage,
            "usageByRouter": routers_usage,
        }

    def list_mikrotiks(self, cursor, token, query):
        client_id = self.require_client(cursor, token)
        try:
            limit = min(50, max(1, int(query.get("limit", ["20"])[0])))
            offset = max(0, int(query.get("offset", ["0"])[0]))
        except ValueError as error:
            raise ApiError(400, "Page size and offset must be numbers.") from error
        cursor.execute(
            "SELECT COUNT(*) AS total FROM isp_mikrotik_devices WHERE client_id = %s",
            (client_id,),
        )
        total = int(cursor.fetchone()["total"])
        cursor.execute(
            """
            SELECT id, name, site, role, routeros_version, status, tunnel_status, last_seen_at, last_api_at,
                   api_secret IS NOT NULL AS api_ready
            FROM isp_mikrotik_devices
            WHERE client_id = %s
            ORDER BY name
            LIMIT %s OFFSET %s
            """,
            (client_id, limit, offset),
        )
        devices = []
        for row in cursor.fetchall():
            devices.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "site": row["site"],
                    "role": row["role"],
                    "routerosVersion": row["routeros_version"] or "",
                    "status": row["status"],
                    "tunnelStatus": row["tunnel_status"] or "unknown",
                    "lastSeen": row["last_seen_at"].isoformat(sep=" ") if row["last_seen_at"] else None,
                    "lastApi": row["last_api_at"].isoformat(sep=" ") if row["last_api_at"] else None,
                    "apiReady": bool(row["api_ready"]),
                }
            )
        return {
            "devices": devices,
            "total": total,
            "limit": limit,
            "offset": offset,
            "generatedAt": datetime.now().isoformat(sep=" ", timespec="seconds"),
        }

    def enqueue_job(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        if not router_jobs.allow_job(client_id):
            raise ApiError(429, "Too many router checks were requested. Wait a moment and try again.")
        self.mikrotik_row(cursor, device_id, client_id)
        operation = str(payload.get("operation") or "discover").strip()
        try:
            job, _created = router_jobs.enqueue(cursor, client_id, device_id, operation)
        except router_jobs.JobError as error:
            raise ApiError(error.status, str(error)) from error
        return job

    def cancel_router_job(self, cursor, job_id, token):
        client_id = self.require_client(cursor, token)
        try:
            return router_jobs.cancel(cursor, client_id, job_id)
        except router_jobs.JobError as error:
            raise ApiError(error.status, str(error)) from error

    def read_wan(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        self.mikrotik_row(cursor, device_id, client_id)
        cursor.execute("SELECT mode FROM isp_wan_settings WHERE device_id = %s AND client_id = %s", (device_id, client_id))
        settings = cursor.fetchone()
        cursor.execute(
            """
            SELECT interface_name, provider, method, gateway, download_mbps, upload_mbps, active, account_number
            FROM isp_wan_uplinks
            WHERE device_id = %s AND client_id = %s
            ORDER BY interface_name
            """,
            (device_id, client_id),
        )
        uplinks = [
            {
                "interface": row["interface_name"],
                "provider": row["provider"],
                "method": row["method"],
                "gateway": row["gateway"],
                "downloadMbps": row["download_mbps"],
                "uploadMbps": row["upload_mbps"],
                "active": bool(row["active"]),
                "accountNumber": row["account_number"] or "",
                "eligible": True,
            }
            for row in cursor.fetchall()
        ]
        cursor.execute(
            """
            SELECT previous_uplink, requested_uplink, outcome, detail_text, created_at
            FROM isp_wan_audit
            WHERE device_id = %s AND client_id = %s
            ORDER BY created_at DESC
            LIMIT 8
            """,
            (device_id, client_id),
        )
        audit = []
        for row in cursor.fetchall():
            created = row["created_at"]
            audit.append(
                {
                    "previous": row["previous_uplink"],
                    "requested": row["requested_uplink"],
                    "outcome": row["outcome"],
                    "at": created.isoformat(sep=" ") if hasattr(created, "isoformat") else str(created),
                }
            )
        return {
            "mode": settings["mode"] if settings else "manual-single",
            "uplinks": uplinks,
            "audit": audit,
            "canOverride": self.client_may_override(cursor, token),
        }

    def save_wan(self, cursor, device_id, token, payload):
        import wan_switch

        client_id = self.require_client(cursor, token)
        self.mikrotik_row(cursor, device_id, client_id)
        try:
            mode = wan_switch.clean_mode(payload.get("mode"))
            uplinks = [wan_switch.clean_uplink(item) for item in payload.get("uplinks") or []]
        except wan_switch.SwitchError as error:
            raise ApiError(400, str(error)) from error
        names = [item["interface"] for item in uplinks]
        if len(names) != len(set(names)):
            raise ApiError(400, "Each uplink interface can be saved once.")
        active = [item for item in uplinks if item["active"]]
        if len(active) > 1:
            raise ApiError(400, "Only one uplink can be active.")
        connection = cursor.connection
        connection.autocommit(False)
        try:
            cursor.execute(
                """
                INSERT INTO isp_wan_settings (device_id, client_id, mode)
                VALUES (%s, %s, %s)
                ON DUPLICATE KEY UPDATE mode = VALUES(mode)
                """,
                (device_id, client_id, mode),
            )
            cursor.execute("DELETE FROM isp_wan_uplinks WHERE device_id = %s AND client_id = %s", (device_id, client_id))
            for item in uplinks:
                cursor.execute(
                    """
                    INSERT INTO isp_wan_uplinks (
                      id, client_id, device_id, interface_name, provider, method, gateway,
                      download_mbps, upload_mbps, active, account_number
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(uuid.uuid4()),
                        client_id,
                        device_id,
                        item["interface"],
                        item["provider"],
                        item["method"],
                        item["gateway"],
                        item["downloadMbps"],
                        item["uploadMbps"],
                        1 if item["active"] else 0,
                        item["accountNumber"],
                    ),
                )
            saved = self.read_wan(cursor, device_id, token)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.autocommit(True)
        return saved

    def request_wan_switch(self, cursor, device_id, token, payload):
        import wan_switch

        client_id = self.require_client(cursor, token)
        if not router_jobs.allow_job(client_id):
            raise ApiError(429, "Too many router checks were requested. Wait a moment and try again.")
        device = self.mikrotik_row(cursor, device_id, client_id)
        saved = self.read_wan(cursor, device_id, token)
        if saved["mode"] != "manual-single":
            raise ApiError(400, "Manual switching is available only in Manual Single-Uplink mode.")
        health = self._uplink_health(cursor, device_id, token, [item["interface"] for item in saved["uplinks"]])
        uplinks = []
        for item in saved["uplinks"]:
            item = dict(item)
            item["health"] = health.get(item["interface"], "unknown")
            uplinks.append(item)
        target_name = str(payload.get("interface") or "")
        known = next((item for item in uplinks if item["interface"] == target_name), None)
        if known and known["health"] != "healthy" and bool(payload.get("override")) and not saved["canOverride"]:
            raise ApiError(403, "A director, supervisor, or IT support session must confirm an uplink that is not healthy.")
        try:
            plan = wan_switch.prepare_switch(
                uplinks,
                str(payload.get("interface") or ""),
                saved["mode"],
                bool(payload.get("confirm")),
                bool(payload.get("override")),
                device.get("routerosVersion"),
            )
        except wan_switch.SwitchError as error:
            raise ApiError(400, str(error)) from error
        if not plan["allowed"]:
            raise ApiError(400, plan["reason"])
        request = wan_switch.public_request(
            {
                "interface": payload.get("interface"),
                "confirm": bool(payload.get("confirm")),
                "override": bool(payload.get("override")),
                "mode": saved["mode"],
                "uplinks": uplinks,
                "routerosVersion": device.get("routerosVersion"),
            }
        )
        try:
            job, created = router_jobs.enqueue(cursor, client_id, device_id, "switch-uplink", request)
        except router_jobs.JobError as error:
            raise ApiError(error.status, str(error)) from error
        if not created:
            job["reused"] = True
        return job

    def record_wan_active(self, cursor, device_id, token, payload):
        import wan_switch

        client_id = self.require_client(cursor, token)
        device = self.mikrotik_row(cursor, device_id, client_id)
        saved = self.read_wan(cursor, device_id, token)
        try:
            recorded = wan_switch.record_current(
                saved["uplinks"],
                str(payload.get("interface") or ""),
                saved["mode"],
                bool(payload.get("confirm")),
            )
        except wan_switch.SwitchError as error:
            raise ApiError(400, str(error)) from error
        cursor.execute(
            "UPDATE isp_wan_uplinks SET active = CASE WHEN interface_name = %s THEN 1 ELSE 0 END WHERE client_id = %s AND device_id = %s",
            (recorded["target"], client_id, device_id),
        )
        cursor.execute(
            """
            INSERT INTO isp_wan_audit (
              id, client_id, device_id, job_id, previous_uplink, requested_uplink, outcome, detail_text
            ) VALUES (%s, %s, %s, NULL, %s, %s, 'recorded', %s)
            """,
            (
                str(uuid.uuid4()),
                client_id,
                device_id,
                recorded["source"][:32],
                recorded["target"][:32],
                json.dumps({"routerosVersion": device.get("routerosVersion"), "moved": False}),
            ),
        )
        return self.read_wan(cursor, device_id, token)

    def wan_reachability(self, cursor, device_id, token):
        saved = self.read_wan(cursor, device_id, token)
        if not rate_ok(("router-read", device_id), *RATE_RULES["router-read"]):
            raise ApiError(429, "That router is being polled too quickly. Wait a moment.")
        names = [item["interface"] for item in saved["uplinks"]]
        return self._uplink_health(cursor, device_id, token, names)

    def client_may_override(self, cursor, token):
        import wan_switch

        cursor.execute(
            "SELECT opened_by FROM isp_sessions WHERE token = %s AND account_kind = 'client'",
            (token,),
        )
        session = cursor.fetchone()
        role = ""
        opened_by = session.get("opened_by") if session else None
        if opened_by:
            cursor.execute("SELECT role, status FROM isp_employees WHERE id = %s", (opened_by,))
            employee = cursor.fetchone()
            if employee and employee["status"] == "approved":
                role = employee["role"] or ""
        cursor.execute(
            """
            SELECT COUNT(*) AS total
            FROM isp_employees
            WHERE status = 'approved' AND role IN ('director', 'supervisor', 'it-support')
            """
        )
        staff_ready = int(cursor.fetchone()["total"]) > 0
        return wan_switch.override_allowed(role, staff_ready)

    def _uplink_health(self, cursor, device_id, token, names):
        client_id = self.require_client(cursor, token)
        unique = []
        for name in names:
            if name and name not in unique:
                unique.append(name)
        unknown = {name: "unknown" for name in unique}
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not unique:
            return unknown
        try:
            password = routeros_api.open_password(row["api_secret"])
            return routeros_api.probe_wan(row["tunnel_ip"], password, unique)
        except routeros_api.RouterError as error:
            if str(error) == "The management tunnel did not answer.":
                cursor.execute(
                    "UPDATE isp_mikrotik_devices SET tunnel_status = 'down' WHERE id = %s AND client_id = %s",
                    (device_id, client_id),
                )
                self.sync_router_health(
                    cursor,
                    client_id,
                    device_id,
                    [("Management tunnel", "The management tunnel did not answer.")],
                )
            return unknown

    def read_job(self, cursor, job_id, token):
        client_id = self.require_client(cursor, token)
        try:
            return router_jobs.read_job(cursor, client_id, job_id)
        except router_jobs.JobError as error:
            raise ApiError(error.status, str(error)) from error

    def create_mikrotik(self, cursor, payload, token):
        client_id = self.require_client(cursor, token)
        name = str(payload.get("name", "")).strip()
        site = str(payload.get("site", "")).strip()
        role_input = payload.get("role", "")
        if isinstance(role_input, list):
            requested = [str(item).strip() for item in role_input]
        else:
            requested = [item.strip() for item in str(role_input).split(",")]
        allowed = ["hotspot", "pppoe", "static", "dhcp", "edge", "core", "site", "concentrator"]
        chosen = []
        for item in requested:
            if not item or item in chosen:
                continue
            if item not in allowed:
                raise ApiError(400, "Choose how customers connect.")
            chosen.append(item)
        if not chosen:
            raise ApiError(400, "Choose how customers connect.")
        role = ",".join(item for item in allowed if item in chosen)
        if len(role) > 40:
            raise ApiError(400, "Choose fewer connection methods.")
        version = str(payload.get("routerosVersion", "")).strip()
        if not name or len(name) > 80 or not site or len(site) > 80 or any(ord(character) < 32 for character in name + site):
            raise ApiError(400, "Enter a device name and site.")
        if version not in {"", "7", "6"}:
            raise ApiError(400, "Choose a known RouterOS version or leave it blank.")
        cursor.execute(
            "SELECT * FROM isp_mikrotik_devices WHERE client_id = %s AND name = %s",
            (client_id, name),
        )
        existing = cursor.fetchone()
        if existing:
            return self.reissue_mikrotik(cursor, existing, site, role)
        private_key, public_key = wireguard_keypair()
        tunnel_ip = next_tunnel_ip(cursor)
        cursor.execute("SELECT id FROM isp_mikrotik_devices WHERE public_key = %s", (public_key,))
        if cursor.fetchone():
            raise ApiError(409, "That device key is already registered to another router.")
        device_id = str(uuid.uuid4())
        cursor.execute(
            """
            INSERT INTO isp_mikrotik_devices (
              id, client_id, name, site, role, routeros_version, tunnel_ip, public_key, status
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'identity')
            """,
            (device_id, client_id, name, site, role, version or None, tunnel_ip, public_key),
        )
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET wg_private = %s WHERE id = %s",
            (routeros_api.seal_password(private_key), device_id),
        )
        publish_tunnel_peers(cursor)
        notify_push_now()
        device = self.mikrotik_row(cursor, device_id, client_id)
        device["privateKey"] = private_key
        return device

    def reissue_mikrotik(self, cursor, existing, site, role):
        private_key = stored_router_key(existing.get("wg_private"))
        if not private_key:
            private_key, public_key = wireguard_keypair()
            cursor.execute(
                """
                UPDATE isp_mikrotik_devices
                SET site = %s, role = %s, public_key = %s, wg_private = %s
                WHERE id = %s
                """,
                (site, role, public_key, routeros_api.seal_password(private_key), existing["id"]),
            )
        else:
            cursor.execute(
                "UPDATE isp_mikrotik_devices SET site = %s, role = %s WHERE id = %s",
                (site, role, existing["id"]),
            )
        publish_tunnel_peers(cursor)
        device = self.mikrotik_row(cursor, existing["id"], existing["client_id"])
        device["privateKey"] = private_key
        return device

    def read_mikrotik(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        self.observe_tunnel(cursor, device_id, client_id)
        return self.mikrotik_row(cursor, device_id, client_id)

    def delete_mikrotik(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        router = self.mikrotik_row(cursor, device_id, client_id)
        pppoe_store.disconnect_router_clients(
            cursor, client_id, device_id, client_id, f"Router {router['name']} was deleted."
        )
        cursor.execute("SELECT nasname FROM isp_radius_nas WHERE router_id = %s", (device_id,))
        nas = cursor.fetchone()
        if nas and nas.get("nasname"):
            cursor.execute("DELETE FROM nas WHERE nasname = %s AND description = %s", (nas["nasname"], device_id))
        cursor.execute("DELETE FROM isp_radius_nas WHERE router_id = %s", (device_id,))
        radius_server.nas_cache_clear()
        cursor.execute(
            "DELETE FROM isp_mikrotik_health_events WHERE device_id = %s AND client_id = %s",
            (device_id, client_id),
        )
        cursor.execute("DELETE FROM isp_wan_uplinks WHERE device_id = %s AND client_id = %s", (device_id, client_id))
        cursor.execute("DELETE FROM isp_wan_audit WHERE device_id = %s AND client_id = %s", (device_id, client_id))
        cursor.execute("DELETE FROM isp_wan_settings WHERE device_id = %s AND client_id = %s", (device_id, client_id))
        cursor.execute("DELETE FROM isp_router_jobs WHERE device_id = %s AND client_id = %s", (device_id, client_id))
        cursor.execute(
            "SELECT id, availability_routers FROM isp_packages WHERE client_id = %s",
            (client_id,),
        )
        for package in cursor.fetchall():
            routers = load_offer_names(package.get("availability_routers"))
            if device_id not in routers:
                continue
            remaining = [item for item in routers if item != device_id]
            cursor.execute(
                "UPDATE isp_packages SET availability_routers = %s WHERE id = %s AND client_id = %s",
                (json.dumps(remaining) if remaining else None, package["id"], client_id),
            )
        cursor.execute(
            "DELETE FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        publish_tunnel_peers(cursor)
        return {"ok": True}

    def set_mikrotik_suspended(self, cursor, device_id, token, suspended):
        client_id = self.require_client(cursor, token)
        current = self.mikrotik_row(cursor, device_id, client_id)
        if suspended:
            if current["status"] == "suspended":
                return current
            cursor.execute(
                "UPDATE isp_mikrotik_devices SET status = 'suspended' WHERE id = %s AND client_id = %s",
                (device_id, client_id),
            )
        else:
            if current["status"] != "suspended":
                raise ApiError(400, "That router is not suspended.")
            cursor.execute(
                "UPDATE isp_mikrotik_devices SET status = 'active' WHERE id = %s AND client_id = %s",
                (device_id, client_id),
            )
        return self.mikrotik_row(cursor, device_id, client_id)

    def observe_tunnel(self, cursor, device_id, client_id):
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            return
        try:
            password = routeros_api.open_password(row["api_secret"])
            live = routeros_api.read_router(row["tunnel_ip"], password, timeout=2)
        except routeros_api.RouterError:
            return
        version = (live.get("version") or "")[:20] or None
        cursor.execute(
            """
            UPDATE isp_mikrotik_devices
            SET status = IF(status = 'suspended', status, 'active'), tunnel_status = 'up', last_seen_at = CURRENT_TIMESTAMP,
                last_api_at = CURRENT_TIMESTAMP, routeros_version = COALESCE(%s, routeros_version)
            WHERE id = %s AND client_id = %s
            """,
            (version, device_id, client_id),
        )
        cursor.execute(
            "UPDATE isp_mikrotik_health_events SET ended_at = CURRENT_TIMESTAMP WHERE client_id = %s AND device_id = %s AND subject = 'Management tunnel' AND ended_at IS NULL",
            (client_id, device_id),
        )

    def mark_mikrotik_waiting(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        current = self.mikrotik_row(cursor, device_id, client_id)
        if current["status"] == "active":
            return current
        backup_reference = str(payload.get("backupReference", "")).strip()
        if len(backup_reference) < 4 or len(backup_reference) > 160:
            raise ApiError(400, "Record where the recoverable backup copy is kept before changing the router.")
        if payload.get("previewAccepted") is not True:
            raise ApiError(400, "Preview the change and confirm it before it can be applied.")
        if payload.get("recoveryConfirmed") is not True:
            raise ApiError(400, "Confirm the backup copy can be restored before changing the router.")
        if payload.get("authorized") is not True:
            raise ApiError(400, "This change needs explicit authorization before it can be applied.")
        api_password = str(payload.get("apiPassword", "")).strip()
        sealed = self.seal_router_password(api_password) if api_password else None
        if sealed:
            cursor.execute(
                """
                UPDATE isp_mikrotik_devices
                SET status = 'waiting', backup_reference = %s, api_secret = %s,
                    authorized_at = CURRENT_TIMESTAMP, recovery_confirmed_at = CURRENT_TIMESTAMP
                WHERE id = %s AND client_id = %s
                """,
                (backup_reference, sealed, device_id, client_id),
            )
        else:
            cursor.execute(
                """
                UPDATE isp_mikrotik_devices
                SET status = 'waiting', backup_reference = %s, authorized_at = CURRENT_TIMESTAMP, recovery_confirmed_at = CURRENT_TIMESTAMP
                WHERE id = %s AND client_id = %s
                """,
                (backup_reference, device_id, client_id),
            )
        return self.mikrotik_row(cursor, device_id, client_id)

    def record_stage_test(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        current = self.mikrotik_row(cursor, device_id, client_id)
        if current["status"] == "identity":
            raise ApiError(400, "Apply the previewed change before recording a stage test.")
        if payload.get("localManagement") is not True:
            raise ApiError(400, "Confirm local management still connects after the change.")
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET stage_tested_at = CURRENT_TIMESTAMP WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        return self.mikrotik_row(cursor, device_id, client_id)

    def save_pppoe_enforcement(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        current = self.mikrotik_row(cursor, device_id, client_id)
        enforced = payload.get("enforced")
        if not isinstance(enforced, bool):
            raise ApiError(400, "Choose whether PPPoE enforcement is on or off.")
        previous = 1 if current.get("pppoeEnforced") else 0
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET pppoe_enforced = %s WHERE id = %s AND client_id = %s",
            (1 if enforced else 0, device_id, client_id),
        )
        device = self.mikrotik_row(cursor, device_id, client_id)
        if payload.get("push") is not True:
            return {"device": device, "applied": False, "message": ""}
        try:
            self.push_pppoe_enforcement(cursor, device_id, client_id, enforced)
        except routeros_api.RouterError as error:
            cursor.execute(
                "UPDATE isp_mikrotik_devices SET pppoe_enforced = %s WHERE id = %s AND client_id = %s",
                (previous, device_id, client_id),
            )
            return {
                "device": self.mikrotik_row(cursor, device_id, client_id),
                "applied": False,
                "message": routeros_api.router_change_message(error),
            }
        return {"device": device, "applied": True, "message": "Updated on the router."}

    def push_pppoe_enforcement(self, cursor, device_id, client_id, enforced):
        cursor.execute(
            "SELECT tunnel_ip, api_secret, pppoe_interface, port_plan FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            raise routeros_api.RouterError("Router access is not saved yet, so nothing was changed on the router.")
        password = routeros_api.open_password(row["api_secret"])
        plan = self.read_port_plan(row)
        access = (row.get("pppoe_interface") or "") or next(
            (name for name, uses in plan.items() if "pppoe" in uses), ""
        )
        radius = None
        if enforced:
            pppoe_store.sync_router_access(cursor, client_id, device_id)
            cursor.execute(
                "SELECT id, name, tunnel_ip FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
                (device_id, client_id),
            )
            router = cursor.fetchone()
            pppoe_store.ensure_nas(cursor, router)
            cursor.execute("SELECT secret_sealed FROM isp_radius_nas WHERE router_id = %s", (device_id,))
            nas = cursor.fetchone()
            secret = routeros_api.open_password(nas["secret_sealed"]) if nas and nas.get("secret_sealed") else ""
            radius = {
                "address": os.environ.get("ISP_RADIUS_HOST", "10.88.0.1"),
                "secret": secret,
                "source": row["tunnel_ip"],
            }
        routeros_api.apply_pppoe_enforcement(row["tunnel_ip"], password, enforced, radius=radius, access=access or None)

    def save_port_uses(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        current = self.mikrotik_row(cursor, device_id, client_id)
        plan = self.clean_port_plan(payload)
        if plan is None or not any(plan.values()):
            raise ApiError(400, "Choose what at least one port will do.")
        try:
            self.push_port_uses(cursor, device_id, client_id, plan)
        except routeros_api.RouterError as error:
            return {"applied": False, "message": routeros_api.router_change_message(error), "portPlan": current.get("portPlan") or {}}
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET port_plan = %s WHERE id = %s AND client_id = %s",
            (json.dumps(plan), device_id, client_id),
        )
        return {"applied": True, "message": "Updated on the router.", "portPlan": plan}

    def push_port_uses(self, cursor, device_id, client_id, plan):
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            raise routeros_api.RouterError("Router access is not saved yet, so nothing was changed on the router.")
        password = routeros_api.open_password(row["api_secret"])
        routeros_api.apply_port_uses(row["tunnel_ip"], password, plan)

    def save_hotspot_access(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        current = self.mikrotik_row(cursor, device_id, client_id)
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            raise ApiError(400, "Choose whether the hotspot is on or off.")
        previous = 1 if current.get("hotspotEnabled") else 0
        previous_block = 1 if current.get("hotspotBlockSharing") else 0
        block = payload.get("blockSharing", bool(previous_block))
        if not isinstance(block, bool):
            raise ApiError(400, "Choose whether sharing is blocked.")
        cursor.execute(
            """
            UPDATE isp_mikrotik_devices SET hotspot_enabled = %s, hotspot_block_sharing = %s
            WHERE id = %s AND client_id = %s
            """,
            (1 if enabled else 0, 1 if block else 0, device_id, client_id),
        )
        device = self.mikrotik_row(cursor, device_id, client_id)
        if payload.get("push") is not True:
            return {"device": device, "applied": False, "message": ""}
        # Only the sharing switch moved on a live hotspot: change just that
        # rule instead of re-running the whole hotspot setup.
        sharing_only = enabled and previous and block != bool(previous_block)
        try:
            report = self.push_hotspot_access(cursor, device_id, client_id, enabled, block, sharing_only)
        except routeros_api.RouterError as error:
            cursor.execute(
                """
                UPDATE isp_mikrotik_devices SET hotspot_enabled = %s, hotspot_block_sharing = %s
                WHERE id = %s AND client_id = %s
                """,
                (previous, previous_block, device_id, client_id),
            )
            return {
                "device": self.mikrotik_row(cursor, device_id, client_id),
                "applied": False,
                "message": routeros_api.router_change_message(error),
            }
        return {"device": device, "applied": True, "message": (report or {}).get("message") or "Updated on the router."}

    def push_hotspot_access(self, cursor, device_id, client_id, enabled, block_sharing=None, sharing_only=False):
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            raise routeros_api.RouterError("Router access is not saved yet, so nothing was changed on the router.")
        password = routeros_api.open_password(row["api_secret"])
        if sharing_only:
            return routeros_api.apply_hotspot_sharing(row["tunnel_ip"], password, bool(block_sharing))
        return routeros_api.apply_hotspot_access(row["tunnel_ip"], password, enabled, block_sharing=block_sharing)

    def hotspot_page_previews(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        cursor.execute(
            "SELECT name, site FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        found = cursor.fetchone() or {}
        device = {
            "id": device_id,
            "name": found.get("name") or "Corner Shop Wi-Fi",
            "site": found.get("site") or "Town centre",
        }
        # Match the live /hotspot page, which sells the client's own packages
        # (isp_packages); the company catalog only stands in when none exist.
        offers = portal_server.hotspot_packages(cursor, client_id, device_id) or portal_server.company_hotspot_packages(
            cursor, client_id, device_id
        )
        payment = portal_server.daraja_settings(cursor, client_id) or PORTAL_PREVIEW_PAYMENT
        first = offers[0] if offers else {}
        ctx = {
            "ip": HOTSPOT_PREVIEW_TOKENS["ip"],
            "mac": HOTSPOT_PREVIEW_TOKENS["mac"],
            "login": HOTSPOT_PREVIEW_TOKENS["link-login-only"],
            "orig": HOTSPOT_PREVIEW_TOKENS["link-orig"],
        }
        receipt = {
            "package_name": first.get("name") or "Wi-Fi bundle",
            "amount": str(first.get("price") or "100.00"),
            "vouchers": [
                {"code": "K7F2-9XPL-4QWD", "status": "issued"},
                {"code": "M3TB-8RHZ-6CJV", "status": "issued"},
            ],
        }
        pages = [
            (
                "login",
                "login.html",
                "Sign-in page",
                "The first screen a guest sees after joining the Wi-Fi. It forwards them to the payment page.",
                portal_server.router_page("login.html"),
            ),
            (
                "buy",
                "/hotspot",
                "Bundle page",
                "Guests pick a Wi-Fi bundle, pay with M-Pesa, or enter a voucher code.",
                portal_server.hotspot_page(device, offers, ctx, payment),
            ),
            (
                "thank-you",
                "/thank-you",
                "Connected / thank-you page",
                "Shown once the guest is online after a payment or voucher — it confirms the connection and lists the voucher code for each paid device slot.",
                portal_server.thankyou_hotspot_page(receipt),
            ),
            (
                "error",
                "error.html",
                "Error page",
                "The router shows this when a sign-in or session fails.",
                portal_server.router_page("error.html"),
            ),
        ]
        sig = portal_server.hotspot_signature(offers, payment)
        images = {str(offer["id"]): str(offer.get("image_data_url") or "") for offer in offers}
        return [
            {
                "id": slug,
                "name": name,
                "title": title,
                "description": description,
                "html": portal_preview_html(body, sig, slug == "buy", images),
            }
            for slug, name, title, description, body in pages
            if body
        ]

    def pppoe_page_previews(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        support_phone = self.preview_support_phone(cursor, client_id)
        # Match the live pay page, which offers the client's own packages
        # (isp_packages); the company catalog only stands in when none exist.
        live_offers = portal_server.pppoe_packages(cursor, client_id, device_id)
        catalog = portal_server.company_pppoe_packages(cursor, client_id, device_id)
        source = live_offers or catalog
        payment = portal_server.daraja_settings(cursor, client_id) or PORTAL_PREVIEW_PAYMENT
        first = source[0] if source else {}
        subscriber = {
            "client_id": client_id,
            "router_id": device_id,
            "package_id": first.get("id") or "sample-package",
            "package_name": first.get("name") or "Home 10 Mbps",
            "price": first.get("price") or "500.00",
            "download_mbps": first.get("download_mbps") or 10,
            "upload_mbps": first.get("upload_mbps") or 10,
            "package_devices": first.get("simultaneous_devices"),
            "cycle_days": 30,
            "first_name": "Amina",
            "last_name": "Wanjiku",
            "phone": "0712 345 678",
            "pppoe_username": "amina.wanjiku",
        }
        offers = source or portal_server.pppoe_offers(cursor, subscriber)
        voucher = {
            "first_name": subscriber["first_name"],
            "last_name": subscriber["last_name"],
            "status": "issued",
            "code": "K7F2-9XPL-4QWD",
            "package_name": subscriber["package_name"],
            "amount": str(subscriber["price"] or "0"),
            "pppoe_username": subscriber["pppoe_username"],
        }
        pages = [
            (
                "pay",
                "/",
                "Recharge page",
                "What a blocked customer sees — they pick a package and pay with M-Pesa to get back online.",
                portal_server.pay_page(subscriber, offers, payment),
            ),
            (
                "paused",
                "/",
                "Paused page",
                "Shown instead of the recharge page while the account is paused by the provider.",
                portal_server.paused_page(subscriber),
            ),
            (
                "unknown",
                "/",
                "No subscription page",
                "Shown when a session cannot be matched to an account.",
                portal_server.unknown_page(),
            ),
            (
                "help",
                "/help",
                "Help page",
                "The page a customer lands on when a payment fails or the link has not come back yet — it lists your customer care number.",
                portal_server.help_page(support_phone),
            ),
            (
                "thank-you",
                "/thank-you",
                "Thank-you page",
                "Shown after a payment lands — it lists the single-use voucher receipt.",
                portal_server.thankyou_page(voucher),
            ),
            (
                "error",
                "error.html",
                "Error page",
                "Shown when the M-Pesa prompt is declined or the payment cannot complete.",
                portal_server.router_page("error.html"),
            ),
        ]
        sig = portal_server.pay_signature(subscriber, offers, payment)
        images = {str(offer["id"]): str(offer.get("image_data_url") or "") for offer in offers}
        return [
            {
                "id": slug,
                "name": name,
                "title": title,
                "description": description,
                "html": portal_preview_html(body, sig, slug == "pay", images),
            }
            for slug, name, title, description, body in pages
            if body
        ]

    def preview_thank_you(self, cursor, token, query):
        """Receipt page the interactive preview lands on after a simulated payment."""
        client_id = self.require_client(cursor, token)
        purchase = str((query.get("purchase") or [""])[0])
        code = str((query.get("code") or [""])[0])
        if purchase:
            receipt = portal_server.hotspot_receipt(cursor, purchase, client_id) or {
                "package_name": "Wi-Fi bundle",
                "amount": "100.00",
                "vouchers": [
                    {"code": "K7F2-9XPL-4QWD", "status": "used"},
                    {"code": "M3TB-8RHZ-6CJV", "status": "issued"},
                ],
            }
            return PreviewPage(portal_server.thankyou_hotspot_page(receipt).decode("utf-8"))
        voucher = (pppoe_store.voucher_detail(cursor, code, client_id) if code else None) or {
            "first_name": "Amina",
            "last_name": "Wanjiku",
            "status": "issued",
            "code": code or "K7F2-9XPL-4QWD",
            "package_name": "Home 10 Mbps",
            "amount": "500.00",
            "pppoe_username": "amina.wanjiku",
        }
        return PreviewPage(portal_server.thankyou_page(voucher).decode("utf-8"))

    def preview_support_phone(self, cursor, client_id):
        """The customer care line shown on preview help pages — the company
        phone when one is saved, otherwise the account phone."""
        cursor.execute(
            "SELECT phone FROM isp_company_settings WHERE client_id = %s",
            (client_id,),
        )
        phone = str((cursor.fetchone() or {}).get("phone") or "").strip()
        if not phone:
            cursor.execute("SELECT phone FROM isp_clients WHERE id = %s", (client_id,))
            phone = str((cursor.fetchone() or {}).get("phone") or "").strip()
        return phone

    def reboot_mikrotik(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        if not router_jobs.allow_job(client_id):
            raise ApiError(429, "Too many router checks were requested. Wait a moment and try again.")
        self.mikrotik_row(cursor, device_id, client_id)
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            raise ApiError(400, "Router access is not saved yet, so the router cannot be restarted.")
        password = None
        try:
            password = routeros_api.open_password(row["api_secret"])
            routeros_api.reboot_router(row["tunnel_ip"], password)
        except routeros_api.RouterError as error:
            message = str(error)
            if message == "The management tunnel did not answer.":
                if os.environ.get("ISP_ENV", "development") != "production" and password == routeros_api.DEV_PASSWORD:
                    return {"rebooting": True, "message": "Development mode: no router is connected, so nothing was restarted."}
                raise ApiError(502, "The router did not answer, so it was not restarted.")
            raise ApiError(502, routeros_api.router_change_message(error))
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET tunnel_status = 'down' WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        return {"rebooting": True, "message": "The router is restarting. It will answer again in a minute or two."}

    def apply_selection(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        if not router_jobs.allow_job(client_id):
            raise ApiError(429, "Too many router checks were requested. Wait a moment and try again.")
        self.mikrotik_row(cursor, device_id, client_id)
        source = str(payload.get("script") or "")
        if not routeros_api.script_is_allowed(source):
            raise ApiError(400, "That choice cannot be applied.")
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            plan = self.remember_port_plan(cursor, device_id, client_id, payload)
            return {"applied": False, "message": "Router access is not saved yet, so nothing was changed on the router.", "portPlan": plan}
        try:
            password = routeros_api.open_password(row["api_secret"])
            result = routeros_api.run_script(row["tunnel_ip"], password, source)
        except routeros_api.RouterError as error:
            message = str(error)
            if message == "The management tunnel did not answer.":
                message = "The router did not answer. This choice is saved here and was not changed on the router."
            plan = self.remember_port_plan(cursor, device_id, client_id, payload)
            return {"applied": False, "message": message, "portPlan": plan}
        plan = self.remember_port_plan(cursor, device_id, client_id, payload)
        if plan is not None:
            result["portPlan"] = plan
        return result

    def remember_port_plan(self, cursor, device_id, client_id, payload):
        plan = self.clean_port_plan(payload)
        if plan is None or not plan:
            return None
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET port_plan = %s WHERE id = %s AND client_id = %s",
            (json.dumps(plan), device_id, client_id),
        )
        return plan

    def clean_port_plan(self, payload):
        raw = payload.get("ports") if isinstance(payload, dict) else None
        if raw is None:
            return None
        if not isinstance(raw, list) or len(raw) > 32:
            raise ApiError(400, "Choose a port that exists on this router.")
        allowed = ("wan", "lan", "hotspot", "pppoe", "static", "dhcp")
        plan = {}
        for item in raw:
            if not isinstance(item, dict):
                raise ApiError(400, "Choose a port that exists on this router.")
            iface = str(item.get("iface") or "")
            if not iface or len(iface) > 32 or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-" for character in iface):
                raise ApiError(400, "Choose a port that exists on this router.")
            uses = item.get("uses") or []
            if not isinstance(uses, list) or len(uses) > len(allowed):
                raise ApiError(400, "Choose what that port will do.")
            cleaned = []
            for use in uses:
                use = str(use)
                if use not in allowed or use in cleaned:
                    raise ApiError(400, "Choose what that port will do.")
                cleaned.append(use)
            plan[iface] = cleaned
        return plan

    def read_port_plan(self, row):
        raw = row.get("port_plan") or ""
        try:
            loaded = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}
        if not isinstance(loaded, dict):
            return {}
        allowed = {"wan", "lan", "hotspot", "pppoe", "static", "dhcp"}
        plan = {}
        for iface, uses in loaded.items():
            name = str(iface)
            if not isinstance(uses, list):
                continue
            cleaned = [str(use) for use in uses if str(use) in allowed]
            if cleaned:
                plan[name] = cleaned
        return plan

    def mikrotik_row(self, cursor, device_id, client_id):
        cursor.execute(
            "SELECT * FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row:
            raise ApiError(404, "That router was not found.")
        def stamp(value):
            if value is None:
                return None
            return value.isoformat(sep=" ") if hasattr(value, "isoformat") else str(value)

        endpoint = os.environ.get("ISP_WG_ENDPOINT", "").strip()
        server_public_key = os.environ.get("ISP_WG_PUBLIC_KEY", "").strip()
        tunnel_up = (row.get("tunnel_status") or "") == "up"
        ready = bool(endpoint and server_public_key and row["status"] == "active" and tunnel_up)
        return {
            "id": row["id"],
            "name": row["name"],
            "site": row["site"],
            "role": row["role"],
            "routerosVersion": row["routeros_version"] or "",
            "tunnelIp": row["tunnel_ip"],
            "publicKey": row["public_key"],
            "status": row["status"],
            "tunnelStatus": row.get("tunnel_status") or "unknown",
            "lastSeen": stamp(row.get("last_seen_at")),
            "lastApi": stamp(row.get("last_api_at")),
            "apiReady": bool(row.get("api_secret")),
            "pppoeEnforced": bool(row.get("pppoe_enforced")),
            "hotspotEnabled": bool(row.get("hotspot_enabled")),
            "hotspotBlockSharing": bool(row.get("hotspot_block_sharing")),
            "stageTested": bool(row.get("stage_tested_at")),
            "serverTunnelIp": "10.88.0.1",
            "endpoint": endpoint,
            "endpointPort": int(os.environ.get("ISP_WG_PORT", "51820")),
            "serverPublicKey": server_public_key,
            "checks": {
                "handshake": tunnel_up,
                "privateIp": tunnel_up,
                "apiLogin": tunnel_up and bool(row.get("last_api_at")),
                "identity": tunnel_up and bool(row.get("routeros_version")),
                "ready": ready,
            },
            "portPlan": self.read_port_plan(row),
        }

    def seal_router_password(self, password):
        allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@._-")
        if not (12 <= len(password) <= 64 and all(character in allowed for character in password)):
            raise ApiError(400, "Enter the API password from the WinBox script.")
        return routeros_api.seal_password(password)

    def save_mikrotik_details(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        self.mikrotik_row(cursor, device_id, client_id)
        name = str(payload.get("name", "")).strip()
        site = str(payload.get("site", "")).strip()
        if not name or len(name) > 80 or not site or len(site) > 80 or any(ord(character) < 32 for character in name + site):
            raise ApiError(400, "Enter the router name and location.")
        cursor.execute(
            "SELECT id FROM isp_mikrotik_devices WHERE client_id = %s AND name = %s AND id <> %s",
            (client_id, name, device_id),
        )
        if cursor.fetchone():
            raise ApiError(409, "A router with that name is already recorded.")
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET name = %s, site = %s WHERE id = %s AND client_id = %s",
            (name, site, device_id, client_id),
        )
        return self.mikrotik_row(cursor, device_id, client_id)

    def save_mikrotik_access(self, cursor, device_id, token, payload):
        client_id = self.require_client(cursor, token)
        self.mikrotik_row(cursor, device_id, client_id)
        sealed = self.seal_router_password(str(payload.get("apiPassword", "")).strip())
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET api_secret = %s WHERE id = %s AND client_id = %s",
            (sealed, device_id, client_id),
        )
        return self.mikrotik_row(cursor, device_id, client_id)

    def live_mikrotik(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        cursor.execute(
            "SELECT * FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row:
            raise ApiError(404, "That router was not found.")
        if not rate_ok(("router-read", device_id), *RATE_RULES["router-read"]):
            raise ApiError(429, "That router is being polled too quickly. Wait a moment.")
        checked_at = datetime.now().isoformat(sep=" ", timespec="seconds")
        if not row.get("api_secret"):
            return {
                "reachable": False,
                "apiReady": False,
                "name": row["name"],
                "message": "Save the API password from the WinBox script to read this router.",
                "checkedAt": checked_at,
                "interfaces": [],
            }
        password = None
        try:
            password = routeros_api.open_password(row["api_secret"])
            live = routeros_api.read_router(row["tunnel_ip"], password)
        except routeros_api.RouterError as error:
            message = str(error)
            if message == "The management tunnel did not answer.":
                cursor.execute(
                    "UPDATE isp_mikrotik_devices SET tunnel_status = 'down' WHERE id = %s AND client_id = %s",
                    (device_id, client_id),
                )
                if os.environ.get("ISP_ENV", "development") != "production" and password == routeros_api.DEV_PASSWORD:
                    live = routeros_api.sample_router(row["name"])
                    live["apiReady"] = True
                    live["name"] = row["name"]
                    live["checkedAt"] = checked_at
                    live["message"] = "No router is connected. Showing a development sample."
                    live["health"] = routeros_api.sample_health()
                    return live
                health = self.sync_router_health(
                    cursor,
                    client_id,
                    device_id,
                    [("Management tunnel", message)],
                )
                return {
                    "reachable": False,
                    "apiReady": True,
                    "name": row["name"],
                    "message": message,
                    "checkedAt": checked_at,
                    "interfaces": [],
                    "health": health,
                }
            return {
                "reachable": False,
                "apiReady": True,
                "name": row["name"],
                "message": message,
                "checkedAt": checked_at,
                "interfaces": [],
            }
        version = (live.get("version") or "")[:20] or None
        cursor.execute(
            """
            UPDATE isp_mikrotik_devices
            SET tunnel_status = 'up', last_seen_at = CURRENT_TIMESTAMP, last_api_at = CURRENT_TIMESTAMP,
                routeros_version = COALESCE(%s, routeros_version)
            WHERE id = %s AND client_id = %s
            """,
            (version, device_id, client_id),
        )
        observations = [("Management tunnel", None)]
        for item in live.get("interfaces") or []:
            observations.append((item.get("name") or "interface", routeros_api.interface_outage(item)))
        routeros_api.label_port_roles(live.get("interfaces"), self.read_port_plan(row))
        live["apiReady"] = True
        live["name"] = row["name"]
        live["site"] = row.get("site") or ""
        live["checkedAt"] = checked_at
        live["message"] = "This router answered over the management tunnel."
        live["health"] = self.sync_router_health(cursor, client_id, device_id, observations)
        return live

    def setup_mikrotik(self, cursor, device_id, token):
        client_id = self.require_client(cursor, token)
        cursor.execute(
            "SELECT * FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row:
            raise ApiError(404, "That router was not found.")
        if not rate_ok(("router-read", device_id), *RATE_RULES["router-read"]):
            raise ApiError(429, "That router is being polled too quickly. Wait a moment.")
        checked_at = datetime.now().isoformat(sep=" ", timespec="seconds")
        empty = {
            "reachable": False,
            "apiReady": bool(row.get("api_secret")),
            "identity": row["name"],
            "dns": "",
            "ntpEnabled": None,
            "services": [],
            "users": [],
            "wifi": [],
            "managementUser": routeros_api.API_USER,
            "managementPassword": "",
            "checkedAt": checked_at,
        }
        if not row.get("api_secret"):
            empty["message"] = "Save the API password from the WinBox script to read this router."
            return empty
        password = ""
        try:
            password = routeros_api.open_password(row["api_secret"])
            setup = routeros_api.read_setup(row["tunnel_ip"], password)
        except routeros_api.RouterError as error:
            message = str(error)
            if message == "The management tunnel did not answer." and os.environ.get("ISP_ENV", "development") != "production" and password == routeros_api.DEV_PASSWORD:
                setup = routeros_api.sample_setup(row["name"])
                setup["apiReady"] = True
                setup["managementUser"] = routeros_api.API_USER
                setup["managementPassword"] = password
                setup["checkedAt"] = checked_at
                setup["message"] = "No router is connected. Showing a development sample."
                return setup
            empty["message"] = message
            empty["managementPassword"] = password
            return empty
        setup["apiReady"] = True
        setup["managementUser"] = routeros_api.API_USER
        setup["managementPassword"] = password
        setup["checkedAt"] = checked_at
        setup["message"] = "These details were read from the router."
        return setup

    def sync_router_health(self, cursor, client_id, device_id, observations):
        for subject, reason in observations:
            subject = str(subject or "router")[:80]
            cursor.execute(
                """
                SELECT id FROM isp_mikrotik_health_events
                WHERE client_id = %s AND device_id = %s AND subject = %s AND ended_at IS NULL
                ORDER BY started_at DESC
                LIMIT 1
                """,
                (client_id, device_id, subject),
            )
            open_event = cursor.fetchone()
            if reason and not open_event:
                cursor.execute(
                    """
                    INSERT INTO isp_mikrotik_health_events (id, client_id, device_id, subject, reason, started_at)
                    VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                    """,
                    (str(uuid.uuid4()), client_id, device_id, subject, str(reason)[:160]),
                )
                notify_push_now()
            elif reason is None and open_event:
                cursor.execute(
                    "UPDATE isp_mikrotik_health_events SET ended_at = CURRENT_TIMESTAMP WHERE id = %s",
                    (open_event["id"],),
                )
        cursor.execute(
            """
            SELECT subject, reason, started_at, ended_at
            FROM isp_mikrotik_health_events
            WHERE client_id = %s AND device_id = %s
            ORDER BY started_at DESC
            LIMIT 12
            """,
            (client_id, device_id),
        )
        now = datetime.now()
        drops = []
        for event in cursor.fetchall():
            ended = event["ended_at"]
            started = event["started_at"]
            drops.append(
                {
                    "subject": event["subject"],
                    "reason": event["reason"],
                    "startedAt": started.isoformat(sep=" ", timespec="seconds"),
                    "endedAt": ended.isoformat(sep=" ", timespec="seconds") if ended else None,
                    "duration": routeros_api.duration_label(started, ended, now),
                    "open": ended is None,
                }
            )
        spans = self.health_spans(cursor, client_id, device_id, now - timedelta(hours=1))
        return {"drops": drops, "trend": routeros_api.trend_series(spans, now, "live")}

    def health_spans(self, cursor, client_id, device_id, since):
        cursor.execute(
            """
            SELECT started_at, ended_at
            FROM isp_mikrotik_health_events
            WHERE client_id = %s AND device_id = %s AND started_at >= %s
            ORDER BY started_at DESC
            LIMIT 400
            """,
            (client_id, device_id, since),
        )
        rows = list(cursor.fetchall())
        cursor.execute(
            """
            SELECT started_at, ended_at
            FROM isp_mikrotik_health_events
            WHERE client_id = %s AND device_id = %s AND ended_at IS NULL AND started_at < %s
            LIMIT 20
            """,
            (client_id, device_id, since),
        )
        rows.extend(cursor.fetchall())
        return [(event["started_at"], event["ended_at"]) for event in rows]

    def router_health_trend(self, cursor, device_id, token, scale):
        client_id = self.require_client(cursor, token)
        self.mikrotik_row(cursor, device_id, client_id)
        if scale not in routeros_api.TREND_SCALES:
            scale = "live"
        now = datetime.now().replace(microsecond=0)
        spans = self.health_spans(cursor, client_id, device_id, routeros_api.trend_since(scale, now))
        return routeros_api.trend_series(spans, now, scale)

    def require_communication_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing communication settings.")
        if not approved_account(cursor, "isp_clients", client_id):
            raise ApiError(403, "That account is still waiting for approval.")
        return client_id

    def communication_rows(self, cursor, client_id):
        cursor.execute(
            """
            SELECT channel, endpoint, sender, api_key, details
            FROM isp_communication_settings
            WHERE client_id = %s
            """,
            (client_id,),
        )
        return {row["channel"]: row for row in cursor.fetchall()}

    def communication_modes(self, cursor, client_id):
        cursor.execute(
            "SELECT channel, mode FROM isp_communication_preferences WHERE client_id = %s",
            (client_id,),
        )
        return {row["channel"]: row["mode"] for row in cursor.fetchall()}

    def read_communications(self, cursor, token):
        client_id = self.require_communication_client(cursor, token)
        rows = self.communication_rows(cursor, client_id)
        shared = self.company_communication_rows(cursor)
        modes = self.communication_modes(cursor, client_id)
        return {
            channel: {
                "mode": modes.get(channel) or "own",
                "own": public_communication(rows.get(channel)),
                "company": public_communication(shared.get(channel)),
            }
            for channel in ("sms", "whatsapp", "email")
        }

    def save_communication(self, cursor, payload, token):
        client_id = self.require_communication_client(cursor, token)
        channel = str(payload.get("channel", "")).strip()
        if channel not in {"sms", "whatsapp", "email"}:
            raise ApiError(400, "Choose the SMS, WhatsApp, or email API.")
        mode = str(payload.get("mode", "")).strip() or "own"
        if mode not in {"own", "company"}:
            raise ApiError(400, "Choose your own API or the company API.")
        if mode == "own":
            rows = self.communication_rows(cursor, client_id)
            fields = clean_communication(payload, rows.get(channel))
            cursor.execute(
                """
                INSERT INTO isp_communication_settings (client_id, channel, endpoint, sender, api_key, details)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                  endpoint = VALUES(endpoint),
                  sender = VALUES(sender),
                  api_key = VALUES(api_key),
                  details = VALUES(details)
                """,
                (client_id, fields["channel"], fields["endpoint"], fields["sender"], seal_secret(open_secret(fields["api_key"])), fields["details"]),
            )
        cursor.execute(
            """
            INSERT INTO isp_communication_preferences (client_id, channel, mode)
            VALUES (%s, %s, %s)
            ON DUPLICATE KEY UPDATE mode = VALUES(mode)
            """,
            (client_id, channel, mode),
        )
        return self.read_communications(cursor, token)

    def test_communication(self, cursor, payload, token):
        client_id = self.require_communication_client(cursor, token)
        channel = str(payload.get("channel", "")).strip()
        if channel not in {"sms", "whatsapp", "email"}:
            raise ApiError(400, "Choose the SMS, WhatsApp, or email API.")
        source = str(payload.get("source", "")).strip()
        if source not in {"own", "company"}:
            raise ApiError(400, "Choose your own API or the company API.")
        if source == "company":
            row = self.company_communication_rows(cursor).get(channel)
        else:
            row = self.communication_rows(cursor, client_id).get(channel)
        # Probe the saved endpoint only — an arbitrary URL here would make the
        # server an unauthenticated network-reachability oracle.
        return probe_communication(channel, row)

    def require_notification_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing notification settings.")
        if not approved_account(cursor, "isp_clients", client_id):
            raise ApiError(403, "That account is still waiting for approval.")
        return client_id

    def isp_notification_row(self, cursor, client_id):
        cursor.execute("SELECT * FROM isp_notification_settings WHERE client_id = %s", (client_id,))
        return cursor.fetchone()

    def read_notifications(self, cursor, token):
        client_id = self.require_notification_client(cursor, token)
        return {
            "notifications": public_notification_settings(
                self.isp_notification_row(cursor, client_id), ISP_NOTIFICATION_TOGGLES
            )
        }

    def save_notifications(self, cursor, payload, token):
        client_id = self.require_notification_client(cursor, token)
        current = public_notification_settings(self.isp_notification_row(cursor, client_id), ISP_NOTIFICATION_TOGGLES)
        submitted = payload.get("notifications") or {}
        fields = {key: 1 if bool(submitted.get(key, current[key])) else 0 for key in ISP_NOTIFICATION_TOGGLES}
        cursor.execute(
            """
            INSERT INTO isp_notification_settings (
              client_id, mikrotik_onboarded, mikrotik_unreachable, mikrotik_no_internet, client_cannot_surf,
              subscription_ending, communications_failed, payments_failed, server_unreachable
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              mikrotik_onboarded = VALUES(mikrotik_onboarded),
              mikrotik_unreachable = VALUES(mikrotik_unreachable),
              mikrotik_no_internet = VALUES(mikrotik_no_internet),
              client_cannot_surf = VALUES(client_cannot_surf),
              subscription_ending = VALUES(subscription_ending),
              communications_failed = VALUES(communications_failed),
              payments_failed = VALUES(payments_failed),
              server_unreachable = VALUES(server_unreachable)
            """,
            (
                client_id,
                fields["mikrotikOnboarded"],
                fields["mikrotikUnreachable"],
                fields["mikrotikNoInternet"],
                fields["clientCannotSurf"],
                fields["subscriptionEnding"],
                fields["communicationsFailed"],
                fields["paymentsFailed"],
                fields["serverUnreachable"],
            ),
        )
        return self.read_notifications(cursor, token)

    def notification_feed(self, cursor, token):
        client_id = self.require_notification_client(cursor, token)
        prefs = public_notification_settings(
            self.isp_notification_row(cursor, client_id), ISP_NOTIFICATION_TOGGLES
        )
        items = []
        if prefs["mikrotikOnboarded"]:
            cursor.execute(
                """
                SELECT id, name, site, COALESCE(authorized_at, created_at) AS happened_at
                FROM isp_mikrotik_devices
                WHERE client_id = %s
                ORDER BY happened_at DESC
                LIMIT 20
                """,
                (client_id,),
            )
            for row in cursor.fetchall():
                site = str(row["site"] or "").strip()
                items.append(
                    {
                        "id": f"onboarded-{row['id']}",
                        "kind": "mikrotikOnboarded",
                        "subject": f"{row['name']} was onboarded",
                        "detail": f"Router {row['name']} at {site} is under management." if site else f"Router {row['name']} is under management.",
                        "at": stamp(row["happened_at"]),
                        "open": False,
                    }
                )
        if prefs["mikrotikUnreachable"]:
            cursor.execute(
                """
                SELECT e.id, e.subject, e.reason, e.started_at, e.ended_at, d.name AS device_name
                FROM isp_mikrotik_health_events e
                JOIN isp_mikrotik_devices d ON d.id = e.device_id
                WHERE e.client_id = %s
                ORDER BY e.started_at DESC
                LIMIT 30
                """,
                (client_id,),
            )
            for row in cursor.fetchall():
                ended = row["ended_at"] is not None
                items.append(
                    {
                        "id": f"health-{row['id']}",
                        "kind": "mikrotikUnreachable",
                        "subject": row["subject"],
                        "detail": f"{row['device_name']}: {row['reason']}" + ("" if ended else " — still down."),
                        "at": stamp(row["started_at"]),
                        "open": not ended,
                    }
                )
        items += gateway_feed_items(cursor, "client", client_id=client_id)
        items.sort(key=lambda item: item["at"] or "", reverse=True)
        return {"notifications": items[:50]}

    def require_company_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing company details.")
        if not approved_account(cursor, "isp_clients", client_id):
            raise ApiError(403, "That account is still waiting for approval.")
        return client_id

    def read_company(self, cursor, token):
        client_id = self.require_company_client(cursor, token)
        cursor.execute(
            """
            SELECT company_name, email, phone, website, address, logo_data_url, updated_at
            FROM isp_company_settings
            WHERE client_id = %s
            """,
            (client_id,),
        )
        return {"company": public_company(cursor.fetchone())}

    def save_company(self, cursor, payload, token):
        client_id = self.require_company_client(cursor, token)
        fields = clean_company(payload)
        cursor.execute(
            """
            INSERT INTO isp_company_settings (client_id, company_name, email, phone, website, address, logo_data_url)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              company_name = VALUES(company_name),
              email = VALUES(email),
              phone = VALUES(phone),
              website = VALUES(website),
              address = VALUES(address),
              logo_data_url = VALUES(logo_data_url)
            """,
            (
                client_id,
                fields["name"],
                fields["email"],
                fields["phone"],
                fields["website"],
                fields["address"],
                fields["logo"],
            ),
        )
        return self.read_company(cursor, token)

    def require_payment_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing payment settings.")
        if not approved_account(cursor, "isp_clients", client_id):
            raise ApiError(403, "That account is still waiting for approval.")
        return client_id

    def payment_rows(self, cursor, client_id):
        cursor.execute(
            """
            SELECT scope, environment, account_type, short_code, consumer_key, consumer_secret, passkey,
                   callback_url, confirmation_url, validation_url, initiator_name, security_credential, updated_at
            FROM isp_payment_settings
            WHERE client_id = %s
            """,
            (client_id,),
        )
        return {row["scope"]: row for row in cursor.fetchall()}

    def read_payments(self, cursor, token):
        client_id = self.require_payment_client(cursor, token)
        cursor.execute("SELECT mode FROM isp_payment_preferences WHERE client_id = %s", (client_id,))
        preference = cursor.fetchone()
        rows = self.payment_rows(cursor, client_id)
        return {
            "mode": preference["mode"] if preference else None,
            "own": public_payment(rows.get("own")),
            "company": public_payment(rows.get("company")),
        }

    def save_payments(self, cursor, payload, token):
        client_id = require_owner_client(cursor, token, "payment settings")
        mode = str(payload.get("mode", "")).strip()
        if mode not in {"own", "company"}:
            raise ApiError(400, "Choose your Daraja API or the company payment settings.")
        rows = self.payment_rows(cursor, client_id)
        fields = clean_daraja(payload.get(mode) or {}, rows.get(mode))
        cursor.execute(
            """
            INSERT INTO isp_payment_settings (
              client_id, scope, environment, account_type, short_code, consumer_key, consumer_secret, passkey,
              callback_url, confirmation_url, validation_url, initiator_name, security_credential
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              environment = VALUES(environment),
              account_type = VALUES(account_type),
              short_code = VALUES(short_code),
              consumer_key = VALUES(consumer_key),
              consumer_secret = VALUES(consumer_secret),
              passkey = VALUES(passkey),
              callback_url = VALUES(callback_url),
              confirmation_url = VALUES(confirmation_url),
              validation_url = VALUES(validation_url),
              initiator_name = VALUES(initiator_name),
              security_credential = VALUES(security_credential)
            """,
            (
                client_id,
                mode,
                fields["environment"],
                fields["account_type"],
                fields["short_code"],
                fields["consumer_key"],
                seal_secret(open_secret(fields["consumer_secret"])),
                seal_secret(open_secret(fields["passkey"])),
                fields["callback_url"],
                fields["confirmation_url"],
                fields["validation_url"],
                fields["initiator_name"],
                seal_secret(open_secret(fields["security_credential"])),
            ),
        )
        cursor.execute(
            """
            INSERT INTO isp_payment_preferences (client_id, mode) VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE mode = VALUES(mode)
            """,
            (client_id, mode),
        )
        # Credentials saved through this page are the ISP's own stored rows —
        # keep gateway_mode on own_daraja so the portal keeps collecting with
        # them exactly as before. A company_gateway opt-in is never downgraded
        # here; it changes only through the payout settings flow.
        cursor.execute(
            """
            INSERT INTO isp_payout_settings (client_id, gateway_mode) VALUES (%s, 'own_daraja')
            ON DUPLICATE KEY UPDATE
              gateway_mode = IF(gateway_mode = 'company_gateway', gateway_mode, 'own_daraja')
            """,
            (client_id,),
        )
        return self.read_payments(cursor, token)

    def test_payments(self, cursor, payload, token):
        client_id = self.require_payment_client(cursor, token)
        mode = str(payload.get("mode", "")).strip()
        if mode not in {"own", "company"}:
            raise ApiError(400, "Choose your Daraja API or the company payment settings.")
        row = self.payment_rows(cursor, client_id).get(mode) or {}
        submitted = payload.get(mode) or {}

        def field(name, column):
            text = str(submitted.get(name) or "").strip()
            if text and not text.startswith("••••"):
                return text
            return str(row.get(column) or "")

        environment = str(submitted.get("environment") or "").strip()
        if environment not in {"sandbox", "live"}:
            environment = str(row.get("environment") or "")
        if environment not in {"sandbox", "live"}:
            return {"connected": False, "reason": "Choose whether these are sandbox or live credentials."}
        key = field("consumerKey", "consumer_key")
        secret = open_secret(field("consumerSecret", "consumer_secret"))
        if not key or not secret:
            return {"connected": False, "reason": "Enter the consumer key and secret, or save the Daraja details first."}
        return daraja_oauth_probe(environment, key, secret)

    def require_package_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing packages.")
        if not approved_account(cursor, "isp_clients", client_id):
            raise ApiError(403, "That account is still waiting for approval.")
        return client_id

    def public_package_routers(self, cursor, client_id):
        if client_id:
            cursor.execute(
                """
                SELECT d.id, d.name, d.site, c.first_name, c.last_name
                FROM isp_mikrotik_devices d
                JOIN isp_clients c ON c.id = d.client_id
                WHERE d.client_id = %s
                ORDER BY d.name
                """,
                (client_id,),
            )
        else:
            cursor.execute(
                """
                SELECT d.id, d.name, d.site, c.first_name, c.last_name
                FROM isp_mikrotik_devices d
                JOIN isp_clients c ON c.id = d.client_id
                ORDER BY c.first_name, c.last_name, d.name
                """
            )
        routers = []
        for row in cursor.fetchall():
            routers.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "site": row["site"],
                    "clientName": f"{row['first_name']} {row['last_name']}".strip(),
                }
            )
        return routers

    def package_router_ids(self, cursor, client_id, payload, message):
        allowed = {item["id"] for item in self.public_package_routers(cursor, client_id)}
        return json.dumps(clean_router_ids(payload.get("routers"), allowed, message))

    def package_row(self, cursor, package_id, client_id):
        cursor.execute(
            f"""
            SELECT {ISP_PACKAGE_COLUMNS}
            FROM isp_packages
            WHERE id = %s AND client_id = %s
            """,
            (package_id, client_id),
        )
        row = cursor.fetchone()
        if not row:
            raise ApiError(404, "That package was not found.")
        return row

    def list_packages(self, cursor, token):
        client_id = self.require_package_client(cursor, token)
        cursor.execute(
            f"""
            SELECT {ISP_PACKAGE_COLUMNS}
            FROM isp_packages
            WHERE client_id = %s
            ORDER BY name
            """,
            (client_id,),
        )
        return [public_package(row) for row in cursor.fetchall()]

    def create_package(self, cursor, payload, token):
        client_id = self.require_package_client(cursor, token)
        fields = clean_package_fields(payload)
        if fields["status"] == "suspended":
            raise ApiError(400, "Choose draft, active, or archived.")
        image = optional_package_image(payload.get("imageDataUrl"))
        routers = self.package_router_ids(cursor, client_id, payload, "Select routers linked to your account.")
        cursor.execute(
            "SELECT id FROM isp_packages WHERE client_id = %s AND name = %s",
            (client_id, fields["name"]),
        )
        if cursor.fetchone():
            raise ApiError(409, "A package with that name is already registered.")
        package_id = str(uuid.uuid4())
        cursor.execute(
            """
            INSERT INTO isp_packages (
              id, client_id, name, service_type, price, billing_model, download_mbps, upload_mbps,
              validity_amount, validity_unit,
              data_allowance_amount, data_allowance_unit, data_allowance_action,
              data_throttle_download, data_throttle_upload, data_reset_amount, data_reset_unit,
              fair_use_amount, fair_use_unit, fair_use_policy, fair_use_action,
              fair_throttle_download, fair_throttle_upload, fair_reset_amount, fair_reset_unit,
              simultaneous_devices, extra_device_price, extra_period_price, grace_amount, grace_unit,
              status, availability_routers, image_data_url
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s,
              %s, %s,
              %s, %s, %s,
              %s, %s, %s, %s,
              %s, %s, %s, %s,
              %s, %s, %s, %s,
              %s, %s, %s, %s, %s,
              %s, %s, %s
            )
            """,
            (
                package_id,
                client_id,
                fields["name"],
                fields["service_type"],
                fields["price"],
                fields["billing_model"],
                fields["download"],
                fields["upload"],
                fields["validity_amount"],
                fields["validity_unit"],
                fields["data_amount"],
                fields["data_unit"],
                fields["data_action"],
                fields["data_down"],
                fields["data_up"],
                fields["data_reset_amount"],
                fields["data_reset_unit"],
                fields["fair_amount"],
                fields["fair_unit"],
                fields["fair_policy"] or None,
                fields["fair_action"],
                fields["fair_down"],
                fields["fair_up"],
                fields["fair_reset_amount"],
                fields["fair_reset_unit"],
                fields["devices"],
                fields["extra_device"],
                fields["extra_period"],
                fields["grace_amount"],
                fields["grace_unit"],
                fields["status"],
                routers,
                image or None,
            ),
        )
        return public_package(self.package_row(cursor, package_id, client_id))

    def change_package(self, cursor, package_path, payload, token):
        client_id = self.require_package_client(cursor, token)
        package_id, _, action = package_path.partition("/")
        row = self.package_row(cursor, package_id, client_id)
        if action == "edit":
            fields = clean_package_fields(payload)
            if fields["status"] == "suspended" and row["status"] != "suspended":
                raise ApiError(400, "Choose draft, active, or archived.")
            image = optional_package_image(payload.get("imageDataUrl"))
            routers = self.package_router_ids(cursor, client_id, payload, "Select routers linked to your account.")
            cursor.execute(
                "SELECT id FROM isp_packages WHERE client_id = %s AND name = %s AND id <> %s",
                (client_id, fields["name"], package_id),
            )
            if cursor.fetchone():
                raise ApiError(409, "A package with that name is already registered.")
            cursor.execute(
                """
                UPDATE isp_packages
                SET name = %s, service_type = %s, price = %s, billing_model = %s,
                    download_mbps = %s, upload_mbps = %s, validity_amount = %s, validity_unit = %s,
                    data_allowance_amount = %s, data_allowance_unit = %s, data_allowance_action = %s,
                    data_throttle_download = %s, data_throttle_upload = %s,
                    data_reset_amount = %s, data_reset_unit = %s,
                    fair_use_amount = %s, fair_use_unit = %s, fair_use_policy = %s, fair_use_action = %s,
                    fair_throttle_download = %s, fair_throttle_upload = %s,
                    fair_reset_amount = %s, fair_reset_unit = %s,
                    simultaneous_devices = %s, extra_device_price = %s, extra_period_price = %s,
                    grace_amount = %s, grace_unit = %s,
                    status = %s, availability_routers = %s, image_data_url = %s, customized = 1
                WHERE id = %s AND client_id = %s
                """,
                (
                    fields["name"],
                    fields["service_type"],
                    fields["price"],
                    fields["billing_model"],
                    fields["download"],
                    fields["upload"],
                    fields["validity_amount"],
                    fields["validity_unit"],
                    fields["data_amount"],
                    fields["data_unit"],
                    fields["data_action"],
                    fields["data_down"],
                    fields["data_up"],
                    fields["data_reset_amount"],
                    fields["data_reset_unit"],
                    fields["fair_amount"],
                    fields["fair_unit"],
                    fields["fair_policy"] or None,
                    fields["fair_action"],
                    fields["fair_down"],
                    fields["fair_up"],
                    fields["fair_reset_amount"],
                    fields["fair_reset_unit"],
                    fields["devices"],
                    fields["extra_device"],
                    fields["extra_period"],
                    fields["grace_amount"],
                    fields["grace_unit"],
                    fields["status"],
                    routers,
                    image or None,
                    package_id,
                    client_id,
                ),
            )
            cursor.execute(
                "UPDATE pppoe_subscriptions SET price = %s WHERE package_id = %s",
                (fields["price"], package_id),
            )
            return {"package": public_package(self.package_row(cursor, package_id, client_id))}, None
        if action == "suspend":
            if row["status"] == "suspended":
                raise ApiError(400, "That package is already suspended.")
            cursor.execute(
                "UPDATE isp_packages SET status = 'suspended', customized = 1 WHERE id = %s AND client_id = %s",
                (package_id, client_id),
            )
            return {"package": public_package(self.package_row(cursor, package_id, client_id))}, None
        if action == "unsuspend":
            if row["status"] == "active":
                raise ApiError(400, "That package is already active.")
            cursor.execute(
                "UPDATE isp_packages SET status = 'active', customized = 1 WHERE id = %s AND client_id = %s",
                (package_id, client_id),
            )
            return {"package": public_package(self.package_row(cursor, package_id, client_id))}, None
        if action == "delete":
            cursor.execute("SELECT id FROM pppoe_subscribers WHERE package_id = %s LIMIT 1", (package_id,))
            if cursor.fetchone():
                raise ApiError(400, "That package is assigned to a PPPoE client.")
            cursor.execute("DELETE FROM isp_packages WHERE id = %s AND client_id = %s", (package_id, client_id))
            return {"ok": True}, None
        raise ApiError(404, "That account request was not found.")

    def require_company_employee(self, cursor, token, subject="company packages", write=False):
        employee_id = session_account_id(cursor, token, "employee")
        if not employee_id:
            raise ApiError(401, f"Sign in to the employee account before managing {subject}.")
        cursor.execute("SELECT status, role FROM isp_employees WHERE id = %s", (employee_id,))
        employee = cursor.fetchone()
        if not employee or employee["status"] != "approved":
            raise ApiError(403, f"An approved employee account is required to manage {subject}.")
        if write and (employee["role"] or "") not in ("director", "supervisor", "it-support"):
            raise ApiError(403, f"A director, supervisor or IT-support role is required to change {subject}.")
        return employee_id

    def company_daraja_row(self, cursor):
        cursor.execute(
            """
            SELECT environment, account_type, short_code, consumer_key, consumer_secret, passkey,
                   initiator_name, initiator_password_enc, payout_shortcode, updated_at
            FROM company_daraja_settings
            WHERE id = 1
            """
        )
        return cursor.fetchone()

    def company_other_gateway_row(self, cursor):
        cursor.execute(
            """
            SELECT provider, environment, endpoint, public_key, secret_key
            FROM company_other_gateway
            WHERE id = 1
            """
        )
        return cursor.fetchone()

    def read_company_payments(self, cursor, token):
        require_director(cursor, token, "company payments")
        # Learning the public base is deliberately director-only: a
        # lower-privileged session must never steer callback URLs — and the
        # callback secret they carry — toward a forged Host.
        gateway_store.remember_public_base(cursor, self.learned_public_base())
        daraja = public_payment(self.company_daraja_row(cursor))
        if daraja is not None:
            # The callback secret is shown only here — the only endpoint a
            # director can reach — never on any other settings read.
            secret = gateway_store.ensure_callback_secret(cursor)
            base = gateway_store.public_base(cursor)
            prefix = f"{base}/api/daraja/{secret}" if base else ""
            daraja["callbackSecret"] = secret
            daraja["callbackBase"] = base
            daraja["callbackBaseSource"] = (
                "environment"
                if (os.environ.get("ISP_GATEWAY_PUBLIC_URL") or "").strip()
                else "learned" if base else ""
            )
            daraja["callbackUrls"] = {
                name: f"{prefix}/{path}" if prefix else ""
                for name, path in (
                    ("stk", "stk"),
                    ("c2bValidation", "c2b/validation"),
                    ("c2bConfirmation", "c2b/confirmation"),
                    ("b2cResult", "b2c/result"),
                    ("b2cTimeout", "b2c/timeout"),
                    ("b2bResult", "b2b/result"),
                    ("b2bTimeout", "b2b/timeout"),
                    ("accountBalance", "account-balance"),
                )
            }
        return {
            "daraja": daraja,
            "other": public_other_gateway(self.company_other_gateway_row(cursor)),
        }

    def save_company_payments(self, cursor, payload, token):
        require_director(cursor, token, "company payments")
        gateway = str(payload.get("gateway", "")).strip()
        if gateway == "daraja":
            import daraja_client

            previous = self.company_daraja_row(cursor)
            fields = clean_daraja(payload.get("daraja") or {}, previous)
            daraja = payload.get("daraja") or {}
            initiator_name = optional_text(
                daraja.get("initiatorName"), "Enter the Daraja initiator name.", 60
            )
            initiator_password = keep_optional_secret(
                daraja.get("initiatorPassword"),
                (previous or {}).get("initiator_password_enc"),
                "Enter the Daraja initiator password.",
                8,
                255,
            )
            payout_shortcode = str(daraja.get("payoutShortcode") or "").strip()
            if payout_shortcode:
                try:
                    payout_shortcode = daraja_client.validate_shortcode(
                        payout_shortcode, "payout shortcode"
                    )
                except daraja_client.DarajaError as error:
                    raise ApiError(400, str(error))
            cursor.execute(
                """
                INSERT INTO company_daraja_settings (
                  id, environment, account_type, short_code, consumer_key, consumer_secret, passkey,
                  initiator_name, initiator_password_enc, payout_shortcode
                ) VALUES (1, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                  environment = VALUES(environment),
                  account_type = VALUES(account_type),
                  short_code = VALUES(short_code),
                  consumer_key = VALUES(consumer_key),
                  consumer_secret = VALUES(consumer_secret),
                  passkey = VALUES(passkey),
                  initiator_name = VALUES(initiator_name),
                  initiator_password_enc = VALUES(initiator_password_enc),
                  payout_shortcode = VALUES(payout_shortcode)
                """,
                (
                    fields["environment"],
                    fields["account_type"],
                    fields["short_code"],
                    fields["consumer_key"],
                    seal_secret(open_secret(fields["consumer_secret"])),
                    seal_secret(open_secret(fields["passkey"])),
                    initiator_name,
                    seal_secret(open_secret(initiator_password)),
                    payout_shortcode,
                ),
            )
            return self.read_company_payments(cursor, token)
        if gateway == "other":
            fields = clean_other_gateway(payload.get("other") or {}, self.company_other_gateway_row(cursor))
            cursor.execute(
                """
                INSERT INTO company_other_gateway (
                  id, provider, environment, endpoint, public_key, secret_key
                ) VALUES (1, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                  provider = VALUES(provider),
                  environment = VALUES(environment),
                  endpoint = VALUES(endpoint),
                  public_key = VALUES(public_key),
                  secret_key = VALUES(secret_key)
                """,
                (
                    fields["provider"],
                    fields["environment"],
                    fields["endpoint"],
                    fields["public_key"],
                    seal_secret(open_secret(fields["secret_key"])),
                ),
            )
            return self.read_company_payments(cursor, token)
        raise ApiError(400, "Choose the company Daraja API or the other payment gateway.")

    def test_company_payments(self, cursor, payload, token):
        require_director(cursor, token, "company payments")
        row = self.company_daraja_row(cursor) or {}
        submitted = payload.get("daraja") or {}

        def field(name, column):
            text = str(submitted.get(name) or "").strip()
            if text and not text.startswith("••••"):
                return text
            return str(row.get(column) or "")

        environment = str(submitted.get("environment") or "").strip()
        if environment not in {"sandbox", "live"}:
            environment = str(row.get("environment") or "")
        if environment not in {"sandbox", "live"}:
            return {"connected": False, "reason": "Choose whether these are sandbox or live credentials."}
        key = field("consumerKey", "consumer_key")
        secret = open_secret(field("consumerSecret", "consumer_secret"))
        if not key or not secret:
            return {"connected": False, "reason": "Enter the consumer key and secret, or save the Daraja details first."}
        return daraja_oauth_probe(environment, key, secret)

    # --- Company gateway (director-only custody & ops) ---------------------------

    def company_gateway(self, cursor, method, path, payload, query, token):
        """/api/employee/company/gateway/* — every route needs a director
        session; there is no employee-readable variant of pooled money."""
        employee_id = require_director(cursor, token.get("isp_employee_session"))
        leaf = path.removeprefix("/api/employee/company/gateway").strip("/")
        if method == "GET":
            handlers = {
                "overview": lambda: gateway_api.overview(cursor),
                "clients": lambda: gateway_api.clients(cursor),
                "payments": lambda: gateway_api.payments(cursor, query),
                "payouts": lambda: gateway_api.payouts(cursor, query),
                "batches": lambda: gateway_api.batches(cursor, query),
                "ledger": lambda: gateway_api.ledger(cursor, query),
                "suspense": lambda: gateway_api.suspense(cursor),
                "pending-changes": lambda: gateway_api.pending_changes(cursor),
                "audit": lambda: gateway_api.audit(cursor, query),
                "notifications": lambda: gateway_api.notifications(cursor, query),
                "settings": lambda: gateway_api.settings_view(cursor),
                "charges": lambda: gateway_api.charges_view(cursor),
            }
            if leaf == "export":
                kind = (query.get("kind") or [""])[0]
                result, error = gateway_api.export_csv(cursor, kind, query)
                if error:
                    raise ApiError(400, error)
                return result
            handler = handlers.get(leaf)
            if handler:
                return handler()
        if method == "POST" and leaf == "suspense/assign":
            # Attribute an unmatched payment — multi-statement, so one
            # transaction wraps the claim + ledger + audit.
            connection = cursor.connection
            connection.autocommit(False)
            try:
                payment_id = str(payload.get("paymentId") or "")
                result, error = gateway_api.assign_suspense(
                    cursor, payment_id, payload, employee_id)
                if error:
                    raise ApiError(400, error)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.autocommit(True)
            return result
        if method == "POST" and leaf in ("settings", "payouts/check", "payouts/mark-failed", "charges"):
            # Gateway ops writes — one transaction wraps the update + audit.
            connection = cursor.connection
            connection.autocommit(False)
            try:
                if leaf == "settings":
                    result, error = gateway_api.save_company_gateway(
                        cursor, payload, employee_id)
                elif leaf == "charges":
                    result, error = gateway_api.save_charges(
                        cursor, payload, employee_id)
                elif leaf == "payouts/check":
                    result, error = gateway_api.check_payout(
                        cursor, str(payload.get("payoutId") or ""), employee_id)
                else:
                    result, error = gateway_api.mark_payout_failed(
                        cursor, str(payload.get("payoutId") or ""), employee_id)
                if error:
                    raise ApiError(400, error)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.autocommit(True)
            return result
        raise ApiError(404, "Not found.")

    # --- ISP gateway (own ledger portal) --------------------------------------------

    def isp_gateway(self, cursor, method, path, payload, query, token):
        """/api/gateway/* — the ISP's own custody view. Reads need any
        approved client session; the settings write is owner-only and needs
        the account password again."""
        client_id = self.require_payment_client(cursor, token.get("isp_client_session"))
        leaf = path.removeprefix("/api/gateway").strip("/")
        if method == "GET":
            handlers = {
                "summary": lambda: gateway_api.isp_summary(cursor, client_id),
                "settings": lambda: {
                    **gateway_api.isp_settings(cursor, client_id),
                    "readOnly": bool(session_opened_by(cursor, token.get("isp_client_session"))),
                },
                "settings/check": lambda: gateway_precheck(cursor),
                "fees": lambda: gateway_api.isp_fees(cursor),
                "payments": lambda: gateway_api.isp_payments(cursor, client_id, query),
                "payouts": lambda: gateway_api.isp_payouts(cursor, client_id, query),
                "ledger": lambda: gateway_api.isp_ledger(cursor, client_id, query),
                "notifications": lambda: gateway_api.isp_notifications(cursor, client_id, query),
            }
            handler = handlers.get(leaf)
            if handler:
                return handler()
        if method == "POST" and leaf == "settings":
            require_owner_client(cursor, token.get("isp_client_session"), "payout settings")
            password = str(payload.get("password") or "")
            cursor.execute(
                "SELECT password_salt, password_hash FROM isp_clients WHERE id = %s",
                (client_id,),
            )
            account = cursor.fetchone() or {}
            if not password or not verify_password(
                password, account.get("password_salt") or "0" * 32,
                account.get("password_hash") or "",
            ):
                raise ApiError(403, "Re-enter the account password to change payout settings.")
            connection = cursor.connection
            connection.autocommit(False)
            try:
                result, error = gateway_api.save_isp_settings(
                    cursor, client_id, payload, actor_id=client_id)
                if error:
                    raise ApiError(400, error)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.autocommit(True)
            return result
        raise ApiError(404, "Not found.")

    def company_communication_rows(self, cursor):
        cursor.execute("SELECT channel, endpoint, sender, api_key, details FROM company_communication_settings")
        return {row["channel"]: row for row in cursor.fetchall()}

    def read_company_communications(self, cursor, token):
        self.require_company_employee(cursor, token, "company communications")
        rows = self.company_communication_rows(cursor)
        return {
            "sms": public_communication(rows.get("sms")),
            "whatsapp": public_communication(rows.get("whatsapp")),
            "email": public_communication(rows.get("email")),
        }

    def save_company_communication(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company communications", write=True)
        channel = str(payload.get("channel", "")).strip()
        rows = self.company_communication_rows(cursor)
        fields = clean_communication(payload, rows.get(channel) if channel in rows else None)
        cursor.execute(
            """
            INSERT INTO company_communication_settings (channel, endpoint, sender, api_key, details)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              endpoint = VALUES(endpoint),
              sender = VALUES(sender),
              api_key = VALUES(api_key),
              details = VALUES(details)
            """,
            (fields["channel"], fields["endpoint"], fields["sender"], seal_secret(open_secret(fields["api_key"])), fields["details"]),
        )
        return self.read_company_communications(cursor, token)

    def test_company_communication(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company communications")
        channel = str(payload.get("channel", "")).strip()
        if channel not in {"sms", "whatsapp", "email"}:
            raise ApiError(400, "Choose the SMS, WhatsApp, or email API.")
        row = self.company_communication_rows(cursor).get(channel)
        return probe_communication(channel, row)

    def company_profile_row(self, cursor):
        cursor.execute(
            """
            SELECT company_name, email, phone, website, address, logo_data_url, updated_at
            FROM company_profile_settings
            WHERE id = 1
            """
        )
        return cursor.fetchone()

    def read_company_profile(self, cursor, token):
        self.require_company_employee(cursor, token, "company profile")
        return {"company": public_company(self.company_profile_row(cursor))}

    def save_company_profile(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company profile", write=True)
        fields = clean_company(payload)
        cursor.execute(
            """
            INSERT INTO company_profile_settings (id, company_name, email, phone, website, address, logo_data_url)
            VALUES (1, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              company_name = VALUES(company_name),
              email = VALUES(email),
              phone = VALUES(phone),
              website = VALUES(website),
              address = VALUES(address),
              logo_data_url = VALUES(logo_data_url)
            """,
            (
                fields["name"],
                fields["email"],
                fields["phone"],
                fields["website"],
                fields["address"],
                fields["logo"],
            ),
        )
        return self.read_company_profile(cursor, token)

    def company_notification_row(self, cursor):
        cursor.execute("SELECT * FROM company_notification_settings WHERE id = 1")
        return cursor.fetchone()

    def read_company_notifications(self, cursor, token):
        self.require_company_employee(cursor, token, "company notifications")
        return {"notifications": public_notification_settings(self.company_notification_row(cursor), NOTIFICATION_TOGGLES)}

    def save_company_notifications(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company notifications", write=True)
        current = public_notification_settings(self.company_notification_row(cursor), NOTIFICATION_TOGGLES)
        submitted = payload.get("notifications") or {}
        fields = {key: 1 if bool(submitted.get(key, current[key])) else 0 for key in NOTIFICATION_TOGGLES}
        cursor.execute(
            """
            INSERT INTO company_notification_settings (
              id, server_unreachable, mikrotik_unreachable, mikrotik_added, isp_registered,
              communications_failed, payments_failed
            ) VALUES (1, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              server_unreachable = VALUES(server_unreachable),
              mikrotik_unreachable = VALUES(mikrotik_unreachable),
              mikrotik_added = VALUES(mikrotik_added),
              isp_registered = VALUES(isp_registered),
              communications_failed = VALUES(communications_failed),
              payments_failed = VALUES(payments_failed)
            """,
            (
                fields["serverUnreachable"],
                fields["mikrotikUnreachable"],
                fields["mikrotikAdded"],
                fields["ispRegistered"],
                fields["communicationsFailed"],
                fields["paymentsFailed"],
            ),
        )
        return self.read_company_notifications(cursor, token)

    def company_notification_feed(self, cursor, token):
        employee_id = self.require_company_employee(cursor, token, "company notifications")
        items = company_notification_items(cursor)
        cursor.execute(
            "SELECT item_id FROM employee_notification_reads WHERE employee_id = %s",
            (employee_id,),
        )
        read = {row["item_id"] for row in cursor.fetchall()}
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).isoformat(sep=" ")
        visible = []
        for item in items:
            item["read"] = item["id"] in read
            # Today's items always show; older ones only stay while unread.
            if not item["read"] or (item["at"] or "") >= today:
                visible.append(item)
        return {"notifications": visible[:80]}

    def mark_company_notifications_read(self, cursor, payload, token):
        employee_id = self.require_company_employee(cursor, token, "company notifications")
        if payload.get("all"):
            ids = [item["id"] for item in company_notification_items(cursor)]
        else:
            ids = [str(item or "")[:96] for item in (payload.get("itemIds") or []) if str(item or "")]
        for item_id in ids[:200]:
            cursor.execute(
                "INSERT IGNORE INTO employee_notification_reads (employee_id, item_id) VALUES (%s, %s)",
                (employee_id, item_id),
            )
        return self.company_notification_feed(cursor, token)

    def read_company_push(self, cursor, token):
        employee_id = self.require_company_employee(cursor, token, "company notifications")
        public, _ = vapid_keys(cursor)
        cursor.execute(
            "SELECT COUNT(*) AS devices FROM employee_push_subscriptions WHERE employee_id = %s",
            (employee_id,),
        )
        return {
            "push": {
                "vapidPublicKey": public,
                "devices": int((cursor.fetchone() or {}).get("devices") or 0),
            }
        }

    def save_company_push_subscription(self, cursor, payload, token):
        employee_id = self.require_company_employee(cursor, token, "company notifications")
        endpoint = str(payload.get("endpoint", "")).strip()
        keys = payload.get("keys") or {}
        p256dh = str(keys.get("p256dh", "")).strip()
        auth = str(keys.get("auth", "")).strip()
        if not endpoint.startswith("https://") or len(endpoint) > 500:
            raise ApiError(400, "The push subscription endpoint is not valid.")
        if not p256dh or len(p256dh) > 255 or not auth or len(auth) > 64:
            raise ApiError(400, "The push subscription keys are not valid.")
        cursor.execute(
            """
            INSERT INTO employee_push_subscriptions (endpoint, employee_id, p256dh, auth, user_agent)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              employee_id = VALUES(employee_id),
              p256dh = VALUES(p256dh),
              auth = VALUES(auth),
              user_agent = VALUES(user_agent)
            """,
            (endpoint, employee_id, p256dh, auth, str(payload.get("userAgent", ""))[:250]),
        )
        return self.read_company_push(cursor, token)

    def delete_company_push_subscription(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company notifications")
        endpoint = str(payload.get("endpoint", "")).strip()
        if endpoint:
            cursor.execute("DELETE FROM employee_push_subscriptions WHERE endpoint = %s", (endpoint,))
        return self.read_company_push(cursor, token)

    def test_company_push(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company notifications")
        endpoint = str(payload.get("endpoint", "")).strip()
        cursor.execute(
            "SELECT p256dh, auth FROM employee_push_subscriptions WHERE endpoint = %s",
            (endpoint,),
        )
        sub = cursor.fetchone()
        if not sub:
            raise ApiError(404, "This gadget is not subscribed for sound alerts yet.")
        public, private = vapid_keys(cursor)
        message = json.dumps(
            {
                "title": "Test alert",
                "body": "Sound alerts are working on this device.",
                "tag": "test-alert",
                "url": "/employee/company-settings/notifications",
            }
        )
        code, detail = webpush.send_push(
            endpoint, sub["p256dh"], sub["auth"], message, public, private, push_contact(cursor)
        )
        if code in (404, 410):
            cursor.execute("DELETE FROM employee_push_subscriptions WHERE endpoint = %s", (endpoint,))
            raise ApiError(410, "This gadget's subscription expired — turn alerts off and on again.")
        if code is None or code >= 400:
            raise ApiError(502, f"The push service could not be reached ({detail or 'network error'}).")
        return {"test": {"connected": True, "reason": "The push service accepted the test alert."}}

    def public_package_clients(self, cursor):
        cursor.execute(
            """
            SELECT c.id, c.first_name, c.last_name, COUNT(d.id) AS router_count
            FROM isp_clients c
            LEFT JOIN isp_mikrotik_devices d ON d.client_id = c.id
            WHERE c.status = 'approved'
            GROUP BY c.id, c.first_name, c.last_name
            ORDER BY c.first_name, c.last_name
            """
        )
        clients = []
        for row in cursor.fetchall():
            clients.append(
                {
                    "id": row["id"],
                    "name": f"{row['first_name']} {row['last_name']}".strip(),
                    "routerCount": int(row["router_count"]),
                }
            )
        return clients

    def client_router_ids(self, cursor, client_ids):
        chosen = []
        for client_id in client_ids:
            for router in self.public_package_routers(cursor, client_id):
                if router["id"] not in chosen:
                    chosen.append(router["id"])
        return json.dumps(chosen)

    def publish_company_package(self, cursor, row):
        client_ids = load_offer_names(row.get("availability_clients"))
        if int(row.get("applies_to_all") or 0) and not client_ids:
            client_ids = [item["id"] for item in self.public_package_clients(cursor)]
        live = row["status"] in {"active", "suspended"}
        isp_status = "active" if row["status"] == "active" else "suspended"
        cursor.execute(
            "SELECT id, client_id, customized FROM isp_packages WHERE company_package_id = %s",
            (row["id"],),
        )
        linked = {item["client_id"]: item for item in cursor.fetchall()}
        selected = set(client_ids)
        for client_id in client_ids:
            routers = json.dumps([item["id"] for item in self.public_package_routers(cursor, client_id)])
            current = linked.get(client_id)
            if not live:
                if current and not int(current["customized"]):
                    cursor.execute("DELETE FROM isp_packages WHERE id = %s", (current["id"],))
                continue
            if current:
                if int(current["customized"]):
                    continue
                cursor.execute(
                    "SELECT id FROM isp_packages WHERE client_id = %s AND name = %s AND id <> %s",
                    (client_id, row["name"], current["id"]),
                )
                if cursor.fetchone():
                    continue
                cursor.execute(
                    """
                    UPDATE isp_packages
                    SET name = %s, service_type = %s, price = %s, billing_model = %s,
                        download_mbps = %s, upload_mbps = %s, validity_amount = %s, validity_unit = %s,
                        data_allowance_amount = %s, data_allowance_unit = %s, data_allowance_action = %s,
                        data_throttle_download = %s, data_throttle_upload = %s,
                        data_reset_amount = %s, data_reset_unit = %s,
                        fair_use_amount = %s, fair_use_unit = %s, fair_use_policy = %s, fair_use_action = %s,
                        fair_throttle_download = %s, fair_throttle_upload = %s,
                        fair_reset_amount = %s, fair_reset_unit = %s,
                        simultaneous_devices = %s, extra_device_price = %s, extra_period_price = %s,
                        grace_amount = %s, grace_unit = %s,
                        status = %s, availability_routers = %s, image_data_url = %s
                    WHERE id = %s
                    """,
                    (
                        row["name"],
                        row.get("service_type") or "pppoe",
                        row["price"],
                        row.get("billing_model") or "recurring",
                        row["download_mbps"],
                        row["upload_mbps"],
                        int(row.get("validity_amount") or 1),
                        row.get("validity_unit") or "months",
                        row.get("data_allowance_amount"),
                        row.get("data_allowance_unit"),
                        row.get("data_allowance_action"),
                        row.get("data_throttle_download"),
                        row.get("data_throttle_upload"),
                        row.get("data_reset_amount"),
                        row.get("data_reset_unit"),
                        row.get("fair_use_amount"),
                        row.get("fair_use_unit"),
                        row.get("fair_use_policy") or None,
                        row.get("fair_use_action"),
                        row.get("fair_throttle_download"),
                        row.get("fair_throttle_upload"),
                        row.get("fair_reset_amount"),
                        row.get("fair_reset_unit"),
                        int(row["simultaneous_devices"]) if row.get("simultaneous_devices") is not None else 1,
                        row.get("extra_device_price"),
                        row.get("extra_period_price"),
                        row.get("grace_amount"),
                        row.get("grace_unit"),
                        isp_status,
                        routers,
                        row.get("image_data_url") or None,
                        current["id"],
                    ),
                )
                cursor.execute(
                    "UPDATE pppoe_subscriptions SET price = %s WHERE package_id = %s",
                    (row["price"], current["id"]),
                )
                continue
            cursor.execute(
                "SELECT id FROM isp_packages WHERE client_id = %s AND name = %s",
                (client_id, row["name"]),
            )
            if cursor.fetchone():
                continue
            cursor.execute(
                """
                INSERT INTO isp_packages (
                  id, client_id, name, service_type, price, billing_model, download_mbps, upload_mbps,
                  validity_amount, validity_unit,
                  data_allowance_amount, data_allowance_unit, data_allowance_action,
                  data_throttle_download, data_throttle_upload, data_reset_amount, data_reset_unit,
                  fair_use_amount, fair_use_unit, fair_use_policy, fair_use_action,
                  fair_throttle_download, fair_throttle_upload, fair_reset_amount, fair_reset_unit,
                  simultaneous_devices, extra_device_price, extra_period_price, grace_amount, grace_unit,
                  status, availability_routers, company_package_id, customized, image_data_url
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s,
                  %s, %s, %s,
                  %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s, %s, %s, %s,
                  %s, %s, %s, %s, %s,
                  %s, %s, %s, 0, %s
                )
                """,
                (
                    str(uuid.uuid4()),
                    client_id,
                    row["name"],
                    row.get("service_type") or "pppoe",
                    row["price"],
                    row.get("billing_model") or "recurring",
                    row["download_mbps"],
                    row["upload_mbps"],
                    int(row.get("validity_amount") or 1),
                    row.get("validity_unit") or "months",
                    row.get("data_allowance_amount"),
                    row.get("data_allowance_unit"),
                    row.get("data_allowance_action"),
                    row.get("data_throttle_download"),
                    row.get("data_throttle_upload"),
                    row.get("data_reset_amount"),
                    row.get("data_reset_unit"),
                    row.get("fair_use_amount"),
                    row.get("fair_use_unit"),
                    row.get("fair_use_policy") or None,
                    row.get("fair_use_action"),
                    row.get("fair_throttle_download"),
                    row.get("fair_throttle_upload"),
                    row.get("fair_reset_amount"),
                    row.get("fair_reset_unit"),
                    int(row["simultaneous_devices"]) if row.get("simultaneous_devices") is not None else 1,
                    row.get("extra_device_price"),
                    row.get("extra_period_price"),
                    row.get("grace_amount"),
                    row.get("grace_unit"),
                    isp_status,
                    routers,
                    row["id"],
                    row.get("image_data_url") or None,
                ),
            )
        for client_id, current in linked.items():
            if client_id not in selected and not int(current["customized"]):
                cursor.execute("DELETE FROM isp_packages WHERE id = %s", (current["id"],))

    def copy_default_packages_to_client(self, cursor, client_id):
        cursor.execute(
            """
            SELECT id, availability_clients
            FROM company_packages
            WHERE applies_to_all = 1 AND status IN ('active', 'suspended')
            """
        )
        for item in cursor.fetchall():
            clients = load_offer_names(item["availability_clients"])
            if client_id not in clients:
                clients.append(client_id)
                cursor.execute(
                    "UPDATE company_packages SET availability_clients = %s WHERE id = %s",
                    (json.dumps(clients), item["id"]),
                )
            self.publish_company_package(cursor, self.company_package_row(cursor, item["id"]))

    def release_company_package(self, cursor, package_id):
        cursor.execute(
            "DELETE FROM isp_packages WHERE company_package_id = %s AND customized = 0",
            (package_id,),
        )
        cursor.execute(
            "UPDATE isp_packages SET company_package_id = NULL WHERE company_package_id = %s",
            (package_id,),
        )

    def company_package_row(self, cursor, package_id):
        cursor.execute(
            f"""
            SELECT {COMPANY_PACKAGE_COLUMNS}
            FROM company_packages
            WHERE id = %s
            """,
            (package_id,),
        )
        row = cursor.fetchone()
        if not row:
            raise ApiError(404, "That company package was not found.")
        return row

    def list_company_packages(self, cursor, token):
        self.require_company_employee(cursor, token)
        cursor.execute(
            f"""
            SELECT {COMPANY_PACKAGE_COLUMNS}
            FROM company_packages
            ORDER BY name
            """
        )
        return [public_company_package(row) for row in cursor.fetchall()]

    def create_company_package(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company packages", write=True)
        allowed_clients = {item["id"] for item in self.public_package_clients(cursor)}
        fields = clean_company_package(payload, allowed_clients)
        if fields["status"] == "suspended":
            raise ApiError(400, "Choose draft, active, or archived.")
        cursor.execute("SELECT id FROM company_packages WHERE name = %s", (fields["name"],))
        if cursor.fetchone():
            raise ApiError(409, "A company package with that name is already registered.")
        package_id = str(uuid.uuid4())
        cursor.execute(
            """
            INSERT INTO company_packages (
              id, name, service_type, price, billing_model, download_mbps, upload_mbps,
              validity_amount, validity_unit, data_allowance_amount, data_allowance_unit,
              fair_use_amount, fair_use_unit, fair_use_policy, fair_use_action,
              fair_throttle_download, fair_throttle_upload, data_allowance_action,
              data_throttle_download, data_throttle_upload,
              data_reset_amount, data_reset_unit, fair_reset_amount, fair_reset_unit,
              simultaneous_devices, extra_device_price, extra_period_price,
              grace_amount, grace_unit, status, availability_routers, availability_locations,
              availability_service_areas, availability_clients, applies_to_all, image_data_url
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s,
              %s, %s, %s, %s,
              %s, %s, %s, %s,
              %s, %s, %s,
              %s, %s, %s, %s, %s, %s,
              %s, %s, %s,
              %s, %s, %s, %s, %s,
              %s, %s, %s, %s
            )
            """,
            (
                package_id,
                fields["name"],
                fields["service_type"],
                fields["price"],
                fields["billing_model"],
                fields["download"],
                fields["upload"],
                fields["validity_amount"],
                fields["validity_unit"],
                fields["data_amount"],
                fields["data_unit"],
                fields["fair_amount"],
                fields["fair_unit"],
                fields["fair_policy"] or None,
                fields["fair_action"],
                fields["fair_down"],
                fields["fair_up"],
                fields["data_action"],
                fields["data_down"],
                fields["data_up"],
                fields["data_reset_amount"],
                fields["data_reset_unit"],
                fields["fair_reset_amount"],
                fields["fair_reset_unit"],
                fields["devices"],
                fields["extra_device"],
                fields["extra_period"],
                fields["grace_amount"],
                fields["grace_unit"],
                fields["status"],
                self.client_router_ids(cursor, fields["clients"]),
                fields["locations"],
                fields["service_areas"],
                json.dumps(fields["clients"]),
                fields["applies_to_all"],
                fields["image"],
            ),
        )
        self.publish_company_package(cursor, self.company_package_row(cursor, package_id))
        return public_company_package(self.company_package_row(cursor, package_id))

    def change_company_package(self, cursor, package_path, payload, token):
        self.require_company_employee(cursor, token, "company packages", write=True)
        package_id, _, action = package_path.partition("/")
        row = self.company_package_row(cursor, package_id)
        if action == "edit":
            fields = clean_company_package(payload, {item["id"] for item in self.public_package_clients(cursor)})
            if fields["status"] == "suspended" and row["status"] != "suspended":
                raise ApiError(400, "Choose draft, active, or archived.")
            cursor.execute(
                "SELECT id FROM company_packages WHERE name = %s AND id <> %s",
                (fields["name"], package_id),
            )
            if cursor.fetchone():
                raise ApiError(409, "A company package with that name is already registered.")
            cursor.execute(
                """
                UPDATE company_packages
                SET name = %s, service_type = %s, price = %s, billing_model = %s,
                    download_mbps = %s, upload_mbps = %s, validity_amount = %s, validity_unit = %s,
                    data_allowance_amount = %s, data_allowance_unit = %s,
                    fair_use_amount = %s, fair_use_unit = %s, fair_use_policy = %s,
                    fair_use_action = %s, fair_throttle_download = %s, fair_throttle_upload = %s,
                    data_allowance_action = %s, data_throttle_download = %s, data_throttle_upload = %s,
                    data_reset_amount = %s, data_reset_unit = %s, fair_reset_amount = %s, fair_reset_unit = %s,
                    simultaneous_devices = %s, extra_device_price = %s, extra_period_price = %s,
                    grace_amount = %s, grace_unit = %s, status = %s,
                    availability_routers = %s, availability_locations = %s, availability_service_areas = %s,
                    availability_clients = %s, applies_to_all = %s, image_data_url = %s
                WHERE id = %s
                """,
                (
                    fields["name"],
                    fields["service_type"],
                    fields["price"],
                    fields["billing_model"],
                    fields["download"],
                    fields["upload"],
                    fields["validity_amount"],
                    fields["validity_unit"],
                    fields["data_amount"],
                    fields["data_unit"],
                    fields["fair_amount"],
                    fields["fair_unit"],
                    fields["fair_policy"] or None,
                    fields["fair_action"],
                    fields["fair_down"],
                    fields["fair_up"],
                    fields["data_action"],
                    fields["data_down"],
                    fields["data_up"],
                    fields["data_reset_amount"],
                    fields["data_reset_unit"],
                    fields["fair_reset_amount"],
                    fields["fair_reset_unit"],
                    fields["devices"],
                    fields["extra_device"],
                    fields["extra_period"],
                    fields["grace_amount"],
                    fields["grace_unit"],
                    fields["status"],
                    self.client_router_ids(cursor, fields["clients"]),
                    fields["locations"],
                    fields["service_areas"],
                    json.dumps(fields["clients"]),
                    fields["applies_to_all"],
                    fields["image"],
                    package_id,
                ),
            )
            self.publish_company_package(cursor, self.company_package_row(cursor, package_id))
            return {"package": public_company_package(self.company_package_row(cursor, package_id))}, None
        if action == "suspend":
            if row["status"] == "suspended":
                raise ApiError(400, "That company package is already suspended.")
            cursor.execute("UPDATE company_packages SET status = 'suspended' WHERE id = %s", (package_id,))
            self.publish_company_package(cursor, self.company_package_row(cursor, package_id))
            return {"package": public_company_package(self.company_package_row(cursor, package_id))}, None
        if action == "unsuspend":
            if row["status"] == "active":
                raise ApiError(400, "That company package is already active.")
            cursor.execute("UPDATE company_packages SET status = 'active' WHERE id = %s", (package_id,))
            self.publish_company_package(cursor, self.company_package_row(cursor, package_id))
            return {"package": public_company_package(self.company_package_row(cursor, package_id))}, None
        if action == "delete":
            self.release_company_package(cursor, package_id)
            cursor.execute("DELETE FROM company_packages WHERE id = %s", (package_id,))
            return {"ok": True}, None
        raise ApiError(404, "That account request was not found.")

    def cookies(self):
        jar = {}
        for part in self.headers.get("Cookie", "").split(";"):
            if "=" in part:
                name, value = part.split("=", 1)
                jar[name.strip()] = value.strip()
        return jar

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            raise ApiError(400, "The account request could not be read.") from None
        if length > MAX_BODY:
            raise ApiError(413, "That request is too large.")
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ApiError(400, "The account request could not be read.") from error

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "no-referrer")

    def secure_transport(self):
        # Cookies are only marked Secure when the request really arrived over
        # HTTPS through the local reverse proxy — never from a spoofable header
        # on a direct connection.
        if self.client_address[0] not in TRUSTED_PROXIES:
            return False
        return (self.headers.get("X-Forwarded-Proto") or "").strip().lower() == "https"

    def learned_public_base(self):
        """The https origin this request arrived on through the trusted
        proxy — the public domain the dashboard was reached through, or ''.
        Only the Host header is trusted (nginx sets it from the connection);
        X-Forwarded-Host would pass client-supplied values straight through."""
        if not self.secure_transport():
            return ""
        host = (self.headers.get("Host") or "").strip().lower().rstrip(".")
        if (
            not host
            or len(host) > 253
            or ":" in host
            or all(part.isdigit() for part in host.split("."))
            or not PUBLIC_HOSTNAME.fullmatch(host)
        ):
            return ""
        return f"https://{host}"

    def send_json(self, status, body, cookie=None):
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        if cookie:
            name, value, max_age = cookie
            secure = "; Secure" if self.secure_transport() else ""
            self.send_header(
                "Set-Cookie",
                f"{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}",
            )
        self.end_headers()
        self.wfile.write(encoded)

    def send_html(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path):
        root = web_root()
        if root is None:
            self.send_json(404, {"error": "The web app is not built on this server."})
            return 404
        try:
            candidate = (root / unquote(path).lstrip("/")).resolve()
        except (OSError, ValueError):
            self.send_json(400, {"error": "That page could not be read."})
            return 400
        if candidate != root and root not in candidate.parents:
            self.send_json(404, {"error": "That page was not found."})
            return 404
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file():
            if Path(path).suffix:
                self.send_json(404, {"error": "That page was not found."})
                return 404
            candidate = root / "index.html"
            if not candidate.is_file():
                self.send_json(404, {"error": "The web app is not built on this server."})
                return 404
        body = cached_static(candidate)
        if body is None:
            self.send_json(404, {"error": "That page was not found."})
            return 404
        content_type = STATIC_TYPES.get(candidate.suffix.lower()) or mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/"):
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if candidate.parent.name == "assets":
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)
        return 200


STATIC_CACHE = {}
STATIC_CACHE_LOCK = threading.Lock()
STATIC_CACHE_BYTES = 12 * 1024 * 1024


def cached_static(candidate):
    """Serve built assets from memory; the cache is keyed on mtime+size so a
    fresh frontend build always wins and dev edits are picked up at once."""
    try:
        stat = candidate.stat()
    except OSError:
        return None
    key = str(candidate)
    with STATIC_CACHE_LOCK:
        entry = STATIC_CACHE.get(key)
        if entry and entry[0] == stat.st_mtime_ns and entry[1] == stat.st_size:
            return entry[2]
    try:
        body = candidate.read_bytes()
    except OSError:
        return None
    if len(body) <= STATIC_CACHE_BYTES // 4:
        with STATIC_CACHE_LOCK:
            STATIC_CACHE[key] = (stat.st_mtime_ns, stat.st_size, body)
            total = sum(item[1] for item in STATIC_CACHE.values())
            while total > STATIC_CACHE_BYTES and len(STATIC_CACHE) > 1:
                victim = next((name for name in STATIC_CACHE if name != key), None)
                if victim is None:
                    break
                total -= STATIC_CACHE.pop(victim)[1]
    return body


def publish_tunnel_peers_later():
    try:
        with connect() as db:
            with db.cursor() as cursor:
                publish_tunnel_peers(cursor)
    except pymysql.MySQLError as error:
        print(f"event=wireguard error={error}", flush=True)


def pppoe_sweep_loop():
    interval = max(60, int(os.environ.get("ISP_PPPOE_SWEEP_SECONDS", "300")))
    while True:
        time.sleep(interval)
        try:
            pppoe_store.reconcile_all(connect)
        except Exception as error:
            print(f"event=pppoe-sweep error={error}", flush=True)


def reconcile_loop():
    interval = max(15, int(os.environ.get("ISP_RECONCILE_SECONDS", "60")))
    while True:
        time.sleep(interval)
        try:
            reconcile_all(connect)
        except Exception as error:
            print(f"event=reconcile error={error}", flush=True)


def radius_sweep_loop():
    """Retire radacct rows whose NAS stopped accounting — a powered-off router
    never sends Stop, and without a sweep stale rows pin subscribers 'surfing'."""
    interval = max(15, int(os.environ.get("ISP_RADIUS_SWEEP_SECONDS", "60")))
    while True:
        time.sleep(interval)
        try:
            radius_server.sweep_stale_sessions(connect)
        except Exception as error:
            print(f"event=radius-sweep error={error}", flush=True)


def gateway_sweep_loop():
    """Resolve pooled STK payments whose phones stopped polling — verify with
    Daraja, credit the confirmed ones, expire the abandoned ones."""
    interval = max(30, int(os.environ.get("ISP_GATEWAY_SWEEP_SECONDS", "60")))
    while True:
        time.sleep(interval)
        try:
            gateway_callbacks.sweep(connect)
        except Exception as error:
            print(f"event=gateway-sweep error={error}", flush=True)


def gateway_settlement_loop():
    """Turn confirmed pooled collections into queued settlement payouts —
    one run per minute, one instance at a time via a MySQL GET_LOCK."""
    interval = max(15, int(os.environ.get("ISP_GATEWAY_SETTLE_SECONDS", "60")))
    while True:
        time.sleep(interval)
        try:
            gateway_settle.settlement_tick(
                connect, client_factory=gateway_settle.company_client
            )
        except Exception as error:
            print(f"event=gateway-settle error={error}", flush=True)


_BOOT_STAMP = datetime.now().isoformat(sep=" ", timespec="seconds")


def dispatch_company_pushes():
    """Diff the company feed against sent items and push fresh ones to every
    subscribed gadget. The first run seeds older rows silently — only events
    newer than this process are pushed, so a restart never spams old news."""
    with connect() as db:
        with db.cursor() as cursor:
            items = company_notification_items(cursor)
            if not items:
                return
            cursor.execute("SELECT COUNT(*) AS seen FROM company_push_dispatches")
            seeded = bool((cursor.fetchone() or {}).get("seen"))
            fresh = []
            for item in reversed(items):
                cursor.execute(
                    "INSERT IGNORE INTO company_push_dispatches (item_id) VALUES (%s)",
                    (item["id"],),
                )
                if cursor.rowcount == 1 and (seeded or (item["at"] or "") >= _BOOT_STAMP):
                    fresh.append(item)
            if not fresh:
                return
            cursor.execute("SELECT endpoint, p256dh, auth FROM employee_push_subscriptions")
            subscriptions = list(cursor.fetchall())
            if not subscriptions:
                return
            public, private = vapid_keys(cursor)
            subject = push_contact(cursor)
            for item in fresh[-3:]:
                message = json.dumps(
                    {
                        "title": item["subject"],
                        "body": item.get("detail") or "",
                        "tag": item["id"],
                        "url": "/employee/company-settings/notifications",
                    }
                )
                for sub in subscriptions:
                    try:
                        code, detail = webpush.send_push(
                            sub["endpoint"], sub["p256dh"], sub["auth"],
                            message, public, private, subject,
                        )
                    except Exception as error:
                        print(f"event=push item={item['id']} error={error}", flush=True)
                        continue
                    if code in (404, 410):
                        cursor.execute(
                            "DELETE FROM employee_push_subscriptions WHERE endpoint = %s",
                            (sub["endpoint"],),
                        )
                    elif code is None or code >= 400:
                        print(f"event=push item={item['id']} status={code} detail={detail}", flush=True)


_push_wake = threading.Event()


def notify_push_now():
    """Wake the push dispatcher immediately — called by producers right after
    writing a notification-worthy row so alerts go out on trigger, not on the
    next sweep."""
    _push_wake.set()


def push_dispatch_loop():
    """Event-driven dispatcher: producers set _push_wake for instant delivery;
    the interval is only a safety net for writers that don't signal."""
    interval = max(15, int(os.environ.get("ISP_PUSH_DISPATCH_SECONDS", "30")))
    while True:
        _push_wake.wait(interval)
        _push_wake.clear()
        try:
            dispatch_company_pushes()
        except Exception as error:
            print(f"event=push-dispatch error={error}", flush=True)


def reconcile_all(connect):
    with connect() as db:
        with db.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, client_id, name, tunnel_ip, api_secret, pppoe_interface, port_plan,
                       pppoe_enforced, hotspot_enabled, hotspot_block_sharing
                FROM isp_mikrotik_devices
                WHERE status = 'active' AND api_secret IS NOT NULL AND tunnel_ip IS NOT NULL
                """
            )
            devices = list(cursor.fetchall())
    for device in devices:
        reconcile_device(connect, device)


def _mark_tunnel(connect, device, status):
    with connect() as db:
        with db.cursor() as cursor:
            if status == "up":
                cursor.execute(
                    "UPDATE isp_mikrotik_devices SET tunnel_status = 'up', last_seen_at = CURRENT_TIMESTAMP WHERE id = %s AND client_id = %s AND tunnel_status <> 'up'",
                    (device["id"], device["client_id"]),
                )
                if cursor.rowcount:
                    cursor.execute(
                        "UPDATE isp_mikrotik_health_events SET ended_at = CURRENT_TIMESTAMP WHERE client_id = %s AND device_id = %s AND subject = 'Management tunnel' AND ended_at IS NULL",
                        (device["client_id"], device["id"]),
                    )
            else:
                cursor.execute(
                    "UPDATE isp_mikrotik_devices SET tunnel_status = 'down' WHERE id = %s AND client_id = %s AND tunnel_status <> 'down'",
                    (device["id"], device["client_id"]),
                )
                if cursor.rowcount:
                    cursor.execute(
                        """
                        INSERT INTO isp_mikrotik_health_events (id, client_id, device_id, subject, reason, started_at)
                        VALUES (%s, %s, %s, 'Management tunnel', 'The management tunnel did not answer.', CURRENT_TIMESTAMP)
                        """,
                        (str(uuid.uuid4()), device["client_id"], device["id"]),
                    )
                    notify_push_now()


_PROBE_FAILURES = {}


def reconcile_device(connect, device):
    """Re-assert enabled features after a deploy, reboot, or tunnel outage.

    Reads the router first and only pushes what is missing, so a healthy
    router is never touched and live PPP sessions are not kicked needlessly.
    tunnel_status only flips to 'down' after two consecutive failed loops —
    one congested interval must not reap radacct rows or mark clients offline.
    """
    try:
        password = routeros_api.open_password(device["api_secret"])
    except routeros_api.RouterError:
        return
    state = None
    for _ in range(2):
        try:
            state = routeros_api.inspect_access(
                device["tunnel_ip"],
                password,
                radius_address=os.environ.get("ISP_RADIUS_HOST", "10.88.0.1"),
            )
            break
        except routeros_api.RouterError as error:
            if str(error) != "The management tunnel did not answer.":
                # The router answered but rejected us — a credential or RouterOS
                # problem, not a dead tunnel. Leave tunnel_status alone.
                print(f"event=reconcile device={device['name']} api-error={error}", flush=True)
                return
    if state is None:
        _PROBE_FAILURES[device["id"]] = _PROBE_FAILURES.get(device["id"], 0) + 1
        if _PROBE_FAILURES[device["id"]] >= 2:
            _mark_tunnel(connect, device, "down")
        return
    _PROBE_FAILURES.pop(device["id"], None)
    _mark_tunnel(connect, device, "up")
    if state.get("read_failed"):
        # /login answered but a /print did not — the "missing" features cannot
        # be trusted, and re-applying enforcement would flush every live PPP
        # session. Leave the state for the next loop instead.
        return
    changes = []
    if device.get("pppoe_enforced") and not state["pppoe"]:
        try:
            secret = ""
            with connect() as db:
                with db.cursor() as cursor:
                    pppoe_store.sync_router_access(cursor, device["client_id"], device["id"])
                    cursor.execute(
                        "SELECT id, name, tunnel_ip FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
                        (device["id"], device["client_id"]),
                    )
                    pppoe_store.ensure_nas(cursor, cursor.fetchone())
                    cursor.execute("SELECT secret_sealed FROM isp_radius_nas WHERE router_id = %s", (device["id"],))
                    nas = cursor.fetchone()
            if nas and nas.get("secret_sealed"):
                secret = routeros_api.open_password(nas["secret_sealed"])
            plan = {}
            try:
                loaded = json.loads(device.get("port_plan") or "")
                if isinstance(loaded, dict):
                    plan = loaded
            except (TypeError, json.JSONDecodeError):
                pass
            access = (device.get("pppoe_interface") or "") or next(
                (name for name, uses in plan.items() if isinstance(uses, list) and "pppoe" in uses),
                "",
            )
            routeros_api.apply_pppoe_enforcement(
                device["tunnel_ip"],
                password,
                True,
                radius={
                    "address": os.environ.get("ISP_RADIUS_HOST", "10.88.0.1"),
                    "secret": secret,
                    "source": device["tunnel_ip"],
                },
                access=access or None,
                heal=True,
            )
            changes.append("pppoe(" + ",".join(state.get("pppoe_missing") or []) + ")")
        except routeros_api.RouterError as error:
            print(f"event=reconcile device={device['name']} change=pppoe error={error}", flush=True)
    block = bool(device.get("hotspot_block_sharing"))
    if device.get("hotspot_enabled") and not state["hotspot"]:
        try:
            routeros_api.apply_hotspot_access(device["tunnel_ip"], password, True, block_sharing=block)
            changes.append("hotspot")
        except routeros_api.RouterError as error:
            print(f"event=reconcile device={device['name']} change=hotspot error={error}", flush=True)
    elif (
        device.get("hotspot_enabled")
        and state.get("sharing_blocked") is not None
        and state["sharing_blocked"] != block
    ):
        try:
            routeros_api.apply_hotspot_sharing(device["tunnel_ip"], password, block)
            changes.append("sharing")
        except routeros_api.RouterError as error:
            print(f"event=reconcile device={device['name']} change=sharing error={error}", flush=True)
    if changes:
        print(f"event=reconcile device={device['name']} applied={'+'.join(changes)}", flush=True)


def main():
    if os.environ.get("ISP_ENV") == "production" and not (
        os.environ.get("ISP_ROUTER_SECRET") or os.environ.get("ISP_ACCOUNT_CODE_SECRET")
    ):
        print(
            "WARNING: no sealing secret is set — router and payment credentials are "
            "sealed with the built-in fallback key. Set ISP_ROUTER_SECRET in .env.",
            flush=True,
        )
    ensure_schema()
    try:
        resealed = gateway_store.reseal_stored_secrets(connect)
        if resealed:
            print(f"event=gateway-reseal updated={resealed}", flush=True)
    except Exception as error:
        # Non-fatal — readers open both formats; the next start retries.
        print(f"event=gateway-reseal error={type(error).__name__} {error}", flush=True)
    import threading
    import wg_host

    wg_host.ensure_server()
    gateway_notify.on_send(notify_push_now)
    threading.Thread(target=publish_tunnel_peers_later, daemon=True).start()
    threading.Thread(target=pppoe_sweep_loop, daemon=True, name="pppoe-sweep").start()
    threading.Thread(target=reconcile_loop, daemon=True, name="reconcile").start()
    threading.Thread(target=radius_sweep_loop, daemon=True, name="radius-sweep").start()
    threading.Thread(target=gateway_sweep_loop, daemon=True, name="gateway-sweep").start()
    threading.Thread(target=gateway_settlement_loop, daemon=True, name="gateway-settle").start()
    threading.Thread(target=push_dispatch_loop, daemon=True, name="push-dispatch").start()
    router_jobs.start_worker(connect)
    radius_server.start(connect)
    try:
        portal_server.start(connect)
    except OSError as error:
        portal_server.STATUS["portal"] = "bind-failed"
        print(f"event=portal port={portal_server.PORTAL_PORT} status=bind-failed error={error}", flush=True)
    try:
        server = ApiServer((HOST, PORT), Handler)
    except OSError as error:
        print(f"event=api port={PORT} status=bind-failed error={error}", flush=True)
        raise SystemExit(1)
    print(f"ISP account API listening on http://{HOST}:{PORT}", flush=True)
    if web_root():
        print(f"event=web root={web_root()} status=serving", flush=True)
    else:
        print("event=web status=not-built", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
