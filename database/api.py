import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import socket
import time
import uuid
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import envfile

envfile.load()

import pppoe_service
import pppoe_store
import portal_server
import radius_server
import router_jobs
import routeros_api

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


def clean_communication(payload, existing):
    channel = str(payload.get("channel", "")).strip()
    if channel not in {"sms", "whatsapp", "email"}:
        raise ApiError(400, "Choose the SMS, WhatsApp, or email API.")
    previous = existing or {}
    secret_label = {
        "sms": "Enter the SMS API key.",
        "whatsapp": "Enter the WhatsApp access token.",
        "email": "Enter the email API key.",
    }[channel]
    return {
        "channel": channel,
        "endpoint": clean_endpoint(payload.get("endpoint")),
        "sender": clean_communication_sender(channel, payload.get("sender")),
        "api_key": keep_or_clean(payload.get("apiKey"), previous.get("api_key"), secret_label, 8, 255),
    }


def public_communication(row):
    if not row:
        return None
    return {
        "endpoint": row["endpoint"],
        "sender": row["sender"],
        "apiKey": masked_secret(row["api_key"]),
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
        "consumerKey": masked_secret(row["consumer_key"]),
        "consumerSecret": masked_secret(row["consumer_secret"]),
        "passkey": masked_secret(row["passkey"]),
        "callbackUrl": row.get("callback_url") or "",
        "confirmationUrl": row.get("confirmation_url") or "",
        "validationUrl": row.get("validation_url") or "",
        "initiatorName": row.get("initiator_name") or "",
        "securityCredential": masked_secret(row.get("security_credential") or ""),
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


def connect():
    password = os.environ.get("ISP_DB_PASSWORD", "")
    try:
        return open_db(password)
    except pymysql.err.OperationalError as error:
        if password and error.args and error.args[0] == 1045:
            print("ISP_DB_PASSWORD was rejected. Using an empty database password.", flush=True)
            return open_db("")
        raise


def ensure_database():
    """Create the database and its base account tables on a fresh server."""
    import seed

    password = os.environ.get("ISP_DB_PASSWORD", "")
    try:
        server = open_db(password, database=None)
    except pymysql.err.OperationalError as error:
        if password and error.args and error.args[0] == 1045:
            server = open_db("", database=None)
        else:
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
                  UNIQUE KEY uq_wan_uplink (device_id, interface_name)
                )
                """
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
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
            ):
                cursor.execute("SHOW COLUMNS FROM hotspot_purchases LIKE %s", (column,))
                if cursor.fetchone() is None:
                    cursor.execute(f"ALTER TABLE hotspot_purchases ADD COLUMN {definition}")
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS isp_communication_settings (
                  client_id CHAR(36) NOT NULL,
                  channel ENUM('sms', 'whatsapp', 'email') NOT NULL,
                  endpoint VARCHAR(255) NOT NULL,
                  sender VARCHAR(120) NOT NULL,
                  api_key VARCHAR(255) NOT NULL,
                  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                  PRIMARY KEY (client_id, channel)
                )
                """
            )
            router_jobs.ensure_tables(cursor)
            pppoe_store.ensure_schema(cursor)
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


def assert_unique(cursor, kind, fields):
    table = "isp_clients" if kind == "client" else "isp_employees"
    cursor.execute(f"SELECT username, email, phone, login_code FROM {table}")
    for row in cursor.fetchall():
        if row["username"].lower() == fields["username"].lower():
            raise ApiError(409, "That username is already in use.")
        if row["email"].lower() == fields["email"].lower():
            raise ApiError(409, "That email is already registered.")
        if digits(row["phone"]) == fields["phone_digits"]:
            raise ApiError(409, "That phone number is already registered.")
        if row["login_code"] == fields["login_code"]:
            raise ApiError(409, "That login code is already in use.")

    cursor.execute(f"SELECT username, email, phone, login_code FROM {other_table(kind)}")
    label = other_label(kind)
    for row in cursor.fetchall():
        if row["username"].lower() == fields["username"].lower():
            raise ApiError(409, f"That username is already used by an {label} account.")
        if row["email"].lower() == fields["email"].lower():
            raise ApiError(409, f"That email is already used by an {label} account.")
        if digits(row["phone"]) == fields["phone_digits"]:
            raise ApiError(409, f"That phone number is already used by an {label} account.")
        if row["login_code"] == fields["login_code"]:
            raise ApiError(409, f"That login code is already used by an {label} account.")


def session_account_id(cursor, token, kind):
    if not token:
        return None
    cursor.execute(
        "SELECT account_id FROM isp_sessions WHERE token = %s AND account_kind = %s",
        (token, kind),
    )
    row = cursor.fetchone()
    return row["account_id"] if row else None


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
    if reviewer_access(cursor, employee_id) == "denied":
        raise ApiError(403, "Only a signed-in Director can review accounts.")


class ApiServer(ThreadingHTTPServer):
    """Refuses to share its port: without SO_EXCLUSIVEADDRUSE a second
    api.py instance can bind the same TCP port on Windows and silently
    split the service (one owns HTTP, the other owns RADIUS). On POSIX,
    SO_REUSEADDR is safe — it only permits rebinding over TIME_WAIT
    connections, never a second live listener — so restarts under load
    do not hit EADDRINUSE."""

    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

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
            payload = self.read_json() if method == "POST" else {}
            token = self.cookies()
            query = parse_qs(urlparse(self.path).query)
            with connect() as db:
                with db.cursor() as cursor:
                    body, cookie = self.dispatch(cursor, method, path, payload, token, query)
            status = 200
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
        except pymysql.MySQLError:
            self.send_json(status, {"error": "The account database could not be reached."})
        except Exception:
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
        if method == "GET" and path == "/api/employee/company/communications":
            return self.read_company_communications(cursor, token.get("isp_employee_session")), None
        if method == "POST" and path == "/api/employee/company/communications":
            return self.save_company_communication(cursor, payload, token.get("isp_employee_session")), None
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
        if method == "GET" and path == "/api/payments":
            return self.read_payments(cursor, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/payments":
            return self.save_payments(cursor, payload, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/payments/test":
            return {"test": self.test_payments(cursor, payload, token.get("isp_client_session"))}, None
        if method == "GET" and path == "/api/communications":
            return self.read_communications(cursor, token.get("isp_client_session")), None
        if method == "POST" and path == "/api/communications":
            return self.save_communication(cursor, payload, token.get("isp_client_session")), None
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
        return client_id

    def health(self, cursor):
        cursor.execute("SELECT 1 AS ok")
        cursor.fetchone()
        import wg_host

        radius = {f"udp/{port}": state for port, state in sorted(radius_server.STATUS.items())}
        if not radius:
            radius = {"state": "starting"}
        if wg_host.local_server():
            wireguard = "running" if wg_host.tunnel_running() else "stopped"
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
            SELECT COUNT(DISTINCT device_id) AS unhealthy
            FROM isp_mikrotik_health_events
            WHERE client_id = %s AND ended_at IS NULL
            """,
            (client_id,),
        )
        unhealthy = int(cursor.fetchone()["unhealthy"] or 0)
        cursor.execute(
            """
            SELECT s.service, s.status, sub.expiry_date, d.tunnel_status,
                   (SELECT COUNT(*) FROM radacct a
                    WHERE a.username = s.pppoe_username AND a.acctstoptime IS NULL) AS open_sessions,
                   (SELECT e.action FROM pppoe_events e
                    WHERE e.subscriber_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS last_action
            FROM pppoe_subscribers s
            JOIN pppoe_subscriptions sub ON sub.subscriber_id = s.id
            LEFT JOIN isp_mikrotik_devices d ON d.id = s.router_id
            WHERE s.client_id = %s
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
                    "last_action": item["last_action"] or "",
                    "tunnel_status": item["tunnel_status"] or "unknown",
                }
            )
        cursor.execute(
            """
            SELECT s.service,
                   COALESCE(SUM(a.acctinputoctets), 0) AS bytes_in,
                   COALESCE(SUM(a.acctoutputoctets), 0) AS bytes_out
            FROM pppoe_subscribers s
            LEFT JOIN radacct a ON a.username = s.pppoe_username AND a.acctstarttime >= CURDATE()
            WHERE s.client_id = %s
            GROUP BY s.service
            """,
            (client_id,),
        )
        usage = {
            "pppoe": {"bytesIn": 0, "bytesOut": 0},
            "hotspot": {"bytesIn": 0, "bytesOut": 0},
        }
        for item in cursor.fetchall():
            service = item["service"] if item["service"] in usage else "pppoe"
            usage[service] = {"bytesIn": int(item["bytes_in"] or 0), "bytesOut": int(item["bytes_out"] or 0)}
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
            "clients": pppoe_service.tally_client_analysis(clients, datetime.now().date()),
            "usageToday": usage,
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
            SELECT interface_name, provider, method, gateway, download_mbps, upload_mbps, active
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
                      id, client_id, device_id, interface_name, provider, method, gateway, download_mbps, upload_mbps, active
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
        cursor.execute(
            "UPDATE isp_mikrotik_devices SET hotspot_enabled = %s WHERE id = %s AND client_id = %s",
            (1 if enabled else 0, device_id, client_id),
        )
        device = self.mikrotik_row(cursor, device_id, client_id)
        if payload.get("push") is not True:
            return {"device": device, "applied": False, "message": ""}
        try:
            self.push_hotspot_access(cursor, device_id, client_id, enabled)
        except routeros_api.RouterError as error:
            cursor.execute(
                "UPDATE isp_mikrotik_devices SET hotspot_enabled = %s WHERE id = %s AND client_id = %s",
                (previous, device_id, client_id),
            )
            return {
                "device": self.mikrotik_row(cursor, device_id, client_id),
                "applied": False,
                "message": routeros_api.router_change_message(error),
            }
        return {"device": device, "applied": True, "message": "Updated on the router."}

    def push_hotspot_access(self, cursor, device_id, client_id, enabled):
        cursor.execute(
            "SELECT tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
            (device_id, client_id),
        )
        row = cursor.fetchone()
        if not row or not row.get("api_secret") or not row.get("tunnel_ip"):
            raise routeros_api.RouterError("Router access is not saved yet, so nothing was changed on the router.")
        password = routeros_api.open_password(row["api_secret"])
        routeros_api.apply_hotspot_access(row["tunnel_ip"], password, enabled)

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
        return client_id

    def communication_rows(self, cursor, client_id):
        cursor.execute(
            """
            SELECT channel, endpoint, sender, api_key
            FROM isp_communication_settings
            WHERE client_id = %s
            """,
            (client_id,),
        )
        return {row["channel"]: row for row in cursor.fetchall()}

    def read_communications(self, cursor, token):
        client_id = self.require_communication_client(cursor, token)
        rows = self.communication_rows(cursor, client_id)
        return {
            "sms": public_communication(rows.get("sms")),
            "whatsapp": public_communication(rows.get("whatsapp")),
            "email": public_communication(rows.get("email")),
        }

    def save_communication(self, cursor, payload, token):
        client_id = self.require_communication_client(cursor, token)
        channel = str(payload.get("channel", "")).strip()
        rows = self.communication_rows(cursor, client_id)
        fields = clean_communication(payload, rows.get(channel) if channel in rows else None)
        cursor.execute(
            """
            INSERT INTO isp_communication_settings (client_id, channel, endpoint, sender, api_key)
            VALUES (%s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              endpoint = VALUES(endpoint),
              sender = VALUES(sender),
              api_key = VALUES(api_key)
            """,
            (client_id, fields["channel"], fields["endpoint"], fields["sender"], fields["api_key"]),
        )
        return self.read_communications(cursor, token)

    def require_payment_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing payment settings.")
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
        client_id = self.require_payment_client(cursor, token)
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
                fields["consumer_secret"],
                fields["passkey"],
                fields["callback_url"],
                fields["confirmation_url"],
                fields["validation_url"],
                fields["initiator_name"],
                fields["security_credential"],
            ),
        )
        cursor.execute(
            """
            INSERT INTO isp_payment_preferences (client_id, mode) VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE mode = VALUES(mode)
            """,
            (client_id, mode),
        )
        return self.read_payments(cursor, token)

    def test_payments(self, cursor, payload, token):
        import urllib.request
        import urllib.error
        import base64

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
        secret = field("consumerSecret", "consumer_secret")
        if not key or not secret:
            return {"connected": False, "reason": "Enter the consumer key and secret, or save the Daraja details first."}
        host = "https://api.safaricom.co.ke" if environment == "live" else "https://sandbox.safaricom.co.ke"
        request = urllib.request.Request(
            f"{host}/oauth/v1/generate?grant_type=client_credentials",
            headers={"Authorization": "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()},
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                body = json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as error:
            detail = ""
            try:
                detail = str(json.loads(error.read().decode() or "{}").get("errorMessage") or "").strip()
            except (ValueError, OSError):
                detail = ""
            suffix = f": {detail}" if detail else ""
            if error.code in (400, 401, 403):
                return {"connected": False, "reason": f"Daraja rejected the credentials ({error.code}{suffix}). Check the consumer key, secret, and environment."}
            return {"connected": False, "reason": f"Daraja answered with an error ({error.code}{suffix}). Try again shortly."}
        except (urllib.error.URLError, OSError, ValueError) as error:
            return {"connected": False, "reason": f"Daraja could not be reached: {getattr(error, 'reason', error)}."}
        if body.get("access_token"):
            return {"connected": True, "reason": ""}
        return {"connected": False, "reason": "Daraja answered but returned no access token."}

    def require_package_client(self, cursor, token):
        client_id = session_account_id(cursor, token, "client")
        if not client_id:
            raise ApiError(401, "Sign in to the ISP client account before managing packages.")
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

    def require_company_employee(self, cursor, token, subject="company packages"):
        employee_id = session_account_id(cursor, token, "employee")
        if not employee_id:
            raise ApiError(401, f"Sign in to the employee account before managing {subject}.")
        cursor.execute("SELECT status FROM isp_employees WHERE id = %s", (employee_id,))
        employee = cursor.fetchone()
        if not employee or employee["status"] != "approved":
            raise ApiError(403, f"An approved employee account is required to manage {subject}.")
        return employee_id

    def company_daraja_row(self, cursor):
        cursor.execute(
            """
            SELECT environment, account_type, short_code, consumer_key, consumer_secret, passkey
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
        self.require_company_employee(cursor, token, "company payments")
        return {
            "daraja": public_payment(self.company_daraja_row(cursor)),
            "other": public_other_gateway(self.company_other_gateway_row(cursor)),
        }

    def save_company_payments(self, cursor, payload, token):
        self.require_company_employee(cursor, token, "company payments")
        gateway = str(payload.get("gateway", "")).strip()
        if gateway == "daraja":
            fields = clean_daraja(payload.get("daraja") or {}, self.company_daraja_row(cursor))
            cursor.execute(
                """
                INSERT INTO company_daraja_settings (
                  id, environment, account_type, short_code, consumer_key, consumer_secret, passkey
                ) VALUES (1, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                  environment = VALUES(environment),
                  account_type = VALUES(account_type),
                  short_code = VALUES(short_code),
                  consumer_key = VALUES(consumer_key),
                  consumer_secret = VALUES(consumer_secret),
                  passkey = VALUES(passkey)
                """,
                (
                    fields["environment"],
                    fields["account_type"],
                    fields["short_code"],
                    fields["consumer_key"],
                    fields["consumer_secret"],
                    fields["passkey"],
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
                    fields["secret_key"],
                ),
            )
            return self.read_company_payments(cursor, token)
        raise ApiError(400, "Choose the company Daraja API or the other payment gateway.")

    def company_communication_rows(self, cursor):
        cursor.execute("SELECT channel, endpoint, sender, api_key FROM company_communication_settings")
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
        self.require_company_employee(cursor, token, "company communications")
        channel = str(payload.get("channel", "")).strip()
        rows = self.company_communication_rows(cursor)
        fields = clean_communication(payload, rows.get(channel) if channel in rows else None)
        cursor.execute(
            """
            INSERT INTO company_communication_settings (channel, endpoint, sender, api_key)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
              endpoint = VALUES(endpoint),
              sender = VALUES(sender),
              api_key = VALUES(api_key)
            """,
            (fields["channel"], fields["endpoint"], fields["sender"], fields["api_key"]),
        )
        return self.read_company_communications(cursor, token)

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
        self.require_company_employee(cursor, token)
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
        self.require_company_employee(cursor, token)
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
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_BODY:
            raise ApiError(413, "That request is too large.")
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ApiError(400, "The account request could not be read.") from error

    def send_json(self, status, body, cookie=None):
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            name, value, max_age = cookie
            self.send_header(
                "Set-Cookie",
                f"{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}",
            )
        self.end_headers()
        self.wfile.write(encoded)

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
        try:
            body = candidate.read_bytes()
        except OSError:
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
        self.end_headers()
        self.wfile.write(body)
        return 200


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


def reconcile_all(connect):
    with connect() as db:
        with db.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, client_id, name, tunnel_ip, api_secret, pppoe_interface, port_plan,
                       pppoe_enforced, hotspot_enabled
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
            else:
                cursor.execute(
                    "UPDATE isp_mikrotik_devices SET tunnel_status = 'down' WHERE id = %s AND client_id = %s AND tunnel_status = 'up'",
                    (device["id"], device["client_id"]),
                )


def reconcile_device(connect, device):
    """Re-assert enabled features after a deploy, reboot, or tunnel outage.

    Reads the router first and only pushes what is missing, so a healthy
    router is never touched and live PPP sessions are not kicked needlessly.
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
        _mark_tunnel(connect, device, "down")
        return
    _mark_tunnel(connect, device, "up")
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
            )
            changes.append("pppoe")
        except routeros_api.RouterError as error:
            print(f"event=reconcile device={device['name']} change=pppoe error={error}", flush=True)
    if device.get("hotspot_enabled") and not state["hotspot"]:
        try:
            routeros_api.apply_hotspot_access(device["tunnel_ip"], password, True)
            changes.append("hotspot")
        except routeros_api.RouterError as error:
            print(f"event=reconcile device={device['name']} change=hotspot error={error}", flush=True)
    if changes:
        print(f"event=reconcile device={device['name']} applied={'+'.join(changes)}", flush=True)


def main():
    ensure_schema()
    import threading
    import wg_host

    wg_host.ensure_server()
    threading.Thread(target=publish_tunnel_peers_later, daemon=True).start()
    threading.Thread(target=pppoe_sweep_loop, daemon=True, name="pppoe-sweep").start()
    threading.Thread(target=reconcile_loop, daemon=True, name="reconcile").start()
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
